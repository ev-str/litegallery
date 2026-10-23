package internal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
)

func writeFixture(t *testing.T, root, rel string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mkdirFixture(t *testing.T, root, rel string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(rel)), 0o755); err != nil {
		t.Fatal(err)
	}
}

func symlinkFixture(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
}

func getList(t *testing.T, s *Server, path, recursive string) *httptest.ResponseRecorder {
	t.Helper()
	query := url.Values{"path": {path}}
	if recursive != "" {
		query.Set("recursive", recursive)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/list?"+query.Encode(), nil)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	return response
}

func decodeListing(t *testing.T, response *httptest.ResponseRecorder) listing {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	var result listing
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func entryPaths(entries []Entry) []string {
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		paths = append(paths, entry.Path)
	}
	return paths
}

func recursivePaths(t *testing.T, s *Server, path string) []string {
	t.Helper()
	return entryPaths(decodeListing(t, getList(t, s, path, "1")).Entries)
}

func TestRecursiveOptionKeepsOrdinaryListUnchanged(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/b.jpg")
	writeFixture(t, root, "album/a.mp4")
	writeFixture(t, root, "album/notes.txt")
	writeFixture(t, root, "album/.hidden.jpg")
	writeFixture(t, root, "album/sub/deep.jpg")

	plain := getList(t, s, "album", "")
	explicitOff := getList(t, s, "album", "0")
	if plain.Body.String() != explicitOff.Body.String() {
		t.Fatalf("recursive=0 changed listing:\n%s\n%s", plain.Body.String(), explicitOff.Body.String())
	}
	got := decodeListing(t, plain)
	if got.Path != "album" || got.Title != "test" {
		t.Fatalf("listing header = %q %q", got.Path, got.Title)
	}
	want := []struct{ name, path, kind string }{
		{"sub", "album/sub", "directory"},
		{"a.mp4", "album/a.mp4", "video"},
		{"b.jpg", "album/b.jpg", "image"},
	}
	if len(got.Entries) != len(want) {
		t.Fatalf("entries = %#v", got.Entries)
	}
	for i, entry := range got.Entries {
		if entry.Name != want[i].name || entry.Path != want[i].path || entry.Kind != want[i].kind || entry.ModTime == "" {
			t.Fatalf("entry %d = %#v, want %v", i, entry, want[i])
		}
		if entry.Kind != "directory" && (entry.Size != int64(len("fixture")) || entry.SortTime == 0) {
			t.Fatalf("media entry fields = %#v", entry)
		}
	}
	if response := getList(t, s, "", ""); response.Code != http.StatusOK {
		t.Fatalf("root listing status = %d", response.Code)
	}
}

func TestRecursiveListReturnsMediaFromNestedLevelsWithoutDirectories(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/top.jpg")
	writeFixture(t, root, "album/one/clip.mov")
	writeFixture(t, root, "album/one/two/three/deep.png")
	mkdirFixture(t, root, "album/empty")
	writeFixture(t, root, "elsewhere/outside.jpg")

	got := decodeListing(t, getList(t, s, "album", "1"))
	if got.Path != "album" || got.Title != "test" {
		t.Fatalf("listing header = %q %q", got.Path, got.Title)
	}
	want := []string{"album/top.jpg", "album/one/clip.mov", "album/one/two/three/deep.png"}
	if paths := entryPaths(got.Entries); !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
	for _, entry := range got.Entries {
		if entry.Kind == "directory" {
			t.Fatalf("directory returned: %#v", entry)
		}
		if entry.Name != filepath.Base(entry.Path) || entry.Size != int64(len("fixture")) || entry.ModTime == "" || entry.SortTime == 0 {
			t.Fatalf("entry fields = %#v", entry)
		}
	}
}

func TestRecursiveListKeepsDuplicateNamesDistinct(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/a/IMG_0001.jpg")
	writeFixture(t, root, "album/b/IMG_0001.jpg")

	entries := decodeListing(t, getList(t, s, "album", "1")).Entries
	if len(entries) != 2 || entries[0].Name != entries[1].Name {
		t.Fatalf("entries = %#v", entries)
	}
	if entries[0].Path != "album/a/IMG_0001.jpg" || entries[1].Path != "album/b/IMG_0001.jpg" {
		t.Fatalf("paths = %v", entryPaths(entries))
	}
}

func TestRecursiveListUsesCachedCaptureTime(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/sub/photo.jpg")
	directory := filepath.Join(s.cfg.Root, "album", "sub")
	info, err := os.Stat(filepath.Join(directory, "photo.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	manifest := metadataManifest{Version: metadataManifestVersion, Files: map[string]metadataFileRecord{
		"photo.jpg": {Kind: "image", Size: info.Size(), ModifiedNS: info.ModTime().UnixNano(), Created: 100, Captured: 200},
	}}
	if err := s.writeMetadataManifest(directory, manifest); err != nil {
		t.Fatal(err)
	}
	entries := decodeListing(t, getList(t, s, "album", "1")).Entries
	if len(entries) != 1 || entries[0].SortTime != 200 {
		t.Fatalf("entries = %#v", entries)
	}
}

func TestRecursiveListRejectsLibraryRoot(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/photo.jpg")
	symlinkFixture(t, root, filepath.Join(root, "album", "to-root"))

	for _, path := range []string{"", " ", ".", "./", "album/..", "album/./..", "album/to-root"} {
		response := getList(t, s, path, "1")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("path %q: status = %d, body = %q", path, response.Code, response.Body.String())
		}
		if body := response.Body.String(); body != "recursive listing is not available at the library root\n" {
			t.Fatalf("path %q: body = %q", path, body)
		}
	}
}

func TestRecursiveListRejectsInvalidRecursiveValue(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/photo.jpg")
	for _, value := range []string{"true", "yes", "2", " 1"} {
		response := getList(t, s, "album", value)
		if response.Code != http.StatusBadRequest || response.Body.String() != "invalid recursive value\n" {
			t.Fatalf("recursive=%q: status = %d, body = %q", value, response.Code, response.Body.String())
		}
	}
}

func TestRecursiveListRejectsTraversalAndAbsolutePaths(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/photo.jpg")
	outside := t.TempDir()
	writeFixture(t, outside, "secret.jpg")

	for _, path := range []string{"..", "../", "../x", "album/../..", "album/../../x", "/", "/etc", outside, filepath.Join(root, "album"), "album\x00"} {
		response := getList(t, s, path, "1")
		if response.Code != http.StatusBadRequest || response.Body.String() != "invalid path\n" {
			t.Fatalf("path %q: status = %d, body = %q", path, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), outside) || strings.Contains(response.Body.String(), root) {
			t.Fatalf("path %q leaked server path: %q", path, response.Body.String())
		}
	}
	if response := getList(t, s, "missing", "1"); response.Code != http.StatusBadRequest {
		t.Fatalf("missing folder status = %d", response.Code)
	}
	writeFixture(t, root, "album/file.jpg")
	if response := getList(t, s, "album/file.jpg", "1"); response.Code != http.StatusNotFound || response.Body.String() != "cannot read directory\n" {
		t.Fatalf("file as folder: status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestRecursiveListDoesNotFollowExternalSymlinks(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/inside.jpg")
	outside := t.TempDir()
	writeFixture(t, outside, "secret.jpg")
	writeFixture(t, outside, "nested/secret2.jpg")
	symlinkFixture(t, outside, filepath.Join(root, "album", "external-dir"))
	symlinkFixture(t, filepath.Join(outside, "secret.jpg"), filepath.Join(root, "album", "external.jpg"))
	symlinkFixture(t, outside, filepath.Join(root, "external-root"))

	response := getList(t, s, "album", "1")
	body := response.Body.String()
	got := decodeListing(t, response)
	if paths := entryPaths(got.Entries); !reflect.DeepEqual(paths, []string{"album/inside.jpg"}) {
		t.Fatalf("paths = %v", paths)
	}
	if strings.Contains(body, "secret") || strings.Contains(body, outside) {
		t.Fatalf("external content leaked: %s", body)
	}
	if response := getList(t, s, "external-root", "1"); response.Code != http.StatusBadRequest {
		t.Fatalf("external symlink folder status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestRecursiveListStaysInsideSelectedSubtree(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "album/own.jpg")
	writeFixture(t, root, "sibling/neighbour.jpg")
	writeFixture(t, root, "sibling/deeper/neighbour2.jpg")
	symlinkFixture(t, filepath.Join(root, "sibling"), filepath.Join(root, "album", "to-sibling"))
	symlinkFixture(t, filepath.Join(root, "sibling", "neighbour.jpg"), filepath.Join(root, "album", "linked.jpg"))
	symlinkFixture(t, filepath.Join(root, "album"), filepath.Join(root, "album", "loop"))

	if paths := recursivePaths(t, s, "album"); !reflect.DeepEqual(paths, []string{"album/own.jpg"}) {
		t.Fatalf("paths = %v", paths)
	}
}

func TestRecursiveListThroughSymlinkedFolderUsesResolvedPaths(t *testing.T) {
	s, root := testServer(t)
	writeFixture(t, root, "real/sub/photo.jpg")
	symlinkFixture(t, filepath.Join(root, "real"), filepath.Join(root, "alias"))

	got := decodeListing(t, getList(t, s, "alias", "1"))
	if got.Path != "real" || !reflect.DeepEqual(entryPaths(got.Entries), []string{"real/sub/photo.jpg"}) {
		t.Fatalf("listing = %#v", got)
	}
}

func TestRecursiveListSkipsUnreadableSubtree(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission checks do not apply to root")
	}
	s, root := testServer(t)
	writeFixture(t, root, "album/ok.jpg")
	writeFixture(t, root, "album/blocked/hidden-from-us.jpg")
	writeFixture(t, root, "album/later/also-ok.mp4")
	blocked := filepath.Join(root, "album", "blocked")
	if err := os.Chmod(blocked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o755) })

	response := getList(t, s, "album", "1")
	body := response.Body.String()
	if paths := entryPaths(decodeListing(t, response).Entries); !reflect.DeepEqual(paths, []string{"album/ok.jpg", "album/later/also-ok.mp4"}) {
		t.Fatalf("paths = %v", paths)
	}
	if strings.Contains(body, root) || strings.Contains(body, s.cfg.Root) {
		t.Fatalf("server path leaked: %s", body)
	}

	if err := os.Chmod(filepath.Join(root, "album"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "album"), 0o755) })
	if response := getList(t, s, "album", "1"); response.Code != http.StatusNotFound || response.Body.String() != "cannot read directory\n" {
		t.Fatalf("unreadable requested folder: status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestRecursiveListSkipsCacheDirectory(t *testing.T) {
	root := t.TempDir()
	s, err := New(Config{Root: root, Cache: filepath.Join(root, "album", "cache"), Title: "test", ThumbSize: 320}, fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, root, "album/photo.jpg")
	writeFixture(t, root, "album/cache/ab/thumb.jpg")

	if paths := recursivePaths(t, s, "album"); !reflect.DeepEqual(paths, []string{"album/photo.jpg"}) {
		t.Fatalf("paths = %v", paths)
	}
}

func cacheInsideLibraryServer(t *testing.T, cache func(root string) string) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	s, err := New(Config{Root: root, Cache: cache(root), Title: "test", ThumbSize: 320}, fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, root, "album/photo.jpg")
	writeFixture(t, root, "album/cache/thumb.jpg")
	writeFixture(t, root, "album/cache/ab/thumb2.jpg")
	return s, root
}

func assertEmptyRecursiveCacheListing(t *testing.T, s *Server, root, path string) {
	t.Helper()
	response := getList(t, s, path, "1")
	body := response.Body.String()
	got := decodeListing(t, response)
	if got.Entries == nil || len(got.Entries) != 0 || !strings.Contains(body, `"entries":[]`) {
		t.Fatalf("path %q: listing = %s", path, body)
	}
	for _, leaked := range []string{root, s.cfg.Root, s.cfg.Cache, "thumb"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("path %q: response contains %q: %s", path, leaked, body)
		}
	}
}

func TestRecursiveListReturnsEmptyListingForRequestedCache(t *testing.T) {
	s, root := cacheInsideLibraryServer(t, func(root string) string { return filepath.Join(root, "album", "cache") })
	assertEmptyRecursiveCacheListing(t, s, root, "album/cache")
	assertEmptyRecursiveCacheListing(t, s, root, "album/cache/ab")

	plain := decodeListing(t, getList(t, s, "album/cache", ""))
	if paths := entryPaths(plain.Entries); !reflect.DeepEqual(paths, []string{"album/cache/ab", "album/cache/thumb.jpg"}) {
		t.Fatalf("ordinary listing changed: %v", paths)
	}
}

func TestRecursiveListReturnsEmptyListingForCacheBehindSymlinkedPath(t *testing.T) {
	s, root := cacheInsideLibraryServer(t, func(root string) string { return filepath.Join(root, "album", "cache") })
	symlinkFixture(t, filepath.Join(root, "album", "cache"), filepath.Join(root, "cache-alias"))
	symlinkFixture(t, filepath.Join(root, "album"), filepath.Join(root, "album-alias"))

	assertEmptyRecursiveCacheListing(t, s, root, "cache-alias")
	assertEmptyRecursiveCacheListing(t, s, root, "album-alias/cache")
	if paths := recursivePaths(t, s, "album-alias"); !reflect.DeepEqual(paths, []string{"album/photo.jpg"}) {
		t.Fatalf("paths = %v", paths)
	}
}

func TestRecursiveListExcludesCacheConfiguredThroughSymlink(t *testing.T) {
	outside := t.TempDir()
	s, root := cacheInsideLibraryServer(t, func(root string) string {
		link := filepath.Join(outside, "cache-link")
		symlinkFixture(t, filepath.Join(root, "album", "cache"), link)
		return link
	})

	assertEmptyRecursiveCacheListing(t, s, root, "album/cache")
	if paths := recursivePaths(t, s, "album"); !reflect.DeepEqual(paths, []string{"album/photo.jpg"}) {
		t.Fatalf("paths = %v", paths)
	}
}

func TestRecursiveListIgnoresCacheThatContainsLibrary(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "library")
	writeFixture(t, root, "album/photo.jpg")
	s, err := New(Config{Root: root, Cache: parent, Title: "test", ThumbSize: 320}, fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	if paths := recursivePaths(t, s, "album"); !reflect.DeepEqual(paths, []string{"album/photo.jpg"}) {
		t.Fatalf("paths = %v", paths)
	}
}

func TestRecursiveListOrderIsDeterministic(t *testing.T) {
	s, root := testServer(t)
	for _, rel := range []string{
		"album/img10.jpg", "album/img2.jpg", "album/B.mp4", "album/a.jpg",
		"album/sub10/x.jpg", "album/sub2/z.jpg", "album/sub2/y.jpg", "album/Sub3/w.jpg",
	} {
		writeFixture(t, root, rel)
	}
	want := []string{
		"album/a.jpg", "album/B.mp4", "album/img2.jpg", "album/img10.jpg",
		"album/sub2/y.jpg", "album/sub2/z.jpg", "album/Sub3/w.jpg", "album/sub10/x.jpg",
	}
	for i := 0; i < 3; i++ {
		if paths := recursivePaths(t, s, "album"); !reflect.DeepEqual(paths, want) {
			t.Fatalf("run %d paths = %v, want %v", i, paths, want)
		}
	}
}

func TestRecursiveListUsesSharedMediaRules(t *testing.T) {
	s, root := testServer(t)
	names := []string{"a.JPG", "b.jpeg", "c.Png", "d.gif", "e.bmp", "f.tif", "g.TIFF", "h.mp4", "i.MOV", "j.m4v", "k.avi", "l.mts", "m.m2ts", "n.3gp", "o.heic", "p.txt", "q", "r.jpg.txt", ".s.jpg", "._t.jpg"}
	for _, name := range names {
		writeFixture(t, root, "album/sub/"+name)
	}
	mkdirFixture(t, root, "album/sub/folder.jpg")

	entries := decodeListing(t, getList(t, s, "album", "1")).Entries
	got := make(map[string]string, len(entries))
	for _, entry := range entries {
		got[entry.Name] = entry.Kind
	}
	for _, name := range names {
		want := mediaKind(name)
		if hidden(name) {
			want = ""
		}
		if got[name] != want {
			t.Fatalf("%s: kind = %q, want %q", name, got[name], want)
		}
	}
	if _, ok := got["folder.jpg"]; ok {
		t.Fatal("directory with media extension returned")
	}
}

type cancelAfterContext struct {
	context.Context
	remaining atomic.Int64
	checks    atomic.Int64
}

func (c *cancelAfterContext) Err() error {
	c.checks.Add(1)
	if c.remaining.Add(-1) < 0 {
		return context.Canceled
	}
	return nil
}

func TestRecursiveListStopsWhenContextIsCancelled(t *testing.T) {
	s, root := testServer(t)
	for i := 0; i < 20; i++ {
		writeFixture(t, root, filepath.Join("album", "d"+string(rune('a'+i)), "photo.jpg"))
	}
	resolvedRel, resolvedAbs, err := s.resolve("album")
	if err != nil {
		t.Fatal(err)
	}

	ctx := &cancelAfterContext{Context: context.Background()}
	ctx.remaining.Store(5)
	entries, err := s.listRecursive(ctx, resolvedRel, resolvedAbs)
	if !errors.Is(err, context.Canceled) || entries != nil {
		t.Fatalf("entries = %v, err = %v", entries, err)
	}
	if checks := ctx.checks.Load(); checks != 6 {
		t.Fatalf("walk continued after cancellation: %d context checks", checks)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/list?path=album&recursive=1", nil).WithContext(cancelled)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Body.Len() != 0 || strings.Contains(response.Header().Get("Content-Type"), "json") {
		t.Fatalf("cancelled request produced a listing: %d %q", response.Code, response.Body.String())
	}
}

func TestRecursiveListRejectsSubtreeAboveLimit(t *testing.T) {
	s, root := testServer(t)
	for _, name := range []string{"a.jpg", "b.jpg", "sub/c.jpg"} {
		writeFixture(t, root, filepath.Join("album", name))
	}
	defer func(limit int) { maxRecursiveEntries = limit }(maxRecursiveEntries)

	maxRecursiveEntries = 3
	if response := getList(t, s, "album", "1"); response.Code != http.StatusOK {
		t.Fatalf("at the limit: status = %d, body = %q", response.Code, response.Body.String())
	}
	maxRecursiveEntries = 2
	response := getList(t, s, "album", "1")
	if response.Code != http.StatusRequestEntityTooLarge || strings.Contains(response.Header().Get("Content-Type"), "json") {
		t.Fatalf("above the limit: status = %d, body = %q", response.Code, response.Body.String())
	}
	if response := getList(t, s, "album", "0"); response.Code != http.StatusOK {
		t.Fatalf("plain listing: status = %d", response.Code)
	}
}
