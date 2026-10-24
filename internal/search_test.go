package internal

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSearchIndex(t *testing.T, s *Server, items ...dateIndexItem) {
	t.Helper()
	writeStatusArtifact(t, s.dateIndexPath(), dateIndex{Version: dateIndexVersion, GeneratedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Items: items})
}

func searchRequest(t *testing.T, s *Server, method, query string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/api/search?q="+url.QueryEscape(query), nil)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	return response
}

func searchPaths(t *testing.T, response *httptest.ResponseRecorder) []string {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", response.Code, response.Body.String())
	}
	var result searchResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 0, len(result.Entries))
	for _, entry := range result.Entries {
		paths = append(paths, entry.Path)
	}
	return paths
}

var searchItems = []dateIndexItem{
	{Path: "2024/Summer/Beach/IMG_0001.jpg", Kind: "image", SortTime: 100, Captured: true, Size: 10, ModifiedNS: 1_700_000_000_000_000_000},
	{Path: "2024/Winter/IMG_0001.jpg", Kind: "image", SortTime: 200, Size: 20, ModifiedNS: 1_700_000_100_000_000_000},
	{Path: "2025/Trips/Clip.MOV", Kind: "video", SortTime: 300, Size: 30, ModifiedNS: 1_700_000_200_000_000_000},
}

func TestSearchMatchesNamesAndPathsInIndexOrder(t *testing.T) {
	s, _ := testServer(t)
	writeSearchIndex(t, s, searchItems...)

	response := searchRequest(t, s, http.MethodGet, "img_0001")
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	var result searchResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	want := []Entry{
		{Name: "IMG_0001.jpg", Path: "2024/Summer/Beach/IMG_0001.jpg", Kind: "image", Size: 10, ModTime: time.Unix(0, searchItems[0].ModifiedNS).Format("2006-01-02T15:04:05Z07:00"), SortTime: 100},
		{Name: "IMG_0001.jpg", Path: "2024/Winter/IMG_0001.jpg", Kind: "image", Size: 20, ModTime: time.Unix(0, searchItems[1].ModifiedNS).Format("2006-01-02T15:04:05Z07:00"), SortTime: 200},
	}
	if result.Query != "img_0001" || result.Truncated || len(result.Entries) != len(want) {
		t.Fatalf("result = %+v", result)
	}
	for i := range want {
		if result.Entries[i] != want[i] {
			t.Fatalf("entry %d = %+v, want %+v", i, result.Entries[i], want[i])
		}
	}

	for query, want := range map[string][]string{
		"summer/beach": {"2024/Summer/Beach/IMG_0001.jpg"},
		"WINTER":       {"2024/Winter/IMG_0001.jpg"},
		"clip.mov":     {"2025/Trips/Clip.MOV"},
		"  trips  ":    {"2025/Trips/Clip.MOV"},
		"2024/":        {"2024/Summer/Beach/IMG_0001.jpg", "2024/Winter/IMG_0001.jpg"},
		"nothing":      {},
	} {
		got := searchPaths(t, searchRequest(t, s, http.MethodGet, query))
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("query %q = %v, want %v", query, got, want)
		}
	}
}

func TestSearchRejectsEmptyQueryAndOtherMethods(t *testing.T) {
	s, _ := testServer(t)
	writeSearchIndex(t, s, searchItems...)
	for _, query := range []string{"", "   "} {
		if response := searchRequest(t, s, http.MethodGet, query); response.Code != http.StatusBadRequest || strings.Contains(response.Body.String(), "IMG_0001") {
			t.Fatalf("query %q: status %d, body %q", query, response.Code, response.Body.String())
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodHead, http.MethodPut, http.MethodDelete} {
		response := searchRequest(t, s, method, "img")
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
			t.Fatalf("%s: status %d, Allow %q", method, response.Code, response.Header().Get("Allow"))
		}
	}
}

func TestSearchIsUnavailableWithoutAValidIndex(t *testing.T) {
	cases := map[string]func(t *testing.T, s *Server){
		"missing": func(*testing.T, *Server) {},
		"corrupt": func(t *testing.T, s *Server) {
			if err := writeFileAtomic(s.dateIndexPath(), []byte("{not json")); err != nil {
				t.Fatal(err)
			}
		},
		"unknown version": func(t *testing.T, s *Server) {
			writeStatusArtifact(t, s.dateIndexPath(), dateIndex{Version: 99, GeneratedAt: time.Now(), Items: []dateIndexItem{}})
		},
		"unsafe path": func(t *testing.T, s *Server) {
			writeSearchIndex(t, s, dateIndexItem{Path: "../outside/IMG_0001.jpg", Kind: "image"})
		},
		"absolute path": func(t *testing.T, s *Server) {
			writeSearchIndex(t, s, dateIndexItem{Path: "/etc/IMG_0001.jpg", Kind: "image"})
		},
	}
	for name, prepare := range cases {
		t.Run(name, func(t *testing.T) {
			s, _ := testServer(t)
			prepare(t, s)
			response := searchRequest(t, s, http.MethodGet, "img")
			if response.Code != http.StatusServiceUnavailable || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status %d, Cache-Control %q", response.Code, response.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestSearchFollowsANewIndexAndAnIndexThatTurnsInvalid(t *testing.T) {
	s, _ := testServer(t)
	writeSearchIndex(t, s, searchItems[0])
	if got := searchPaths(t, searchRequest(t, s, http.MethodGet, "img")); len(got) != 1 {
		t.Fatalf("first index = %v", got)
	}
	writeSearchIndex(t, s, searchItems...)
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(s.dateIndexPath(), later, later); err != nil {
		t.Fatal(err)
	}
	if got := searchPaths(t, searchRequest(t, s, http.MethodGet, "img")); len(got) != 2 {
		t.Fatalf("replaced index = %v", got)
	}
	if err := writeFileAtomic(s.dateIndexPath(), []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	if response := searchRequest(t, s, http.MethodGet, "img"); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("corrupted index: status %d", response.Code)
	}
}

func TestSearchCapsResults(t *testing.T) {
	previous := maxSearchResults
	maxSearchResults = 2
	t.Cleanup(func() { maxSearchResults = previous })
	s, _ := testServer(t)
	writeSearchIndex(t, s, searchItems...)
	var result searchResponse
	if err := json.NewDecoder(searchRequest(t, s, http.MethodGet, "20").Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 2 || !result.Truncated {
		t.Fatalf("result = %+v", result)
	}
}

func TestSearchStopsForACanceledRequest(t *testing.T) {
	s, _ := testServer(t)
	writeSearchIndex(t, s, searchItems...)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/search?q=img", nil).WithContext(ctx)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" {
		t.Fatalf("canceled request wrote %q", response.Body.String())
	}
}

func TestSearchDoesNotWrite(t *testing.T) {
	s, root := testServer(t)
	writeSearchIndex(t, s, searchItems...)
	before := snapshotTree(t, root)
	searchPaths(t, searchRequest(t, s, http.MethodGet, "img"))
	if after := snapshotTree(t, root); after != before {
		t.Fatalf("tree changed:\n%s\n---\n%s", before, after)
	}
}

// snapshotTree lists every path below root with its size and modification time.
func snapshotTree(t *testing.T, root string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		lines = append(lines, fmt.Sprintf("%s %d %d", path, info.Size(), info.ModTime().UnixNano()))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(lines, "\n")
}
