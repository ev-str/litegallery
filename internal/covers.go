package internal

import (
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"
)

func (s *Server) handleCover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, directory, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, "folder not found", http.StatusNotFound)
		return
	}
	cover, err := firstImage(directory)
	if err != nil {
		http.Error(w, "cover not found", http.StatusNotFound)
		return
	}
	rel, err := filepath.Rel(s.cfg.Root, cover)
	if err != nil {
		http.Error(w, "cover not found", http.StatusNotFound)
		return
	}
	query := r.URL.Query()
	query.Set("path", filepath.ToSlash(rel))
	r.URL.RawQuery = query.Encode()
	s.handleThumb(w, r)
}

func firstImage(directory string) (string, error) {
	var cover string
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return fs.SkipDir
		}
		if path != directory && hidden(entry.Name()) {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.IsDir() && mediaKind(entry.Name()) == "image" {
			cover = path
			return fs.SkipAll
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.SkipAll) {
		return "", err
	}
	if cover == "" {
		return "", fs.ErrNotExist
	}
	return cover, nil
}
