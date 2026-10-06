package internal

import (
	"image"
	"io"
	"net/http"
	"os"
)

type imageInfoResponse struct {
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Size     int64  `json:"size"`
	ModTime  string `json:"modTime"`
	MIMEType string `json:"mimeType"`
}

func (s *Server) handleImageInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, abs, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil || mediaKind(abs) != "image" {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}

	file, err := os.Open(abs)
	if err != nil {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}

	config, format, err := image.DecodeConfig(file)
	if err != nil {
		http.Error(w, "cannot read image dimensions", http.StatusUnsupportedMediaType)
		return
	}
	if err := validateImageDimensions(config.Width, config.Height, s.cfg.MaxImagePixels); err != nil {
		http.Error(w, "image dimensions exceed limit", http.StatusRequestEntityTooLarge)
		return
	}
	width, height := config.Width, config.Height
	if format == "jpeg" {
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			http.Error(w, "cannot read image orientation", http.StatusInternalServerError)
			return
		}
		if orientation := jpegOrientation(file); orientation >= 5 && orientation <= 8 {
			width, height = height, width
		}
	}

	w.Header().Set("Cache-Control", "private, max-age=3600")
	writeJSON(w, http.StatusOK, imageInfoResponse{
		Width:    width,
		Height:   height,
		Size:     info.Size(),
		ModTime:  info.ModTime().Format("2006-01-02T15:04:05Z07:00"),
		MIMEType: imageMIMEType(format),
	})
}

func imageMIMEType(format string) string {
	switch format {
	case "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "bmp":
		return "image/bmp"
	case "tiff":
		return "image/tiff"
	default:
		return "application/octet-stream"
	}
}
