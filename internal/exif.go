package internal

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/evanoberholster/imagemeta"
	exifmeta "github.com/evanoberholster/imagemeta/meta/exif"
)

type exifPosition struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Altitude  float32 `json:"altitude,omitempty"`
}

type exifResponse struct {
	HasMetadata  bool          `json:"hasMetadata"`
	CapturedAt   string        `json:"capturedAt,omitempty"`
	Camera       string        `json:"camera,omitempty"`
	Lens         string        `json:"lens,omitempty"`
	Exposure     string        `json:"exposure,omitempty"`
	Aperture     string        `json:"aperture,omitempty"`
	ISO          uint32        `json:"iso,omitempty"`
	FocalLength  string        `json:"focalLength,omitempty"`
	Width        uint32        `json:"width,omitempty"`
	Height       uint32        `json:"height,omitempty"`
	Position     *exifPosition `json:"position,omitempty"`
	capturedTime time.Time
}

func (s *Server) handleEXIF(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, abs, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil || mediaKind(abs) != "image" {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}
	metadata, err := readPhotoMetadata(abs)
	if err != nil {
		http.Error(w, "cannot read image metadata", http.StatusUnprocessableEntity)
		return
	}

	w.Header().Set("Cache-Control", "private, max-age=3600")
	writeJSON(w, http.StatusOK, metadata)
}

func readPhotoMetadata(path string) (exifResponse, error) {
	file, err := os.Open(path)
	if err != nil {
		return exifResponse{}, err
	}
	defer file.Close()

	metadata, err := imagemeta.Decode(file)
	if err != nil {
		if errors.Is(err, imagemeta.ErrNoExif) ||
			errors.Is(err, imagemeta.ErrMetadataNotSupported) ||
			errors.Is(err, imagemeta.ErrImageTypeNotFound) {
			return exifResponse{}, nil
		}
		return exifResponse{}, err
	}
	return presentEXIF(metadata), nil
}

func presentEXIF(metadata exifmeta.Exif) exifResponse {
	ifd0 := metadata.IFD0
	exif := metadata.ExifIFD
	capturedTime := localEXIFTime(exif.DateTimeOriginal)
	width, height := exif.PixelXDimension, exif.PixelYDimension
	if width == 0 {
		width = ifd0.ImageWidth
	}
	if height == 0 {
		height = ifd0.ImageHeight
	}

	result := exifResponse{
		CapturedAt:   formatEXIFTime(capturedTime),
		capturedTime: capturedTime,
		Camera:       joinMetadataParts(ifd0.Make, ifd0.Model),
		Lens:         strings.TrimSpace(exif.LensModel),
		Exposure:     exif.ExposureTime.String(),
		ISO:          exif.ISOSpeedRatings,
		FocalLength:  formatFocalLength(float64(exif.FocalLength)),
		Width:        width,
		Height:       height,
	}
	if exif.FNumber > 0 {
		result.Aperture = "f/" + exif.FNumber.String()
	}
	latitude, longitude := metadata.GPS.Latitude(), metadata.GPS.Longitude()
	if latitude != 0 || longitude != 0 {
		result.Position = &exifPosition{
			Latitude:  latitude,
			Longitude: longitude,
			Altitude:  metadata.GPS.Altitude(),
		}
	}
	result.HasMetadata = result.CapturedAt != "" || result.Camera != "" ||
		result.Lens != "" || result.Exposure != "" || result.Aperture != "" ||
		result.ISO != 0 || result.FocalLength != "" || result.Position != nil
	return result
}

// EXIF DateTimeOriginal is a wall-clock value without a timezone. imagemeta
// represents it as UTC, so rebuild the same clock reading in the NAS timezone
// before converting it to a Unix timestamp for mixed photo/video sorting.
func localEXIFTime(value time.Time) time.Time {
	if value.IsZero() {
		return time.Time{}
	}
	return time.Date(value.Year(), value.Month(), value.Day(), value.Hour(), value.Minute(), value.Second(), value.Nanosecond(), time.Local)
}

func formatEXIFTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.Format("02.01.2006 15:04:05")
}

func formatFocalLength(value float64) string {
	if value <= 0 {
		return ""
	}
	return fmt.Sprintf("%.1f mm", value)
}

func joinMetadataParts(make, model string) string {
	make = strings.TrimSpace(make)
	model = strings.TrimSpace(model)
	if make == "" {
		return model
	}
	if model == "" {
		return make
	}
	if strings.Contains(strings.ToLower(model), strings.ToLower(make)) {
		return model
	}
	return make + " " + model
}
