//go:build ignore

// Generates the EXIF-orientation and TIFF fixtures used by the browser tests:
//
//	go run tests/e2e/fixtures/orientation/generate.go
//
// Every JPEG stores the same 160×120 landscape pixels: red top-left, green
// top-right, blue bottom-left, and yellow bottom-right. Only the EXIF
// orientation tag differs, so a correctly oriented decode is 120×160 for
// orientations 5 and 6 with predictable quadrant colours.
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"log"
	"os"
	"path/filepath"

	"golang.org/x/image/tiff"
)

func main() {
	dir := filepath.Join("tests", "e2e", "fixtures", "orientation")
	img := quadrants(160, 120)
	for _, orientation := range []uint16{1, 5, 6} {
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, img, &jpeg.Options{Quality: 95}); err != nil {
			log.Fatal(err)
		}
		name := filepath.Join(dir, "Orientation "+string(rune('0'+orientation))+".jpg")
		if err := os.WriteFile(name, withOrientation(encoded.Bytes(), orientation), 0o644); err != nil {
			log.Fatal(err)
		}
	}
	var scan bytes.Buffer
	if err := tiff.Encode(&scan, img, &tiff.Options{Compression: tiff.Deflate}); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Scan.tif"), scan.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
}

func quadrants(width, height int) *image.RGBA {
	colors := [2][2]color.RGBA{
		{{220, 40, 40, 255}, {40, 180, 60, 255}},
		{{40, 70, 220, 255}, {230, 200, 40, 255}},
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, colors[y*2/height][x*2/width])
		}
	}
	return img
}

// withOrientation inserts a minimal little-endian EXIF APP1 segment right
// after the JPEG SOI marker.
func withOrientation(jpegData []byte, orientation uint16) []byte {
	var tiffData bytes.Buffer
	tiffData.WriteString("II")
	_ = binary.Write(&tiffData, binary.LittleEndian, uint16(42))
	_ = binary.Write(&tiffData, binary.LittleEndian, uint32(8))
	_ = binary.Write(&tiffData, binary.LittleEndian, uint16(1))
	_ = binary.Write(&tiffData, binary.LittleEndian, []uint16{0x0112, 3})
	_ = binary.Write(&tiffData, binary.LittleEndian, uint32(1))
	_ = binary.Write(&tiffData, binary.LittleEndian, []uint16{orientation, 0})
	_ = binary.Write(&tiffData, binary.LittleEndian, uint32(0))

	payload := append([]byte("Exif\x00\x00"), tiffData.Bytes()...)
	segment := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:], uint16(len(payload)+2))
	segment = append(segment, payload...)

	out := append([]byte{}, jpegData[:2]...)
	out = append(out, segment...)
	return append(out, jpegData[2:]...)
}
