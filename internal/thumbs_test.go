package internal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMakeThumbnailHonorsPixelLimit(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source.jpg")
	writeTestJPEG(t, source)

	tooSmall := filepath.Join(directory, "too-small.jpg")
	err := makeThumbnail(source, tooSmall, 320, 47)
	if err == nil || !strings.Contains(err.Error(), "8x6 exceed limit of 47 pixels") {
		t.Fatalf("oversized image error = %v", err)
	}
	if _, statErr := os.Stat(tooSmall); !os.IsNotExist(statErr) {
		t.Fatalf("oversized thumbnail was written: %v", statErr)
	}

	accepted := filepath.Join(directory, "accepted.jpg")
	if err := makeThumbnail(source, accepted, 320, 48); err != nil {
		t.Fatalf("image at pixel limit rejected: %v", err)
	}
	if info, err := os.Stat(accepted); err != nil || info.Size() == 0 {
		t.Fatalf("accepted thumbnail missing or empty: info=%v error=%v", info, err)
	}
}

func TestValidateImageDimensionsRejectsInvalidLimit(t *testing.T) {
	if err := validateImageDimensions(8, 6, 0); err == nil {
		t.Fatal("zero pixel limit was accepted")
	}
}
