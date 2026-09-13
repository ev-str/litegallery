package internal

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
)

func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, abs, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil || mediaKind(abs) == "" {
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}
	file, err := os.Open(abs)
	if err != nil {
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}
	if contentType := mime.TypeByExtension(filepath.Ext(abs)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
