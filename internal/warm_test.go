package internal

import (
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func writeWarmTestMP4(t *testing.T, path string, captured time.Time) {
	t.Helper()
	mvhd := make([]byte, 108)
	binary.BigEndian.PutUint32(mvhd[0:4], uint32(len(mvhd)))
	copy(mvhd[4:8], "mvhd")
	binary.BigEndian.PutUint32(mvhd[12:16], uint32(captured.Unix()+mp4EpochOffset))
	binary.BigEndian.PutUint32(mvhd[20:24], 1000)
	binary.BigEndian.PutUint32(mvhd[28:32], 0x00010000)
	binary.BigEndian.PutUint16(mvhd[32:34], 0x0100)
	moov := make([]byte, 8+len(mvhd))
	binary.BigEndian.PutUint32(moov[0:4], uint32(len(moov)))
	copy(moov[4:8], "moov")
	copy(moov[8:], mvhd)
	if err := os.WriteFile(path, moov, 0o644); err != nil {
		t.Fatal(err)
	}
}

func warmTestServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "photos")
	cache := filepath.Join(base, "cache")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Root: root, Cache: cache, Title: "test", ThumbSize: 320}, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	return s, root, cache
}

func writeWarmTestJPEG(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestJPEG(t, path)
}

func TestWarmCacheGeneratesAndSkipsThumbnail(t *testing.T) {
	s, root, _ := warmTestServer(t)
	writeTestJPEG(t, filepath.Join(root, "photo.jpg"))

	first, err := s.WarmCache(context.Background(), WarmOptions{Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	if first.Generated != 1 || first.Skipped != 0 {
		t.Fatalf("first run: %+v", first)
	}
	second, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	if second.Generated != 0 || second.Skipped != 1 {
		t.Fatalf("second run: %+v", second)
	}
	recent, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if !recent.SkippedRecent || recent.Processed != 0 {
		t.Fatalf("recent run was not skipped: %+v", recent)
	}
}

func TestWarmCacheWritesOneMetadataManifestPerDirectory(t *testing.T) {
	s, root, _ := warmTestServer(t)
	writeTestJPEG(t, filepath.Join(root, "photo.jpg"))
	if err := os.WriteFile(filepath.Join(root, "video.mp4"), []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	manifest := s.readMetadataManifest(s.cfg.Root)
	if manifest.Version != metadataManifestVersion || len(manifest.Files) != 2 {
		t.Fatalf("manifest: %+v", manifest)
	}
	if manifest.Files["photo.jpg"].Kind != "image" || manifest.Files["video.mp4"].Kind != "video" {
		t.Fatalf("manifest files: %+v", manifest.Files)
	}
}

func TestWarmCacheUsesVideoContainerCreationTime(t *testing.T) {
	s, root, _ := warmTestServer(t)
	captured := time.Date(2026, 9, 6, 10, 24, 43, 0, time.UTC)
	writeWarmTestMP4(t, filepath.Join(root, "video.mp4"), captured)

	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	record := s.readMetadataManifest(s.cfg.Root).Files["video.mp4"]
	if record.Captured != captured.Unix() || !record.VideoDateChecked {
		t.Fatalf("video metadata: %+v", record)
	}
}

func TestReadMetadataManifestMigratesV1PhotoTimeToLocal(t *testing.T) {
	s, root, _ := warmTestServer(t)
	previousLocal := time.Local
	time.Local = time.FixedZone("test-local", 3*60*60)
	defer func() { time.Local = previousLocal }()

	storedUTC := time.Date(2026, 9, 6, 13, 24, 43, 0, time.UTC).Unix()
	legacy := metadataManifest{
		Version: 1,
		Files: map[string]metadataFileRecord{
			"photo.jpg": {Kind: "image", Captured: storedUTC},
		},
	}
	if err := s.writeMetadataManifest(root, legacy); err != nil {
		t.Fatal(err)
	}

	migrated := s.readMetadataManifest(root)
	want := time.Date(2026, 9, 6, 13, 24, 43, 0, time.Local).Unix()
	if migrated.Version != metadataManifestVersion || migrated.Files["photo.jpg"].Captured != want {
		t.Fatalf("migrated manifest: %+v", migrated)
	}
}

func TestWarmCacheReportsThumbnailErrorWithPath(t *testing.T) {
	s, root, _ := warmTestServer(t)
	broken := filepath.Join(root, "broken.jpg")
	if err := os.WriteFile(broken, []byte("not a jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}

	var gotOperation, gotPath string
	var gotErr error
	stats, err := s.WarmCache(context.Background(), WarmOptions{
		Workers: 1,
		OnError: func(operation, path string, err error) {
			gotOperation = operation
			gotPath = path
			gotErr = err
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Errors != 1 {
		t.Fatalf("stats: %+v", stats)
	}
	brokenResolved, resolveErr := filepath.EvalSymlinks(broken)
	if resolveErr != nil {
		t.Fatal(resolveErr)
	}
	if gotOperation != "thumbnail" || gotPath != brokenResolved || gotErr == nil {
		t.Fatalf("error callback: operation=%q path=%q error=%v", gotOperation, gotPath, gotErr)
	}
}

func TestWarmCacheSkipsCacheDirectoryInsideLibrary(t *testing.T) {
	root := t.TempDir()
	cache := filepath.Join(root, "cache")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Root: root, Cache: cache, Title: "test", ThumbSize: 320}, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}})
	if err != nil {
		t.Fatal(err)
	}
	writeTestJPEG(t, filepath.Join(root, "photo.jpg"))
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	second, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	if second.Media != 1 || second.Generated != 0 || second.Skipped != 1 {
		t.Fatalf("cache contents were scanned as media: %+v", second)
	}
}

func TestWarmCachePrunesOnlyOldOrphansAndKeepsVideoPoster(t *testing.T) {
	s, root, cache := warmTestServer(t)
	video := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(video, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	videoInfo, err := os.Stat(video)
	if err != nil {
		t.Fatal(err)
	}
	poster, _ := s.thumbnailCachePath(video, videoInfo)
	writeWarmTestJPEG(t, poster)

	oldOrphan := filepath.Join(cache, "aa", strings.Repeat("a", 64)+".jpg")
	recentOrphan := filepath.Join(cache, "bb", strings.Repeat("b", 64)+".jpg")
	writeWarmTestJPEG(t, oldOrphan)
	writeWarmTestJPEG(t, recentOrphan)
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(oldOrphan, old, old); err != nil {
		t.Fatal(err)
	}

	stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, Prune: true, PruneAfter: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Pruned != 1 {
		t.Fatalf("stats: %+v", stats)
	}
	if _, err := os.Stat(oldOrphan); !os.IsNotExist(err) {
		t.Fatalf("old orphan was not removed: %v", err)
	}
	for _, path := range []string{recentOrphan, poster} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("live or recent cache entry %q was removed: %v", path, err)
		}
	}
}

func TestWarmCacheDoesNotPruneWhenLibraryIsEmpty(t *testing.T) {
	s, _, cache := warmTestServer(t)
	orphan := filepath.Join(cache, "aa", strings.Repeat("a", 64)+".jpg")
	writeWarmTestJPEG(t, orphan)
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(orphan, old, old); err != nil {
		t.Fatal(err)
	}

	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, Prune: true, PruneAfter: time.Hour}); err == nil {
		t.Fatal("empty library scan succeeded")
	}
	if _, err := os.Stat(orphan); err != nil {
		t.Fatalf("orphan removed after empty scan: %v", err)
	}
}
