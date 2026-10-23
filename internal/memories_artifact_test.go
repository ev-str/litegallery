package internal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

const unavailableMemories = `{"version":1,"state":"unavailable","shown":0,"events":[]}` + "\n"

func getMemories(t *testing.T, s *Server, method string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, httptest.NewRequest(method, "/api/memories", nil))
	return response
}

func decodeMemories(t *testing.T, s *Server) memoriesResponse {
	t.Helper()
	response := getMemories(t, s, http.MethodGet)
	if response.Code != http.StatusOK {
		t.Fatalf("memories code = %d, body = %q", response.Code, response.Body.String())
	}
	var document memoriesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	return document
}

// writeMemoriesTrip adds count videos captured one year before now, so the
// warmer builds one memory from them.
func writeMemoriesTrip(t *testing.T, root string, count int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "trip"), 0o755); err != nil {
		t.Fatal(err)
	}
	captured := time.Now().AddDate(-1, 0, 0)
	for i := range count {
		writeWarmTestMP4(t, filepath.Join(root, "trip", fmt.Sprintf("clip-%d.mp4", i)), captured.Add(time.Duration(i)*time.Minute))
	}
}

func testMemoriesArtifact(t *testing.T) memoriesArtifact {
	t.Helper()
	index := memoriesTestIndex(t, memoriesTestDay{date: "2025-07-10", count: 5}, memoriesTestDay{date: "2024-07-01", count: 6, kind: "video"})
	artifact := buildMemories(index, memoriesTestNow(t, "2026-07-10")).Artifact
	if len(artifact.Events) != 2 {
		t.Fatalf("events = %+v", artifact.Events)
	}
	return artifact
}

func TestMemoriesArtifactIsWrittenAtomically(t *testing.T) {
	s, _, _ := warmTestServer(t)
	artifact := testMemoriesArtifact(t)
	if err := s.writeMemoriesArtifact(artifact); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(s.memoriesPath()))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "memories-v1.json" {
		t.Fatalf("memories directory = %v", entries)
	}
	got, ok := s.readMemoriesArtifact()
	if !ok || !reflect.DeepEqual(got.Events, artifact.Events) || got.Revision != artifact.Revision {
		t.Fatalf("read back: %+v %v", got, ok)
	}

	var document map[string]json.RawMessage
	if err := json.Unmarshal(readFileBytes(t, s.memoriesPath()), &document); err != nil {
		t.Fatal(err)
	}
	var names []string
	for name := range document {
		names = append(names, name)
	}
	sort.Strings(names)
	if want := []string{"dateIndexGeneratedAt", "dateIndexVersion", "events", "generatedAt", "revision", "version"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("artifact keys = %v", names)
	}
}

func TestMemoriesEndpointUnavailableArtifacts(t *testing.T) {
	s, _, _ := warmTestServer(t)
	valid := testMemoriesArtifact(t)
	withEvents := func(change func(events []memoryEvent)) memoriesArtifact {
		artifact := valid
		artifact.Events = make([]memoryEvent, len(valid.Events))
		for i, event := range valid.Events {
			event.Media = append([]memoryMedia(nil), event.Media...)
			artifact.Events[i] = event
		}
		change(artifact.Events)
		artifact.Revision = memoriesRevision(artifact.Events)
		return artifact
	}
	cases := map[string]func(){
		"missing": func() {},
		"corrupt": func() { _ = writeFileAtomic(s.memoriesPath(), []byte("{not json")) },
		"unknown version": func() {
			artifact := valid
			artifact.Version = 99
			writeStatusArtifact(t, s.memoriesPath(), artifact)
		},
		"unknown date index version": func() {
			artifact := valid
			artifact.DateIndexVersion = 99
			writeStatusArtifact(t, s.memoriesPath(), artifact)
		},
		"missing events": func() {
			writeStatusArtifact(t, s.memoriesPath(), map[string]any{"version": 1, "generatedAt": valid.GeneratedAt, "revision": valid.Revision})
		},
		"revision mismatch": func() {
			artifact := valid
			artifact.Revision = "0000000000000000"
			writeStatusArtifact(t, s.memoriesPath(), artifact)
		},
		"relative escape": func() {
			writeStatusArtifact(t, s.memoriesPath(), withEvents(func(events []memoryEvent) { events[0].Media[0].Path = "../outside.jpg" }))
		},
		"absolute path": func() {
			writeStatusArtifact(t, s.memoriesPath(), withEvents(func(events []memoryEvent) { events[0].Media[0].Path = "/photos/a.jpg" }))
		},
		"unknown kind": func() {
			writeStatusArtifact(t, s.memoriesPath(), withEvents(func(events []memoryEvent) { events[0].Media[0].Kind = "directory" }))
		},
		"count mismatch": func() {
			writeStatusArtifact(t, s.memoriesPath(), withEvents(func(events []memoryEvent) { events[0].MediaCount++ }))
		},
		"too long": func() {
			writeStatusArtifact(t, s.memoriesPath(), withEvents(func(events []memoryEvent) {
				events[0].StartDate = "2025-06-01"
				events[0].ID = "2025-06-01_" + events[0].EndDate
				events[0].Year = 2025
			}))
		},
		"bad id": func() {
			writeStatusArtifact(t, s.memoriesPath(), withEvents(func(events []memoryEvent) { events[0].ID = "other" }))
		},
	}
	for name, setup := range cases {
		_ = os.Remove(s.memoriesPath())
		setup()
		response := getMemories(t, s, http.MethodGet)
		if response.Code != http.StatusOK || response.Body.String() != unavailableMemories || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %v %s", name, response.Code, response.Header(), response.Body.String())
		}
	}
}

func TestMemoriesEndpointMethods(t *testing.T) {
	s, _, _ := warmTestServer(t)
	artifact := testMemoriesArtifact(t)
	if err := s.writeMemoriesArtifact(artifact); err != nil {
		t.Fatal(err)
	}
	get := getMemories(t, s, http.MethodGet)
	if get.Code != http.StatusOK || get.Header().Get("Content-Type") != "application/json; charset=utf-8" || get.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("GET: %d %v", get.Code, get.Header())
	}
	document := decodeMemories(t, s)
	if document.Version != 1 || document.State != statusReady || document.Shown != 2 || document.Revision != artifact.Revision ||
		document.GeneratedAt == nil || !reflect.DeepEqual(document.Events, artifact.Events) {
		t.Fatalf("document = %+v", document)
	}

	head := getMemories(t, s, http.MethodHead)
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Cache-Control") != "no-store" || head.Header().Get("Content-Length") != fmt.Sprint(get.Body.Len()) {
		t.Fatalf("HEAD: %d %v body=%q", head.Code, head.Header(), head.Body.String())
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		response := getMemories(t, s, method)
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("%s: %d %v", method, response.Code, response.Header())
		}
	}
}

func TestMemoriesEndpointShowsAtMostSix(t *testing.T) {
	s, _, _ := warmTestServer(t)
	var days []memoriesTestDay
	for year := 2017; year <= 2025; year++ {
		days = append(days, memoriesTestDay{date: fmt.Sprintf("%d-07-10", year), count: 5})
	}
	build := buildMemories(memoriesTestIndex(t, days...), memoriesTestNow(t, "2026-07-10"))
	if err := s.writeMemoriesArtifact(build.Artifact); err != nil {
		t.Fatal(err)
	}
	if document := decodeMemories(t, s); document.Shown != 6 || len(document.Events) != 9 || document.Events[0].Year != 2025 {
		t.Fatalf("document = %+v", document)
	}
}

func TestWarmCacheBuildsMemoriesWithoutAbsolutePaths(t *testing.T) {
	s, root, cache := warmTestServer(t)
	writeMemoriesTrip(t, root, 5)
	writeWarmTestJPEG(t, filepath.Join(root, "photo.jpg"))
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	artifact, ok := s.readMemoriesArtifact()
	if !ok || len(artifact.Events) != 1 || artifact.Events[0].MediaCount != 5 || artifact.Events[0].Media[0].Path != "trip/clip-0.mp4" || artifact.Events[0].Media[0].Kind != "video" {
		t.Fatalf("artifact = %+v %v", artifact, ok)
	}
	index, _ := s.readDateIndex()
	if artifact.DateIndexVersion != index.Version || !artifact.DateIndexGeneratedAt.Equal(index.GeneratedAt) {
		t.Fatalf("source index = %d %v, want %d %v", artifact.DateIndexVersion, artifact.DateIndexGeneratedAt, index.Version, index.GeneratedAt)
	}

	status := decodeStatus(t, s).Memories
	if status.State != statusReady || status.ReadyVersion != artifact.Revision || status.ReadyAt == nil || !status.ReadyAt.Equal(artifact.GeneratedAt) ||
		*status.Memories != 1 || *status.Shown != 1 || *status.Errors != 0 || *status.Periods < 1 {
		t.Fatalf("memories status = %+v", status)
	}
	bodies := []string{getMemories(t, s, http.MethodGet).Body.String(), getStatus(t, s, http.MethodGet).Body.String(),
		string(readFileBytes(t, s.memoriesPath())), string(readFileBytes(t, s.memoriesStatusPath()))}
	for _, body := range bodies {
		for _, private := range append(cachePathForms(cache), root, filepath.Dir(root)) {
			if strings.Contains(body, private) {
				t.Fatalf("response contains %q: %s", private, body)
			}
		}
	}
}

// A failed memories build keeps the last known good artifact: /api/status
// reports the failed build as unavailable with the last ready version, while
// /api/memories keeps serving that version as ready.
func TestWarmCacheMemoriesFailureKeepsLastKnownGood(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	s, root, cache := warmTestServer(t)
	writeMemoriesTrip(t, root, 5)
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	good := readFileBytes(t, s.memoriesPath())
	goodArtifact, _ := s.readMemoriesArtifact()
	stamp := filepath.Join(cache, ".warm-success")
	_ = os.Chtimes(stamp, time.Now().Add(-time.Hour), time.Now().Add(-time.Hour))
	stampBefore, _ := os.Stat(stamp)

	// A read-only memories directory makes the atomic write fail.
	memoriesDir := filepath.Dir(s.memoriesPath())
	if err := os.Chmod(memoriesDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(memoriesDir, 0o755) })
	writeMemoriesTrip(t, root, 6)
	var reported []string
	stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, OnError: func(operation, _ string, _ error) { reported = append(reported, operation) }})
	if err != nil || stats.Media != 6 || stats.Errors != 1 {
		t.Fatalf("warm failed: %+v %v", stats, err)
	}
	if got := readFileBytes(t, s.memoriesPath()); string(got) != string(good) {
		t.Fatal("last good memories artifact changed")
	}
	if stampAfter, _ := os.Stat(stamp); !stampAfter.ModTime().After(stampBefore.ModTime()) {
		t.Fatal("warm success stamp was not refreshed")
	}
	status := decodeStatus(t, s)
	memories := status.Memories
	if status.Run.State != runSucceeded || status.Run.Errors != 1 {
		t.Fatalf("run = %+v", status.Run)
	}
	if status.State != statusReady || memories.State != statusUnavailable || memories.Errors == nil || *memories.Errors != 1 ||
		memories.ReadyVersion != goodArtifact.Revision || memories.ReadyAt == nil || !memories.ReadyAt.Equal(goodArtifact.GeneratedAt) {
		t.Fatalf("status = %+v memories = %+v", status, memories)
	}
	if !reflect.DeepEqual(reported, []string{"memories"}) || len(status.RecentErrors) != 1 || status.RecentErrors[0].Operation != "memories" {
		t.Fatalf("reported = %v recent = %+v", reported, status.RecentErrors)
	}
	for _, private := range append(cachePathForms(cache), root) {
		if strings.Contains(status.RecentErrors[0].Error, private) {
			t.Fatalf("error text leaks %q: %q", private, status.RecentErrors[0].Error)
		}
	}
	document := decodeMemories(t, s)
	if document.State != statusReady || document.Revision != goodArtifact.Revision || document.GeneratedAt == nil ||
		!document.GeneratedAt.Equal(goodArtifact.GeneratedAt) || !reflect.DeepEqual(document.Events, goodArtifact.Events) {
		t.Fatalf("memories endpoint = %+v", document)
	}

	if err := os.Chmod(memoriesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	recovered := decodeStatus(t, s).Memories
	artifact, ok := s.readMemoriesArtifact()
	if !ok || artifact.Events[0].MediaCount != 6 || recovered.State != statusReady || *recovered.Errors != 0 || recovered.ReadyVersion != artifact.Revision {
		t.Fatalf("recovered = %+v artifact = %+v", recovered, artifact)
	}
	if run := decodeStatus(t, s).Run; run.State != runSucceeded || run.Errors != 0 {
		t.Fatalf("recovered run = %+v", run)
	}
}

func TestWarmCacheMinIntervalRebuildsMissingMemories(t *testing.T) {
	s, root, _ := warmTestServer(t)
	writeMemoriesTrip(t, root, 5)
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(s.memoriesPath()); err != nil {
		t.Fatal(err)
	}
	stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
	if err != nil || stats.SkippedRecent {
		t.Fatalf("run was skipped or failed: %+v %v", stats, err)
	}
	if document := decodeMemories(t, s); document.State != statusReady || len(document.Events) != 1 {
		t.Fatalf("memories = %+v", document)
	}
}

func TestWarmCacheMinIntervalRequiresConsistentMemories(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(t *testing.T, s *Server)
	}{
		{"artifact from older date index", func(t *testing.T, s *Server) {
			index, _ := s.readDateIndex()
			index.GeneratedAt = index.GeneratedAt.Add(time.Hour)
			writeStatusArtifact(t, s.dateIndexPath(), index)
		}},
		{"missing memories status", func(t *testing.T, s *Server) { _ = os.Remove(s.memoriesStatusPath()) }},
		{"corrupt memories status", func(t *testing.T, s *Server) {
			_ = writeFileAtomic(s.memoriesStatusPath(), []byte("{not json"))
		}},
		{"failed memories status with ready version", func(t *testing.T, s *Server) {
			file, _ := s.readMemoriesStatusFile()
			file.State = runFailed
			writeStatusArtifact(t, s.memoriesStatusPath(), file)
		}},
		{"ready version mismatch", func(t *testing.T, s *Server) {
			file, _ := s.readMemoriesStatusFile()
			file.ReadyVersion = "0000000000000000"
			writeStatusArtifact(t, s.memoriesStatusPath(), file)
		}},
		{"ready time mismatch", func(t *testing.T, s *Server) {
			file, _ := s.readMemoriesStatusFile()
			readyAt := file.ReadyAt.Add(-time.Minute)
			file.ReadyAt = &readyAt
			writeStatusArtifact(t, s.memoriesStatusPath(), file)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, root, _ := warmTestServer(t)
			writeMemoriesTrip(t, root, 5)
			if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
				t.Fatal(err)
			}
			if !s.warmArtifactsReady() {
				t.Fatal("first run left an inconsistent set")
			}
			test.change(t, s)
			if s.warmArtifactsReady() {
				t.Fatal("inconsistent set is ready")
			}

			stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
			if err != nil || stats.SkippedRecent || stats.Media != 5 {
				t.Fatalf("run was skipped or failed: %+v %v", stats, err)
			}
			if !s.warmArtifactsReady() {
				t.Fatal("full run did not restore a consistent set")
			}
			if status := decodeStatus(t, s).Memories; status.State != statusReady || *status.Errors != 0 {
				t.Fatalf("memories status = %+v", status)
			}
		})
	}
}

// blockMemoriesStatus turns the status path into a non-empty directory, so
// every memories status write fails while the warm status stays writable.
func blockMemoriesStatus(t *testing.T, s *Server) {
	t.Helper()
	_ = os.Remove(s.memoriesStatusPath())
	if err := os.MkdirAll(filepath.Join(s.memoriesStatusPath(), "blocker"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestWarmCacheMemoriesStatusWriteFailure(t *testing.T) {
	s, root, cache := warmTestServer(t)
	writeMemoriesTrip(t, root, 5)
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	blockMemoriesStatus(t, s)
	writeMemoriesTrip(t, root, 6)
	var reported []error
	stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, OnError: func(operation, _ string, err error) {
		if operation != "memories" {
			t.Errorf("unexpected operation %q: %v", operation, err)
		}
		reported = append(reported, err)
	}})
	if err != nil || stats.Media != 6 || stats.Errors != 1 {
		t.Fatalf("warm failed: %+v %v", stats, err)
	}
	if len(reported) != 1 || !strings.Contains(reported[0].Error(), "write memories status") {
		t.Fatalf("reported = %v", reported)
	}
	// The running write failed too, yet the build still wrote the artifact.
	if artifact, ok := s.readMemoriesArtifact(); !ok || artifact.Events[0].MediaCount != 6 {
		t.Fatalf("artifact = %+v %v", artifact, ok)
	}
	status := decodeStatus(t, s)
	if status.State != statusReady || status.Run.State != runSucceeded || status.Run.Errors != 1 ||
		len(status.RecentErrors) != 1 || status.RecentErrors[0].Operation != "memories" || status.Memories.State != statusUnavailable {
		t.Fatalf("status = %+v", status)
	}
	for _, private := range append(cachePathForms(cache), root) {
		if strings.Contains(status.RecentErrors[0].Error, private) {
			t.Fatalf("error text leaks %q: %q", private, status.RecentErrors[0].Error)
		}
	}
	if s.warmArtifactsReady() {
		t.Fatal("set without memories status is ready")
	}

	if err := os.RemoveAll(s.memoriesStatusPath()); err != nil {
		t.Fatal(err)
	}
	stats, err = s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
	if err != nil || stats.SkippedRecent {
		t.Fatalf("run was skipped or failed: %+v %v", stats, err)
	}
	if !s.warmArtifactsReady() || decodeStatus(t, s).Memories.State != statusReady {
		t.Fatal("set was not restored")
	}
}

func TestWarmCacheMemoriesArtifactAndStatusFailuresAreJoined(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	s, root, _ := warmTestServer(t)
	writeMemoriesTrip(t, root, 5)
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	memoriesDir := filepath.Dir(s.memoriesPath())
	if err := os.Chmod(memoriesDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(memoriesDir, 0o755) })
	blockMemoriesStatus(t, s)

	var reported []error
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, OnError: func(_, _ string, err error) { reported = append(reported, err) }}); err != nil {
		t.Fatal(err)
	}
	if len(reported) != 1 || !strings.Contains(reported[0].Error(), "write memories artifact") || !strings.Contains(reported[0].Error(), "write memories status") {
		t.Fatalf("reported = %v", reported)
	}
	if recent := decodeStatus(t, s).RecentErrors; len(recent) != 1 || len(strings.Split(recent[0].Error, "; ")) != 2 {
		t.Fatalf("recent errors = %+v", recent)
	}
}
