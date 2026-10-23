package internal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func writeBrokenJPEG(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not a jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFileBytes(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func getStatus(t *testing.T, s *Server, method string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, httptest.NewRequest(method, "/api/status", nil))
	return response
}

func decodeStatus(t *testing.T, s *Server) GalleryStatus {
	t.Helper()
	response := getStatus(t, s, http.MethodGet)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, body = %q", response.Code, response.Body.String())
	}
	var status GalleryStatus
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func writeStatusArtifact(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, data); err != nil {
		t.Fatal(err)
	}
}

func setStatusTiming(t *testing.T, writeInterval time.Duration) {
	t.Helper()
	previousWrite, previousHeartbeat := warmStatusWriteInterval, warmStatusHeartbeat
	warmStatusWriteInterval = writeInterval
	t.Cleanup(func() { warmStatusWriteInterval, warmStatusHeartbeat = previousWrite, previousHeartbeat })
}

func TestWarmCachePublishesDateIndexAtomically(t *testing.T) {
	s, _, _ := warmTestServer(t)
	root := s.cfg.Root
	writeWarmTestJPEG(t, filepath.Join(root, "2024", "photo.jpg"))
	captured := time.Date(2020, 5, 1, 12, 0, 0, 0, time.UTC)
	writeWarmTestMP4(t, filepath.Join(root, "clip.mp4"), captured)
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("text"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 2}); err != nil {
		t.Fatal(err)
	}
	index, ok := s.readDateIndex()
	if !ok || index.Version != dateIndexVersion {
		t.Fatalf("index unavailable: %+v", index)
	}
	if len(index.Items) != 2 {
		t.Fatalf("items: %+v", index.Items)
	}
	video := index.Items[0]
	if video.Path != "clip.mp4" || video.Kind != "video" || video.SortTime != captured.Unix() || !video.Captured {
		t.Fatalf("video item: %+v", video)
	}
	photoInfo, err := os.Stat(filepath.Join(root, "2024", "photo.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	photo := index.Items[1]
	want := dateIndexItem{Path: "2024/photo.jpg", Kind: "image", SortTime: fileCreatedUnix(photoInfo), Size: photoInfo.Size(), ModifiedNS: photoInfo.ModTime().UnixNano()}
	if photo != want {
		t.Fatalf("photo item = %+v, want %+v", photo, want)
	}
	entries, err := os.ReadDir(filepath.Dir(s.dateIndexPath()))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "dates-v1.json" {
		t.Fatalf("index directory contains temporary files: %v", entries)
	}
}

func TestDateIndexOrderIsDeterministic(t *testing.T) {
	s, root, _ := warmTestServer(t)
	manifests := map[string]metadataManifest{
		s.cfg.Root: {Files: map[string]metadataFileRecord{
			"b.jpg": {Kind: "image", Created: 100},
			"a.jpg": {Kind: "image", Created: 100},
			"c.mp4": {Kind: "video", Created: 900, Captured: 50},
		}},
		filepath.Join(s.cfg.Root, "A"): {Files: map[string]metadataFileRecord{
			"z.jpg": {Kind: "image", Created: 100},
		}},
	}
	generated := time.Unix(1_700_000_000, 0)
	first, err := json.Marshal(s.buildDateIndex(manifests, generated))
	if err != nil {
		t.Fatal(err)
	}
	for range 20 {
		again, _ := json.Marshal(s.buildDateIndex(manifests, generated))
		if string(again) != string(first) {
			t.Fatalf("index bytes differ:\n%s\n%s", first, again)
		}
	}
	var paths []string
	for _, item := range s.buildDateIndex(manifests, generated).Items {
		paths = append(paths, item.Path)
	}
	if want := []string{"c.mp4", "A/z.jpg", "a.jpg", "b.jpg"}; !reflect.DeepEqual(paths, want) {
		t.Fatalf("order = %v, want %v", paths, want)
	}

	for i := range 5 {
		writeWarmTestJPEG(t, filepath.Join(root, fmt.Sprintf("dir%d", i), "photo.jpg"))
	}
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 3}); err != nil {
		t.Fatal(err)
	}
	firstRun, _ := s.readDateIndex()
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	secondRun, _ := s.readDateIndex()
	if !reflect.DeepEqual(firstRun.Items, secondRun.Items) {
		t.Fatalf("runs differ:\n%+v\n%+v", firstRun.Items, secondRun.Items)
	}
	if !sort.SliceIsSorted(secondRun.Items, func(i, j int) bool {
		a, b := secondRun.Items[i], secondRun.Items[j]
		return a.SortTime < b.SortTime || (a.SortTime == b.SortTime && a.Path < b.Path)
	}) {
		t.Fatalf("index is not ordered by sort time and path: %+v", secondRun.Items)
	}
}

func TestWarmCacheCancelledRunKeepsPreviousIndex(t *testing.T) {
	s, _, _ := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "first.jpg"))
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	previousIndex := readFileBytes(t, s.dateIndexPath())
	previousCache := decodeStatus(t, s).Cache
	for i := range 3 {
		writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, fmt.Sprintf("new-%d.jpg", i)))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := s.WarmCache(ctx, WarmOptions{Workers: 1, Progress: func(WarmStats) { cancel() }})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if got := readFileBytes(t, s.dateIndexPath()); string(got) != string(previousIndex) {
		t.Fatalf("cancelled run replaced the index:\n%s", got)
	}
	status := decodeStatus(t, s)
	if status.State != statusUnavailable || status.Run == nil || status.Run.State != runCancelled || status.Run.FinishedAt == nil {
		t.Fatalf("status: %+v run=%+v", status, status.Run)
	}
	if !reflect.DeepEqual(status.Cache, previousCache) {
		t.Fatalf("cache block = %+v, want previous %+v", status.Cache, previousCache)
	}
}

func TestWarmCacheFailedRunKeepsPreviousIndex(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	s, _, _ := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "first.jpg"))
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	previousIndex := readFileBytes(t, s.dateIndexPath())
	locked := filepath.Join(s.cfg.Root, "locked")
	writeWarmTestJPEG(t, filepath.Join(locked, "hidden-from-scan.jpg"))
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err == nil {
		t.Fatal("scan with an unreadable directory succeeded")
	}
	if got := readFileBytes(t, s.dateIndexPath()); string(got) != string(previousIndex) {
		t.Fatalf("failed run replaced the index:\n%s", got)
	}
	status := decodeStatus(t, s)
	if status.State != statusUnavailable || status.Run.State != runFailed || status.Cache == nil {
		t.Fatalf("status: %+v run=%+v", status, status.Run)
	}
	if len(status.RecentErrors) != 1 || status.RecentErrors[0].Operation != "walk" || status.RecentErrors[0].Path != "locked" {
		t.Fatalf("recent errors: %+v", status.RecentErrors)
	}
}

func TestDateIndexExcludesCacheDirectoryAndSymlinks(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "library")
	outside := filepath.Join(base, "outside")
	cache := filepath.Join(root, "cache")
	for _, dir := range []string{cache, outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s, err := New(Config{Root: root, Cache: cache, Title: "test", ThumbSize: 320}, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}})
	if err != nil {
		t.Fatal(err)
	}
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "photo.jpg"))
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "cache", "stray.jpg"))
	writeWarmTestJPEG(t, filepath.Join(outside, "secret.jpg"))
	symlinkFixture(t, filepath.Join(outside, "secret.jpg"), filepath.Join(s.cfg.Root, "linked.jpg"))
	symlinkFixture(t, outside, filepath.Join(s.cfg.Root, "linked-dir"))

	for range 2 {
		if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
			t.Fatal(err)
		}
	}
	index, ok := s.readDateIndex()
	if !ok || len(index.Items) != 1 || index.Items[0].Path != "photo.jpg" {
		t.Fatalf("index: %+v", index.Items)
	}
	if status := decodeStatus(t, s); status.Cache == nil || status.Cache.MediaFiles != 1 {
		t.Fatalf("cache status: %+v", status.Cache)
	}
}

func TestWarmStatusAndIndexContainNoAbsolutePaths(t *testing.T) {
	s, _, cache := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "ok.jpg"))
	writeBrokenJPEG(t, filepath.Join(s.cfg.Root, "sub", "broken.jpg"))

	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	body := getStatus(t, s, http.MethodGet).Body.String()
	artifacts := []string{body, string(readFileBytes(t, s.dateIndexPath())), string(readFileBytes(t, s.warmStatusPath()))}
	forbidden := append([]string{s.cfg.Root, filepath.Dir(s.cfg.Root)}, cachePathForms(cache)...)
	for _, artifact := range artifacts {
		for _, path := range forbidden {
			if strings.Contains(artifact, path) {
				t.Fatalf("artifact exposes %q:\n%s", path, artifact)
			}
		}
	}
	status := decodeStatus(t, s)
	if len(status.RecentErrors) != 1 {
		t.Fatalf("recent errors: %+v", status.RecentErrors)
	}
	if got := status.RecentErrors[0]; got.Operation != "thumbnail" || got.Path != "sub/broken.jpg" || got.Error == "" || got.At.IsZero() {
		t.Fatalf("recent error: %+v", got)
	}
}

func TestSanitizeWarmErrorStripsPathsAndBoundsText(t *testing.T) {
	root := "/srv/library"
	cache := []string{"/srv/cache"}
	pathErr := fmt.Errorf("wrapped: %w", &fs.PathError{Op: "open", Path: "/srv/library/a.jpg", Err: fs.ErrPermission})
	if got := sanitizeWarmError(pathErr, root, cache); got != "open: permission denied" {
		t.Fatalf("path error = %q", got)
	}
	plain := errors.New("cannot write /srv/cache/aa/x.jpg from /srv/library/b/c.jpg\nin /srv/library")
	if got := sanitizeWarmError(plain, root, cache); got != "cannot write <cache>/aa/x.jpg from b/c.jpg in ." {
		t.Fatalf("plain error = %q", got)
	}
	long := sanitizeWarmError(errors.New(strings.Repeat("ошибка ", 100)), root, cache)
	if n := len([]rune(long)); n != maxWarmErrorText || !strings.HasSuffix(long, "…") {
		t.Fatalf("long error has %d runes: %q", n, long)
	}
	if got := relativeMediaPath(root, "/srv/other/x.jpg"); got != "" {
		t.Fatalf("outside path = %q", got)
	}
}

func TestWarmStatusRunningThenReady(t *testing.T) {
	setStatusTiming(t, 0)
	s, _, _ := warmTestServer(t)
	for i := range 3 {
		writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, fmt.Sprintf("photo-%d.jpg", i)))
	}

	var observed []GalleryStatus
	_, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, Progress: func(stats WarmStats) {
		status := s.galleryStatus(time.Now())
		if status.Run == nil || status.Run.Processed != stats.Processed {
			t.Errorf("status lags progress: run=%+v stats=%+v", status.Run, stats)
		}
		observed = append(observed, status)
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(observed) != 3 {
		t.Fatalf("observed %d progress states", len(observed))
	}
	for i, status := range observed {
		run := status.Run
		if status.State != statusRunning || run.State != runRunning || run.Phase != "processing" || run.Total == nil || *run.Total != 3 || run.Progress == nil || run.FinishedAt != nil {
			t.Fatalf("progress %d: %+v run=%+v", i, status, run)
		}
		if want := float64(i+1) / 3; *run.Progress < want-0.0001 || *run.Progress > want+0.0001 {
			t.Fatalf("progress %d = %v, want %v", i, *run.Progress, want)
		}
	}
	final := decodeStatus(t, s)
	run := final.Run
	if final.State != statusReady || run.State != runSucceeded || run.Phase != "" || run.FinishedAt == nil || run.Progress == nil || *run.Progress != 1 {
		t.Fatalf("final: %+v run=%+v", final, run)
	}
	if run.Scanned != 3 || run.Processed != 3 || run.Generated != 3 || run.Skipped != 0 || run.Errors != 0 {
		t.Fatalf("final counters: %+v", run)
	}
}

func TestWarmStatusHeartbeatRefreshesUpdatedAt(t *testing.T) {
	setStatusTiming(t, time.Hour)
	warmStatusHeartbeat = 10 * time.Millisecond
	s, _, _ := warmTestServer(t)
	recorder := s.startWarmStatus(time.Now().Add(-time.Hour))
	recorder.mu.Lock()
	stale := recorder.file.Run.UpdatedAt.Add(-time.Hour)
	recorder.file.Run.UpdatedAt = stale
	_ = writeFileAtomic(recorder.path, []byte(`{"version":1}`))
	recorder.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for {
		file, ok := s.readWarmStatusFile()
		if ok && file.Run.UpdatedAt.After(stale) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("heartbeat did not refresh updatedAt")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := recorder.finish(runFailed, WarmStats{}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestStaleRunningStatusIsUnavailable(t *testing.T) {
	s, _, _ := warmTestServer(t)
	now := time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name    string
		updated time.Time
		state   string
		stale   bool
	}{
		{"fresh", now.Add(-warmStatusStaleAfter), statusRunning, false},
		{"stale", now.Add(-warmStatusStaleAfter - time.Second), statusUnavailable, true},
		{"future", now.Add(warmStatusStaleAfter + time.Second), statusUnavailable, true},
	} {
		writeStatusArtifact(t, s.warmStatusPath(), warmStatusFile{
			Version:      warmStatusVersion,
			Run:          WarmRunStatus{State: runRunning, Phase: "processing", StartedAt: now.Add(-time.Hour), UpdatedAt: test.updated},
			RecentErrors: []WarmError{},
		})
		status := s.galleryStatus(now)
		if status.State != test.state || status.Run == nil || status.Run.Stale != test.stale {
			t.Fatalf("%s: %+v run=%+v", test.name, status, status.Run)
		}
	}
}

func TestWarmCacheMinIntervalSkipKeepsReadyStatus(t *testing.T) {
	s, _, _ := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "photo.jpg"))
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	status := readFileBytes(t, s.warmStatusPath())
	index := readFileBytes(t, s.dateIndexPath())

	stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
	if err != nil || !stats.SkippedRecent {
		t.Fatalf("run was not skipped: %+v %v", stats, err)
	}
	if got := readFileBytes(t, s.warmStatusPath()); string(got) != string(status) {
		t.Fatalf("skipped run changed status:\n%s", got)
	}
	if got := readFileBytes(t, s.dateIndexPath()); string(got) != string(index) {
		t.Fatal("skipped run changed index")
	}
	if decodeStatus(t, s).State != statusReady {
		t.Fatal("ready status lost")
	}

	if err := os.Remove(s.dateIndexPath()); err != nil {
		t.Fatal(err)
	}
	stats, err = s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
	if err != nil || stats.SkippedRecent {
		t.Fatalf("missing index did not force a run: %+v %v", stats, err)
	}
	if _, ok := s.readDateIndex(); !ok {
		t.Fatal("index was not rebuilt")
	}
}

func TestWarmCacheLockContentionKeepsActiveStatus(t *testing.T) {
	s, _, cache := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "photo.jpg"))
	lock, err := acquireWarmLock(cache)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseWarmLock(lock)
	active := s.startWarmStatus(time.Now())
	defer active.finish(runCancelled, WarmStats{}, nil)
	active.update("processing", WarmStats{Media: 7, Processed: 3}, 7)
	active.mu.Lock()
	_ = active.writeLocked()
	before := readFileBytes(t, s.warmStatusPath())
	active.mu.Unlock()

	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); !errors.Is(err, ErrWarmCacheRunning) {
		t.Fatalf("err = %v", err)
	}
	active.mu.Lock()
	after := readFileBytes(t, s.warmStatusPath())
	active.mu.Unlock()
	if string(after) != string(before) {
		t.Fatalf("contending run changed active status:\n%s\n%s", before, after)
	}
	if _, err := os.Stat(s.dateIndexPath()); !os.IsNotExist(err) {
		t.Fatalf("contending run wrote an index: %v", err)
	}
	if status := decodeStatus(t, s); status.State != statusRunning || status.Run.Processed != 3 {
		t.Fatalf("active status: %+v run=%+v", status, status.Run)
	}
}

func TestWarmStatusRecentErrorsAreBounded(t *testing.T) {
	if maxRecentWarmErrors != 20 {
		t.Fatalf("recent error limit = %d, want 20", maxRecentWarmErrors)
	}
	s, _, _ := warmTestServer(t)
	for i := range 25 {
		writeBrokenJPEG(t, filepath.Join(s.cfg.Root, fmt.Sprintf("broken-%02d.jpg", i)))
	}
	stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	status := decodeStatus(t, s)
	if stats.Errors != 25 || status.Run.Errors != 25 || len(status.RecentErrors) != 20 || status.RecentErrorsLimit != 20 {
		t.Fatalf("errors: stats=%d run=%d recent=%d limit=%d", stats.Errors, status.Run.Errors, len(status.RecentErrors), status.RecentErrorsLimit)
	}
	seen := make(map[string]bool)
	for _, entry := range status.RecentErrors {
		if entry.Operation != "thumbnail" || !strings.HasPrefix(entry.Path, "broken-") || seen[entry.Path] {
			t.Fatalf("recent error: %+v", entry)
		}
		seen[entry.Path] = true
	}
}

func TestWarmStatusWholeCacheCounters(t *testing.T) {
	s, _, cache := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "a.jpg"))
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "b.jpg"))
	writeBrokenJPEG(t, filepath.Join(s.cfg.Root, "broken.jpg"))
	withPoster := filepath.Join(s.cfg.Root, "with-poster.mp4")
	for _, video := range []string{withPoster, filepath.Join(s.cfg.Root, "without-poster.avi")} {
		if err := os.WriteFile(video, []byte("video"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	info, err := os.Stat(withPoster)
	if err != nil {
		t.Fatal(err)
	}
	poster, _ := s.thumbnailCachePath(withPoster, info)
	writeWarmTestJPEG(t, poster)

	before := time.Now().Add(-time.Second)
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 2}); err != nil {
		t.Fatal(err)
	}
	got := decodeStatus(t, s).Cache
	if got == nil {
		t.Fatal("cache block missing")
	}
	want := CacheStatus{MediaFiles: 5, Images: 3, Videos: 2, ReadyThumbnails: 3, MissingThumbnails: 1, UnavailableThumbnails: 1, SizeBytes: got.SizeBytes, LastFullScanAt: got.LastFullScanAt}
	if *got != want {
		t.Fatalf("cache = %+v, want %+v", *got, want)
	}
	if got.ReadyThumbnails+got.MissingThumbnails+got.UnavailableThumbnails != got.MediaFiles {
		t.Fatalf("thumbnail counters do not add up: %+v", got)
	}
	if got.LastFullScanAt.Before(before.Truncate(time.Second)) || got.LastFullScanAt.After(time.Now()) {
		t.Fatalf("last full scan = %v", got.LastFullScanAt)
	}
	var thumbnails int64
	_ = filepath.WalkDir(cache, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && validCacheJPEG(cache, path) {
			info, _ := entry.Info()
			thumbnails += info.Size()
		}
		return nil
	})
	if thumbnails == 0 || got.SizeBytes < thumbnails || got.SizeBytes > cacheSizeBytes(cache) {
		t.Fatalf("size = %d, thumbnails = %d, cache now = %d", got.SizeBytes, thumbnails, cacheSizeBytes(cache))
	}
}

func TestGalleryStatusMissingOrInvalidArtifactsAreUnavailable(t *testing.T) {
	s, _, _ := warmTestServer(t)
	const unavailable = `{"version":1,"state":"unavailable","recentErrors":[],"recentErrorsLimit":20,"memories":{"state":"unavailable"}}` + "\n"
	cases := map[string]func(){
		"missing": func() {},
		"corrupt": func() {
			_ = writeFileAtomic(s.warmStatusPath(), []byte("{not json"))
			_ = writeFileAtomic(s.memoriesStatusPath(), []byte("{not json"))
		},
		"unknown version": func() {
			writeStatusArtifact(t, s.warmStatusPath(), map[string]any{"version": 99, "run": map[string]any{"state": "succeeded"}})
			writeStatusArtifact(t, s.memoriesStatusPath(), map[string]any{"version": 99, "state": "ready"})
		},
		"unknown state": func() {
			now := time.Now()
			writeStatusArtifact(t, s.warmStatusPath(), warmStatusFile{Version: warmStatusVersion, Run: WarmRunStatus{State: "paused", StartedAt: now, UpdatedAt: now}})
			writeStatusArtifact(t, s.memoriesStatusPath(), map[string]any{"version": 1, "state": "paused", "updatedAt": now})
		},
	}
	for name, setup := range cases {
		setup()
		response := getStatus(t, s, http.MethodGet)
		if response.Code != http.StatusOK || response.Body.String() != unavailable {
			t.Fatalf("%s: %d %s", name, response.Code, response.Body.String())
		}
	}

	_ = writeFileAtomic(s.dateIndexPath(), []byte("{not json"))
	if _, ok := s.readDateIndex(); ok {
		t.Fatal("corrupt index is available")
	}
	generated := time.Now()
	for _, index := range []dateIndex{
		{Version: 99, GeneratedAt: generated, Items: []dateIndexItem{}},
		{Version: dateIndexVersion, GeneratedAt: generated, Items: []dateIndexItem{{Path: "../escape.jpg", Kind: "image"}}},
		{Version: dateIndexVersion, GeneratedAt: generated, Items: []dateIndexItem{{Path: "/abs.jpg", Kind: "image"}}},
		{Version: dateIndexVersion, GeneratedAt: generated, Items: []dateIndexItem{{Path: "a.txt", Kind: "directory"}}},
	} {
		writeStatusArtifact(t, s.dateIndexPath(), index)
		if _, ok := s.readDateIndex(); ok {
			t.Fatalf("invalid index is available: %+v", index)
		}
	}
}

func TestMemoriesStatusContract(t *testing.T) {
	s, _, _ := warmTestServer(t)
	now := time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)
	if got := s.memoriesStatus(now); !reflect.DeepEqual(got, MemoriesStatus{State: statusUnavailable}) {
		t.Fatalf("missing memories status: %+v", got)
	}
	writeStatusArtifact(t, s.memoriesStatusPath(), map[string]any{
		"version": 1, "state": "ready", "updatedAt": now, "readyVersion": "dates-v1@2026-10-23T09:00:00Z",
		"readyAt": now, "periods": 4, "memories": 9, "shown": 6, "errors": 0,
	})
	ready := s.memoriesStatus(now)
	if ready.State != statusReady || ready.ReadyVersion == "" || *ready.Periods != 4 || *ready.Memories != 9 || *ready.Shown != 6 || *ready.Errors != 0 {
		t.Fatalf("ready memories: %+v", ready)
	}
	writeStatusArtifact(t, s.memoriesStatusPath(), map[string]any{"version": 1, "state": "running", "updatedAt": now.Add(-time.Hour)})
	if got := s.memoriesStatus(now); got.State != statusUnavailable {
		t.Fatalf("stale memories: %+v", got)
	}
}

func TestStatusEndpointMethodsAndSchema(t *testing.T) {
	s, _, _ := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "photo.jpg"))
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}

	get := getStatus(t, s, http.MethodGet)
	if get.Code != http.StatusOK || get.Header().Get("Content-Type") != "application/json; charset=utf-8" || get.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("GET: %d %v", get.Code, get.Header())
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(get.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	keys := func(object map[string]json.RawMessage) []string {
		var names []string
		for name := range object {
			names = append(names, name)
		}
		sort.Strings(names)
		return names
	}
	if got, want := keys(document), []string{"cache", "memories", "recentErrors", "recentErrorsLimit", "run", "state", "version"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("top-level keys = %v", got)
	}
	var run, cache map[string]json.RawMessage
	_ = json.Unmarshal(document["run"], &run)
	_ = json.Unmarshal(document["cache"], &cache)
	if got, want := keys(run), []string{"errors", "finishedAt", "generated", "processed", "progress", "scanned", "skipped", "startedAt", "state", "total", "updatedAt"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("run keys = %v", got)
	}
	if got, want := keys(cache), []string{"images", "lastFullScanAt", "mediaFiles", "missingThumbnails", "readyThumbnails", "sizeBytes", "unavailableThumbnails", "videos"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("cache keys = %v", got)
	}

	head := getStatus(t, s, http.MethodHead)
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Type") != get.Header().Get("Content-Type") || head.Header().Get("Content-Length") != fmt.Sprint(get.Body.Len()) {
		t.Fatalf("HEAD: %d %v body=%q", head.Code, head.Header(), head.Body.String())
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		response := getStatus(t, s, method)
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("%s: %d %v", method, response.Code, response.Header())
		}
	}
}

func TestWarmCacheMinIntervalSkipRequiresValidArtifacts(t *testing.T) {
	for _, test := range []struct {
		name    string
		corrupt func(s *Server)
	}{
		{"corrupt index", func(s *Server) { _ = writeFileAtomic(s.dateIndexPath(), []byte("{not json")) }},
		{"unknown index version", func(s *Server) {
			writeStatusArtifact(t, s.dateIndexPath(), dateIndex{Version: 99, GeneratedAt: time.Now(), Items: []dateIndexItem{}})
		}},
		{"missing status", func(s *Server) { _ = os.Remove(s.warmStatusPath()) }},
		{"corrupt status", func(s *Server) { _ = writeFileAtomic(s.warmStatusPath(), []byte("{not json")) }},
		{"unknown status version", func(s *Server) {
			file, _ := s.readWarmStatusFile()
			file.Version = 99
			writeStatusArtifact(t, s.warmStatusPath(), file)
		}},
		{"failed status", func(s *Server) {
			file, _ := s.readWarmStatusFile()
			file.Run.State = runFailed
			writeStatusArtifact(t, s.warmStatusPath(), file)
		}},
		{"missing cache block", func(s *Server) {
			file, _ := s.readWarmStatusFile()
			file.Cache = nil
			writeStatusArtifact(t, s.warmStatusPath(), file)
		}},
		{"invalid cache block", func(s *Server) {
			file, _ := s.readWarmStatusFile()
			file.Cache.ReadyThumbnails += 5
			writeStatusArtifact(t, s.warmStatusPath(), file)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, _ := warmTestServer(t)
			writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "photo.jpg"))
			if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
				t.Fatal(err)
			}
			test.corrupt(s)

			stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
			if err != nil || stats.SkippedRecent || stats.Media != 1 {
				t.Fatalf("run was skipped or failed: %+v %v", stats, err)
			}
			if index, ok := s.readDateIndex(); !ok || len(index.Items) != 1 || index.Items[0].Path != "photo.jpg" {
				t.Fatalf("index was not restored: %+v %v", index, ok)
			}
			if !s.warmArtifactsReady() {
				t.Fatal("status was not restored")
			}
			if status := decodeStatus(t, s); status.State != statusReady || status.Cache == nil || status.Cache.MediaFiles != 1 {
				t.Fatalf("status: %+v cache=%+v", status, status.Cache)
			}
		})
	}
}

func TestWarmCacheMinIntervalSkipsWithValidArtifacts(t *testing.T) {
	s, _, cache := warmTestServer(t)
	writeWarmTestJPEG(t, filepath.Join(s.cfg.Root, "photo.jpg"))
	if _, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1}); err != nil {
		t.Fatal(err)
	}
	stamp := filepath.Join(cache, ".warm-success")
	paths := []string{s.dateIndexPath(), s.warmStatusPath(), stamp}
	before := make(map[string][]byte)
	modTimes := make(map[string]time.Time)
	for _, path := range paths {
		before[path] = readFileBytes(t, path)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		modTimes[path] = info.ModTime()
	}

	stats, err := s.WarmCache(context.Background(), WarmOptions{Workers: 1, MinInterval: 24 * time.Hour})
	if err != nil || !stats.SkippedRecent || stats.Media != 0 {
		t.Fatalf("run was not skipped: %+v %v", stats, err)
	}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := readFileBytes(t, path); string(got) != string(before[path]) || !info.ModTime().Equal(modTimes[path]) {
			t.Fatalf("skipped run changed %s", filepath.Base(path))
		}
	}
}
