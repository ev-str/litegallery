package internal

import (
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

// maxSearchResults bounds one answer; a broader query reports truncated.
var maxSearchResults = 2000

type searchResponse struct {
	Query     string  `json:"query"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

// searchIndexCache keeps the last parsed date index until the warmer replaces
// the file, so a query does not parse the whole index again.
type searchIndexCache struct {
	mu      sync.Mutex
	modTime time.Time
	size    int64
	index   dateIndex
}

func (s *Server) searchIndex() (dateIndex, bool) {
	info, err := os.Stat(s.dateIndexPath())
	if err != nil {
		return dateIndex{}, false
	}
	cache := &s.search
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.index.Items != nil && cache.modTime.Equal(info.ModTime()) && cache.size == info.Size() {
		return cache.index, true
	}
	index, ok := s.readDateIndex()
	if !ok {
		cache.index = dateIndex{}
		return dateIndex{}, false
	}
	cache.modTime, cache.size, cache.index = info.ModTime(), info.Size(), index
	return index, true
}

// handleSearch matches the query, case-insensitively, against the relative
// path of every file in the date index; the path includes the file name. It
// reads only the index the cache warmer wrote and never walks the library.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		http.Error(w, "empty query", http.StatusBadRequest)
		return
	}
	index, ok := s.searchIndex()
	if !ok {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "search index is not ready", http.StatusServiceUnavailable)
		return
	}
	needle := strings.ToLower(query)
	done := r.Context().Done()
	result := searchResponse{Query: query, Entries: make([]Entry, 0)}
	for i, item := range index.Items {
		if i%1024 == 0 {
			select {
			case <-done:
				return
			default:
			}
		}
		if !strings.Contains(strings.ToLower(item.Path), needle) {
			continue
		}
		if len(result.Entries) == maxSearchResults {
			result.Truncated = true
			break
		}
		result.Entries = append(result.Entries, Entry{
			Name:     path.Base(item.Path),
			Path:     item.Path,
			Kind:     item.Kind,
			Size:     item.Size,
			ModTime:  time.Unix(0, item.ModifiedNS).Format("2006-01-02T15:04:05Z07:00"),
			SortTime: item.SortTime,
		})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}
