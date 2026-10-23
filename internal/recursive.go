package internal

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// maxRecursiveEntries bounds the memory and the response size of one
// recursive listing on a large library subtree.
var maxRecursiveEntries = 100_000

var errTooManyEntries = errors.New("too many entries")

// parseRecursive accepts only an absent value, "0", or "1".
func parseRecursive(value string) (recursive bool, ok bool) {
	switch value {
	case "", "0":
		return false, true
	case "1":
		return true, true
	}
	return false, false
}

func (s *Server) handleRecursiveList(w http.ResponseWriter, r *http.Request, rel, abs string) {
	if rel == "." {
		http.Error(w, "recursive listing is not available at the library root", http.StatusBadRequest)
		return
	}
	entries, err := s.listRecursive(r.Context(), rel, abs)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		if errors.Is(err, errTooManyEntries) {
			http.Error(w, "too many files below this folder for a recursive listing", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "cannot read directory", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, listing{Path: rel, Title: s.cfg.Title, Entries: entries})
}

// listRecursive returns media below the resolved directory abs. Symlinks are
// never followed, so the walk cannot leave abs. A failure to read abs itself
// is returned; failures below it skip only the affected entry or subtree.
// Each directory contributes its files before its subdirectories, both in
// natural name order. The cache directory and anything inside it are never
// listed, whether requested directly or reached during the walk. More than
// maxRecursiveEntries media files fail the whole listing with errTooManyEntries.
func (s *Server) listRecursive(ctx context.Context, rel, abs string) ([]Entry, error) {
	cacheRoot := s.realCacheRoot()
	entries := make([]Entry, 0)
	if cacheRoot != "" && pathWithin(abs, cacheRoot) {
		return entries, nil
	}
	var walk func(rel, abs string, top bool) error
	walk = func(rel, abs string, top bool) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if abs == cacheRoot {
			return nil
		}
		items, err := os.ReadDir(abs)
		if err != nil {
			if top {
				return err
			}
			return nil
		}
		sort.SliceStable(items, func(i, j int) bool { return naturalLess(items[i].Name(), items[j].Name()) })
		metadata := s.readMetadataManifest(abs)
		var dirs []os.DirEntry
		for _, item := range items {
			if err := ctx.Err(); err != nil {
				return err
			}
			if hidden(item.Name()) {
				continue
			}
			if item.IsDir() {
				dirs = append(dirs, item)
				continue
			}
			if !item.Type().IsRegular() {
				continue
			}
			kind := mediaKind(item.Name())
			if kind == "" {
				continue
			}
			info, err := item.Info()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			if len(entries) == maxRecursiveEntries {
				return errTooManyEntries
			}
			entries = append(entries, mediaEntry(item.Name(), filepath.ToSlash(filepath.Join(rel, item.Name())), kind, info, metadata))
		}
		for _, dir := range dirs {
			if err := walk(filepath.Join(rel, dir.Name()), filepath.Join(abs, dir.Name()), false); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(filepath.FromSlash(rel), abs, true); err != nil {
		return nil, err
	}
	return entries, nil
}

// realCacheRoot returns the canonical cache path when it lies strictly inside
// the library root, and "" otherwise.
func (s *Server) realCacheRoot() string {
	if s.cfg.Cache == "" {
		return ""
	}
	cacheRoot, err := filepath.Abs(s.cfg.Cache)
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(cacheRoot); err == nil {
		cacheRoot = real
	}
	cacheRoot = filepath.Clean(cacheRoot)
	if cacheRoot == s.cfg.Root || !pathWithin(cacheRoot, s.cfg.Root) {
		return ""
	}
	return cacheRoot
}

func pathWithin(path, parent string) bool {
	return path == parent || strings.HasPrefix(path, parent+string(filepath.Separator))
}
