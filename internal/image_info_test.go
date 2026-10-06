package internal

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"testing/fstest"
	"time"
)

func newImageInfoTestServer(t *testing.T, root, cache string, maxPixels int64) *Server {
	t.Helper()
	s, err := New(Config{
		Root:           root,
		Cache:          cache,
		Title:          "test",
		ThumbSize:      320,
		MaxImagePixels: maxPixels,
	}, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func writeImageInfoJPEG(t *testing.T, path string, width, height int) {
	t.Helper()
	writeImageInfoFixture(t, path, width, height, func(file *os.File, fixture image.Image) error {
		return jpeg.Encode(file, fixture, &jpeg.Options{Quality: 90})
	})
}

func addImageInfoJPEGOrientation(t *testing.T, path string, orientation uint16) {
	t.Helper()
	jpegData, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(jpegData) < 2 || jpegData[0] != 0xff || jpegData[1] != 0xd8 {
		t.Fatal("fixture is not a JPEG")
	}

	// Minimal little-endian TIFF with a single Orientation entry, wrapped in
	// an EXIF APP1 segment. The encoded pixel matrix itself is left untouched.
	tiff := make([]byte, 26)
	copy(tiff[:2], "II")
	binary.LittleEndian.PutUint16(tiff[2:4], 42)
	binary.LittleEndian.PutUint32(tiff[4:8], 8)
	binary.LittleEndian.PutUint16(tiff[8:10], 1)
	binary.LittleEndian.PutUint16(tiff[10:12], 0x0112)
	binary.LittleEndian.PutUint16(tiff[12:14], 3)
	binary.LittleEndian.PutUint32(tiff[14:18], 1)
	binary.LittleEndian.PutUint16(tiff[18:20], orientation)

	payload := append([]byte("Exif\x00\x00"), tiff...)
	segment := make([]byte, 4+len(payload))
	segment[0], segment[1] = 0xff, 0xe1
	binary.BigEndian.PutUint16(segment[2:4], uint16(len(payload)+2))
	copy(segment[4:], payload)

	withEXIF := make([]byte, 0, len(jpegData)+len(segment))
	withEXIF = append(withEXIF, jpegData[:2]...)
	withEXIF = append(withEXIF, segment...)
	withEXIF = append(withEXIF, jpegData[2:]...)
	if err := os.WriteFile(path, withEXIF, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeImageInfoPNG(t *testing.T, path string, width, height int) {
	t.Helper()
	writeImageInfoFixture(t, path, width, height, func(file *os.File, fixture image.Image) error {
		return png.Encode(file, fixture)
	})
}

func writeImageInfoFixture(t *testing.T, path string, width, height int, encode func(*os.File, image.Image) error) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	fixture := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			fixture.Set(x, y, color.RGBA{R: uint8(x * 17), G: uint8(y * 23), B: 127, A: 255})
		}
	}
	if err := encode(file, fixture); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func imageInfoRequest(t *testing.T, s *Server, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/api/image-info?path="+url.QueryEscape(path), nil)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	return response
}

func TestImageInfoReturnsJPEGAndPNGDimensionsWithoutEXIF(t *testing.T) {
	s, root := testServer(t)
	writeImageInfoJPEG(t, filepath.Join(root, "plain.jpg"), 13, 7)
	writeImageInfoPNG(t, filepath.Join(root, "plain.png"), 9, 15)

	tests := []struct {
		path     string
		width    int
		height   int
		mimeType string
	}{
		{path: "plain.jpg", width: 13, height: 7, mimeType: "image/jpeg"},
		{path: "plain.png", width: 9, height: 15, mimeType: "image/png"},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			response := imageInfoRequest(t, s, http.MethodGet, test.path)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
			}
			var got imageInfoResponse
			if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(filepath.Join(root, test.path))
			if err != nil {
				t.Fatal(err)
			}
			if got.Width != test.width || got.Height != test.height || got.MIMEType != test.mimeType {
				t.Fatalf("response = %+v", got)
			}
			if got.Size != info.Size() || got.ModTime != info.ModTime().Format(time.RFC3339) {
				t.Fatalf("file metadata = %+v, stat size=%d modTime=%s", got, info.Size(), info.ModTime().Format(time.RFC3339))
			}
			if contentType := response.Header().Get("Content-Type"); contentType != "application/json; charset=utf-8" {
				t.Fatalf("content-type = %q", contentType)
			}
			if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "private, max-age=3600" {
				t.Fatalf("cache-control = %q", cacheControl)
			}
		})
	}
}

func TestImageInfoUsesDisplayDimensionsForJPEGOrientation(t *testing.T) {
	s, root := testServer(t)
	tests := []struct {
		name        string
		orientation uint16
		wantWidth   int
		wantHeight  int
	}{
		{name: "without EXIF", wantWidth: 13, wantHeight: 7},
		{name: "orientation 1", orientation: 1, wantWidth: 13, wantHeight: 7},
		{name: "orientation 2 mirrored horizontal", orientation: 2, wantWidth: 13, wantHeight: 7},
		{name: "orientation 3 rotated 180", orientation: 3, wantWidth: 13, wantHeight: 7},
		{name: "orientation 4 mirrored vertical", orientation: 4, wantWidth: 13, wantHeight: 7},
		{name: "orientation 5 mirrored and rotated", orientation: 5, wantWidth: 7, wantHeight: 13},
		{name: "orientation 6", orientation: 6, wantWidth: 7, wantHeight: 13},
		{name: "orientation 7 mirrored and rotated", orientation: 7, wantWidth: 7, wantHeight: 13},
		{name: "orientation 8", orientation: 8, wantWidth: 7, wantHeight: 13},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			name := "orientation-" + test.name + ".jpg"
			path := filepath.Join(root, name)
			writeImageInfoJPEG(t, path, 13, 7)
			if test.orientation != 0 {
				addImageInfoJPEGOrientation(t, path, test.orientation)
			}

			response := imageInfoRequest(t, s, http.MethodGet, name)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
			}
			var got imageInfoResponse
			if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
			if got.Width != test.wantWidth || got.Height != test.wantHeight {
				t.Fatalf("display dimensions = %dx%d, want %dx%d", got.Width, got.Height, test.wantWidth, test.wantHeight)
			}
		})
	}
}

func TestImageInfoRejectsWrongMethod(t *testing.T) {
	s, root := testServer(t)
	writeImageInfoJPEG(t, filepath.Join(root, "photo.jpg"), 8, 6)

	response := imageInfoRequest(t, s, http.MethodPost, "photo.jpg")
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestImageInfoRejectsMissingNonImageAndCorruptFiles(t *testing.T) {
	s, root := testServer(t)
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "broken.jpg"), []byte("not a jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		path string
		want int
	}{
		{name: "missing", path: "missing.jpg", want: http.StatusNotFound},
		{name: "non image extension", path: "notes.txt", want: http.StatusNotFound},
		{name: "corrupt image", path: "broken.jpg", want: http.StatusUnsupportedMediaType},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := imageInfoRequest(t, s, http.MethodGet, test.path)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d, body = %q", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestImageInfoEnforcesMaximumPixelCount(t *testing.T) {
	root := t.TempDir()
	cache := filepath.Join(t.TempDir(), "cache")
	s := newImageInfoTestServer(t, root, cache, 100)
	writeImageInfoPNG(t, filepath.Join(root, "at-limit.png"), 10, 10)
	writeImageInfoPNG(t, filepath.Join(root, "over-limit.png"), 11, 10)

	if response := imageInfoRequest(t, s, http.MethodGet, "at-limit.png"); response.Code != http.StatusOK {
		t.Fatalf("at limit: status = %d, body = %q", response.Code, response.Body.String())
	}
	if response := imageInfoRequest(t, s, http.MethodGet, "over-limit.png"); response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over limit: status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestImageInfoRejectsTraversalAndExternalSymlink(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "library")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	writeImageInfoJPEG(t, filepath.Join(outside, "secret.jpg"), 4, 3)
	s := newImageInfoTestServer(t, root, filepath.Join(base, "cache"), DefaultMaxImagePixels)

	for _, path := range []string{"../outside/secret.jpg", "nested/../../outside/secret.jpg", "/etc/passwd"} {
		response := imageInfoRequest(t, s, http.MethodGet, path)
		if response.Code != http.StatusNotFound {
			t.Errorf("path %q: status = %d, body = %q", path, response.Code, response.Body.String())
		}
	}

	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		if linkError, ok := err.(*os.LinkError); ok && linkError.Err == fs.ErrPermission {
			t.Skip("symlinks unavailable")
		}
		t.Fatal(err)
	}
	response := imageInfoRequest(t, s, http.MethodGet, "escape/secret.jpg")
	if response.Code != http.StatusNotFound {
		t.Fatalf("external symlink: status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestImageInfoRequiresRegularFile(t *testing.T) {
	s, root := testServer(t)
	if err := os.Mkdir(filepath.Join(root, "album.jpg"), 0o755); err != nil {
		t.Fatal(err)
	}
	response := imageInfoRequest(t, s, http.MethodGet, "album.jpg")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
}

type imageInfoFileSnapshot struct {
	Mode    fs.FileMode
	Size    int64
	ModTime time.Time
	Data    []byte
}

func snapshotImageInfoTree(t *testing.T, root string) map[string]imageInfoFileSnapshot {
	t.Helper()
	snapshot := make(map[string]imageInfoFileSnapshot)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		item := imageInfoFileSnapshot{Mode: info.Mode(), Size: info.Size(), ModTime: info.ModTime()}
		if info.Mode().IsRegular() {
			item.Data, err = os.ReadFile(path)
			if err != nil {
				return err
			}
		}
		snapshot[filepath.ToSlash(rel)] = item
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestImageInfoDoesNotModifyOriginalOrWriteFiles(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "library")
	cache := filepath.Join(base, "cache")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	photo := filepath.Join(root, "photo.jpg")
	writeImageInfoJPEG(t, photo, 8, 6)
	fixedTime := time.Date(2025, 4, 3, 2, 1, 0, 0, time.UTC)
	if err := os.Chtimes(photo, fixedTime, fixedTime); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "sentinel"), []byte("unchanged"), 0o640); err != nil {
		t.Fatal(err)
	}

	before := snapshotImageInfoTree(t, base)
	s := newImageInfoTestServer(t, root, cache, DefaultMaxImagePixels)
	response := imageInfoRequest(t, s, http.MethodGet, "photo.jpg")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	after := snapshotImageInfoTree(t, base)

	if !reflect.DeepEqual(after, before) {
		t.Fatalf("filesystem changed after image-info request\nbefore: %#v\nafter:  %#v", before, after)
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatalf("cache path was unexpectedly created or inaccessible: %v", err)
	}
	original, err := os.ReadFile(photo)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, before["library/photo.jpg"].Data) {
		t.Fatal("original bytes changed")
	}
}
