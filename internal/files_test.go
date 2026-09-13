package internal

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/evanoberholster/imagemeta/meta"
	exifmeta "github.com/evanoberholster/imagemeta/meta/exif"
)

func writeTestJPEG(t *testing.T, path string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	fixture := image.NewRGBA(image.Rect(0, 0, 8, 6))
	for y := 0; y < 6; y++ {
		for x := 0; x < 8; x++ {
			fixture.Set(x, y, color.RGBA{R: uint8(x * 20), G: uint8(y * 30), B: 120, A: 255})
		}
	}
	if err := jpeg.Encode(file, fixture, nil); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func testServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	s, err := New(Config{Root: root, Cache: filepath.Join(root, "cache"), Title: "test", ThumbSize: 320}, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}})
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func TestResolveRejectsTraversal(t *testing.T) {
	s, _ := testServer(t)
	for _, input := range []string{"../secret", "a/../../secret", "/etc/passwd"} {
		if _, _, err := s.resolve(input); err == nil {
			t.Errorf("resolve(%q) succeeded", input)
		}
	}
}

func TestResolveRejectsExternalSymlink(t *testing.T) {
	s, root := testServer(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		if errors, ok := err.(*os.LinkError); ok && errors.Err == fs.ErrPermission {
			t.Skip("symlinks unavailable")
		}
		t.Fatal(err)
	}
	if _, _, err := s.resolve("escape/secret.jpg"); err == nil {
		t.Fatal("external symlink was accepted")
	}
}

func TestCoverReturnsThumbnailFromNestedFolder(t *testing.T) {
	s, root := testServer(t)
	album := filepath.Join(root, "2026", "summer")
	if err := os.MkdirAll(album, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestJPEG(t, filepath.Join(album, "photo.jpg"))

	request := httptest.NewRequest(http.MethodGet, "/api/cover?path=2026", nil)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("content-type = %q", got)
	}
}

func TestMediaSupportsRangeRequests(t *testing.T) {
	s, root := testServer(t)
	payload := []byte("0123456789")
	if err := os.WriteFile(filepath.Join(root, "video.mp4"), payload, 0o644); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/media?path=video.mp4", nil)
	request.Header.Set("Range", "bytes=2-5")
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	if !bytes.Equal(response.Body.Bytes(), payload[2:6]) {
		t.Fatalf("body = %q", response.Body.Bytes())
	}
}

func TestVideoPosterUploadAndRead(t *testing.T) {
	s, root := testServer(t)
	if err := os.WriteFile(filepath.Join(root, "video.mp4"), []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	var poster bytes.Buffer
	fixture := image.NewRGBA(image.Rect(0, 0, 12, 8))
	if err := jpeg.Encode(&poster, fixture, nil); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPut, "/api/video-poster?path=video.mp4", bytes.NewReader(poster.Bytes()))
	request.Header.Set("Content-Type", "image/jpeg")
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("upload status = %d, body = %q", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/video-poster?path=video.mp4", nil)
	response = httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("read status = %d, body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("content-type = %q", got)
	}
}

func TestVideoPosterRejectsInvalidImage(t *testing.T) {
	s, root := testServer(t)
	if err := os.WriteFile(filepath.Join(root, "video.mp4"), []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/video-poster?path=video.mp4", bytes.NewBufferString("not a JPEG"))
	request.Header.Set("Content-Type", "image/jpeg")
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestMediaKind(t *testing.T) {
	tests := map[string]string{"photo.JPG": "image", "clip.MP4": "video", "raw.ARW": "", ".DS_Store": "", "digikam4.db": ""}
	for name, want := range tests {
		if got := mediaKind(name); got != want {
			t.Errorf("mediaKind(%q)=%q want %q", name, got, want)
		}
	}
}

func TestNaturalLess(t *testing.T) {
	if !naturalLess("IMG_2.jpg", "IMG_10.jpg") {
		t.Fatal("natural numeric order failed")
	}
}

func TestListUsesCachedCaptureTime(t *testing.T) {
	s, root := testServer(t)
	photo := filepath.Join(root, "photo.jpg")
	writeTestJPEG(t, photo)
	info, err := os.Stat(photo)
	if err != nil {
		t.Fatal(err)
	}
	captured := time.Date(2026, 9, 6, 13, 24, 43, 0, time.Local).Unix()
	manifest := metadataManifest{
		Version: metadataManifestVersion,
		Files: map[string]metadataFileRecord{
			"photo.jpg": {Kind: "image", Size: info.Size(), ModifiedNS: info.ModTime().UnixNano(), Captured: captured},
		},
	}
	if err := s.writeMetadataManifest(s.cfg.Root, manifest); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/list", nil)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	var result listing
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	var photoEntry Entry
	for _, entry := range result.Entries {
		if entry.Name == "photo.jpg" {
			photoEntry = entry
		}
	}
	if photoEntry.SortTime != captured {
		t.Fatalf("entries: %+v", result.Entries)
	}
}

func TestEXIFEndpointWithoutMetadata(t *testing.T) {
	s, root := testServer(t)
	writeTestJPEG(t, filepath.Join(root, "photo.jpg"))

	request := httptest.NewRequest(http.MethodGet, "/api/exif?path=photo.jpg", nil)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", response.Code, response.Body.String())
	}
	var metadata exifResponse
	if err := json.NewDecoder(response.Body).Decode(&metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.HasMetadata {
		t.Fatalf("unexpected metadata: %+v", metadata)
	}
}

func TestPresentEXIF(t *testing.T) {
	metadata := exifmeta.Exif{
		IFD0: exifmeta.IFD0Tag{Make: "Sony", Model: "ILCE-7M3"},
		ExifIFD: exifmeta.ExifIFDTags{
			ExifIFDTimeTags: exifmeta.ExifIFDTimeTags{DateTimeOriginal: time.Date(2026, 9, 10, 12, 34, 56, 0, time.UTC)},
			LensModel:       "FE 35mm F1.8",
			ExposureTime:    meta.ExposureTime(1.0 / 250.0),
			FNumber:         meta.Aperture(2.8),
			ISOSpeedRatings: 400,
			FocalLength:     meta.FocalLength(35),
			PixelXDimension: 6000,
			PixelYDimension: 4000,
		},
	}

	got := presentEXIF(metadata)
	if !got.HasMetadata || got.Camera != "Sony ILCE-7M3" || got.Exposure != "1/250" || got.Aperture != "f/2.80" {
		t.Fatalf("unexpected presentation: %+v", got)
	}
	if got.CapturedAt != "10.09.2026 12:34:56" || got.FocalLength != "35.0 mm" || got.Width != 6000 || got.Height != 4000 {
		t.Fatalf("unexpected presentation: %+v", got)
	}
	wantCaptured := time.Date(2026, 9, 10, 12, 34, 56, 0, time.Local)
	if !got.capturedTime.Equal(wantCaptured) {
		t.Fatalf("captured time = %v want %v", got.capturedTime, wantCaptured)
	}
}

func TestPresentEXIFDoesNotTreatDimensionsAsEXIF(t *testing.T) {
	got := presentEXIF(exifmeta.Exif{IFD0: exifmeta.IFD0Tag{ImageWidth: 50, ImageHeight: 50}})
	if got.HasMetadata {
		t.Fatalf("dimensions alone must not advertise EXIF: %+v", got)
	}
}
