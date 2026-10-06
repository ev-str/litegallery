package internal

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

type Config struct {
	Root           string
	Cache          string
	Listen         string
	Title          string
	Version        string
	ThumbSize      int
	MaxImagePixels int64
}

type Server struct {
	cfg Config
	web fs.FS
}

type Entry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Size     int64  `json:"size,omitempty"`
	ModTime  string `json:"modTime,omitempty"`
	SortTime int64  `json:"sortTime,omitempty"`
}

type listing struct {
	Path    string  `json:"path"`
	Title   string  `json:"title"`
	Entries []Entry `json:"entries"`
}

var imageExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".bmp": true, ".tif": true, ".tiff": true,
}

var videoExt = map[string]bool{
	".mp4": true, ".mov": true, ".m4v": true, ".avi": true,
	".mts": true, ".m2ts": true, ".3gp": true,
}

func New(cfg Config, web fs.FS) (*Server, error) {
	if cfg.Version == "" {
		cfg.Version = "dev"
	}
	if cfg.MaxImagePixels == 0 {
		cfg.MaxImagePixels = DefaultMaxImagePixels
	}
	if cfg.MaxImagePixels < 1 {
		return nil, errors.New("maximum image pixel count must be positive")
	}
	root, err := filepath.Abs(cfg.Root)
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	cfg.Root = root
	info, err := os.Stat(cfg.Root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("root is not a directory")
	}
	return &Server{cfg: cfg, web: web}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/list", s.handleList)
	mux.HandleFunc("/api/thumb", s.handleThumb)
	mux.HandleFunc("/api/video-poster", s.handleVideoPoster)
	mux.HandleFunc("/api/cover", s.handleCover)
	mux.HandleFunc("/api/media", s.handleMedia)
	mux.HandleFunc("/api/image-info", s.handleImageInfo)
	mux.HandleFunc("/api/exif", s.handleEXIF)
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("/", http.FileServer(http.FS(s.web)))
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"title": s.cfg.Title, "version": s.cfg.Version})
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel, abs, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	items, err := os.ReadDir(abs)
	if err != nil {
		http.Error(w, "cannot read directory", http.StatusNotFound)
		return
	}

	entries := make([]Entry, 0, len(items))
	metadata := s.readMetadataManifest(abs)
	for _, item := range items {
		if hidden(item.Name()) {
			continue
		}
		childRel := filepath.ToSlash(filepath.Join(rel, item.Name()))
		info, err := item.Info()
		if err != nil {
			continue
		}
		if item.IsDir() {
			entries = append(entries, Entry{Name: item.Name(), Path: childRel, Kind: "directory", ModTime: info.ModTime().Format("2006-01-02T15:04:05Z07:00")})
			continue
		}
		kind := mediaKind(item.Name())
		if kind == "" {
			continue
		}
		sortTime := fileCreatedUnix(info)
		if cached, ok := metadata.Files[item.Name()]; ok && cached.matches(kind, info) {
			if cached.Created != 0 {
				sortTime = cached.Created
			}
			if cached.Captured != 0 {
				sortTime = cached.Captured
			}
		}
		entries = append(entries, Entry{Name: item.Name(), Path: childRel, Kind: kind, Size: info.Size(), ModTime: info.ModTime().Format("2006-01-02T15:04:05Z07:00"), SortTime: sortTime})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Kind == "directory" && entries[j].Kind != "directory" {
			return true
		}
		if entries[i].Kind != "directory" && entries[j].Kind == "directory" {
			return false
		}
		return naturalLess(entries[i].Name, entries[j].Name)
	})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, listing{Path: rel, Title: s.cfg.Title, Entries: entries})
}

func (s *Server) resolve(input string) (string, string, error) {
	input = filepath.ToSlash(strings.TrimSpace(input))
	if strings.ContainsRune(input, 0) || strings.HasPrefix(input, "/") {
		return "", "", errors.New("absolute or invalid path")
	}
	clean := filepath.Clean(filepath.FromSlash(input))
	if clean == "." {
		clean = ""
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", "", errors.New("path traversal")
	}
	abs := filepath.Join(s.cfg.Root, clean)
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", "", err
	}
	relToRoot, err := filepath.Rel(s.cfg.Root, real)
	if err != nil || relToRoot == ".." || strings.HasPrefix(relToRoot, ".."+string(filepath.Separator)) {
		return "", "", errors.New("path escapes root")
	}
	return filepath.ToSlash(relToRoot), real, nil
}

func hidden(name string) bool {
	return strings.HasPrefix(name, ".") || strings.HasPrefix(name, "._")
}

func mediaKind(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if imageExt[ext] {
		return "image"
	}
	if videoExt[ext] {
		return "video"
	}
	return ""
}

func naturalLess(a, b string) bool {
	ra, rb := []rune(strings.ToLower(a)), []rune(strings.ToLower(b))
	for ia, ib := 0, 0; ia < len(ra) && ib < len(rb); {
		if unicode.IsDigit(ra[ia]) && unicode.IsDigit(rb[ib]) {
			ja, jb := ia, ib
			for ja < len(ra) && unicode.IsDigit(ra[ja]) {
				ja++
			}
			for jb < len(rb) && unicode.IsDigit(rb[jb]) {
				jb++
			}
			na, _ := strconv.ParseUint(string(ra[ia:ja]), 10, 64)
			nb, _ := strconv.ParseUint(string(rb[ib:jb]), 10, 64)
			if na != nb {
				return na < nb
			}
			ia, ib = ja, jb
			continue
		}
		if ra[ia] != rb[ib] {
			return ra[ia] < rb[ib]
		}
		ia++
		ib++
	}
	return len(ra) < len(rb)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
