package internal

import (
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	galleryStatusVersion  = 1
	warmStatusVersion     = 1
	memoriesStatusVersion = 1
	maxRecentWarmErrors   = 20
	maxWarmErrorText      = 200
)

// Public gallery states.
const (
	statusRunning     = "running"
	statusReady       = "ready"
	statusUnavailable = "unavailable"
)

// Warm run outcomes stored in the status artifact.
const (
	runRunning   = "running"
	runSucceeded = "succeeded"
	runFailed    = "failed"
	runCancelled = "cancelled"
)

var (
	// warmStatusHeartbeat refreshes updatedAt while a run is alive, even when
	// a single slow file produces no progress.
	warmStatusHeartbeat = 5 * time.Second
	// warmStatusWriteInterval throttles progress writes between heartbeats.
	warmStatusWriteInterval = time.Second
	// warmStatusStaleAfter turns a running status without updates into
	// unavailable, so a killed warmer never stays running forever.
	warmStatusStaleAfter = 2 * time.Minute
)

type WarmRunStatus struct {
	State      string     `json:"state"`
	Phase      string     `json:"phase,omitempty"`
	StartedAt  time.Time  `json:"startedAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Scanned    int        `json:"scanned"`
	Processed  int        `json:"processed"`
	Generated  int        `json:"generated"`
	Skipped    int        `json:"skipped"`
	Errors     int        `json:"errors"`
	Total      *int       `json:"total,omitempty"`
	Progress   *float64   `json:"progress,omitempty"`
	Stale      bool       `json:"stale,omitempty"`
}

type CacheStatus struct {
	MediaFiles            int       `json:"mediaFiles"`
	Images                int       `json:"images"`
	Videos                int       `json:"videos"`
	ReadyThumbnails       int       `json:"readyThumbnails"`
	MissingThumbnails     int       `json:"missingThumbnails"`
	UnavailableThumbnails int       `json:"unavailableThumbnails"`
	SizeBytes             int64     `json:"sizeBytes"`
	LastFullScanAt        time.Time `json:"lastFullScanAt"`
}

type WarmError struct {
	At        time.Time `json:"at"`
	Operation string    `json:"operation"`
	Path      string    `json:"path"`
	Error     string    `json:"error"`
}

// MemoriesStatus is published by the memories builder after each date index
// build. Counters stay absent until a builder reports them.
type MemoriesStatus struct {
	State        string     `json:"state"`
	UpdatedAt    *time.Time `json:"updatedAt,omitempty"`
	ReadyVersion string     `json:"readyVersion,omitempty"`
	ReadyAt      *time.Time `json:"readyAt,omitempty"`
	Periods      *int       `json:"periods,omitempty"`
	Memories     *int       `json:"memories,omitempty"`
	Shown        *int       `json:"shown,omitempty"`
	Errors       *int       `json:"errors,omitempty"`
}

type GalleryStatus struct {
	Version           int            `json:"version"`
	State             string         `json:"state"`
	Run               *WarmRunStatus `json:"run,omitempty"`
	Cache             *CacheStatus   `json:"cache,omitempty"`
	RecentErrors      []WarmError    `json:"recentErrors"`
	RecentErrorsLimit int            `json:"recentErrorsLimit"`
	Memories          MemoriesStatus `json:"memories"`
}

type warmStatusFile struct {
	Version      int           `json:"version"`
	Run          WarmRunStatus `json:"run"`
	Cache        *CacheStatus  `json:"cache,omitempty"`
	RecentErrors []WarmError   `json:"recentErrors"`
}

type memoriesStatusFile struct {
	Version int `json:"version"`
	MemoriesStatus
}

func (s *Server) warmStatusPath() string {
	return filepath.Join(s.cfg.Cache, "status", "warm-v1.json")
}

func (s *Server) memoriesStatusPath() string {
	return filepath.Join(s.cfg.Cache, "status", "memories-v1.json")
}

func statusTime(t time.Time) time.Time {
	return t.UTC().Truncate(time.Second)
}

func (run *WarmRunStatus) setCounters(stats WarmStats) {
	run.Scanned = stats.Media
	run.Processed = stats.Processed
	run.Generated = stats.Generated
	run.Skipped = stats.Skipped
	run.Errors = stats.Errors
}

func writeJSONAtomic(destination string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeFileAtomic(destination, data)
}

// readJSONFile reports false for a missing or unreadable file and for invalid JSON.
func readJSONFile(path string, value any) bool {
	data, err := os.ReadFile(path)
	return err == nil && json.Unmarshal(data, value) == nil
}

func writeFileAtomic(destination string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), "."+filepath.Base(destination)+"-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, destination)
}

// warmStatusRecorder owns the warm status artifact for one run. Writes are
// serialised by mu; a heartbeat keeps updatedAt fresh until finish.
type warmStatusRecorder struct {
	path      string
	root      string
	cache     []string
	mu        sync.Mutex
	file      warmStatusFile
	lastWrite time.Time
	finished  bool
	stop      chan struct{}
	done      chan struct{}
}

// startWarmStatus publishes a running status that keeps the previous
// whole-cache block until the new run succeeds.
func (s *Server) startWarmStatus(started time.Time) *warmStatusRecorder {
	recorder := &warmStatusRecorder{
		path:  s.warmStatusPath(),
		root:  s.cfg.Root,
		cache: cachePathForms(s.cfg.Cache),
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
	}
	recorder.file = warmStatusFile{
		Version:      warmStatusVersion,
		Run:          WarmRunStatus{State: runRunning, Phase: "scanning", StartedAt: statusTime(started)},
		RecentErrors: []WarmError{},
	}
	if previous, ok := s.readWarmStatusFile(); ok {
		recorder.file.Cache = previous.Cache
	}
	recorder.mu.Lock()
	_ = recorder.writeLocked()
	recorder.mu.Unlock()
	go recorder.heartbeat(warmStatusHeartbeat)
	return recorder
}

func (r *warmStatusRecorder) heartbeat(interval time.Duration) {
	defer close(r.done)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-ticker.C:
			r.mu.Lock()
			if !r.finished {
				_ = r.writeLocked()
			}
			r.mu.Unlock()
		}
	}
}

func (r *warmStatusRecorder) writeLocked() error {
	run := &r.file.Run
	run.UpdatedAt = statusTime(time.Now())
	run.Progress = nil
	if run.Total != nil && *run.Total > 0 {
		progress := math.Round(math.Min(1, float64(run.Processed)/float64(*run.Total))*10000) / 10000
		run.Progress = &progress
	}
	if err := writeJSONAtomic(r.path, r.file); err != nil {
		return err
	}
	r.lastWrite = time.Now()
	return nil
}

func (r *warmStatusRecorder) update(phase string, stats WarmStats, total int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.finished {
		return
	}
	run := &r.file.Run
	run.Phase = phase
	run.setCounters(stats)
	if total >= 0 {
		run.Total = &total
	}
	if time.Since(r.lastWrite) >= warmStatusWriteInterval {
		_ = r.writeLocked()
	}
}

func (r *warmStatusRecorder) recordError(operation, path string, err error) {
	entry := WarmError{
		At:        statusTime(time.Now()),
		Operation: operation,
		Path:      relativeMediaPath(r.root, path),
		Error:     sanitizeWarmError(err, r.root, r.cache),
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.finished {
		return
	}
	r.file.RecentErrors = append(r.file.RecentErrors, entry)
	if extra := len(r.file.RecentErrors) - maxRecentWarmErrors; extra > 0 {
		r.file.RecentErrors = append([]WarmError(nil), r.file.RecentErrors[extra:]...)
	}
}

// finish publishes the final run state once. A non-nil cache replaces the
// whole-cache block; it is set only by a successful full scan.
func (r *warmStatusRecorder) finish(state string, stats WarmStats, cache *CacheStatus) error {
	r.mu.Lock()
	if r.finished {
		r.mu.Unlock()
		return nil
	}
	r.finished = true
	r.mu.Unlock()
	close(r.stop)
	<-r.done

	r.mu.Lock()
	defer r.mu.Unlock()
	run := &r.file.Run
	run.State = state
	run.Phase = ""
	run.setCounters(stats)
	finished := statusTime(time.Now())
	run.FinishedAt = &finished
	if cache != nil {
		r.file.Cache = cache
	}
	return r.writeLocked()
}

func relativeMediaPath(root, path string) string {
	if path == "" {
		return ""
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	return filepath.ToSlash(rel)
}

func cachePathForms(cache string) []string {
	forms := []string{filepath.Clean(cache)}
	if abs, err := filepath.Abs(cache); err == nil {
		forms = append(forms, abs)
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			forms = append(forms, real)
		}
	}
	return forms
}

// sanitizeWarmError keeps the failure reason short and strips the library
// root and cache directory from it.
func sanitizeWarmError(err error, root string, cache []string) string {
	if err == nil {
		return ""
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		parts := make([]string, 0, len(joined.Unwrap()))
		for _, part := range joined.Unwrap() {
			if text := sanitizeWarmError(part, root, cache); text != "" {
				parts = append(parts, text)
			}
		}
		err = errors.New(strings.Join(parts, "; "))
	}
	text := err.Error()
	var pathErr *fs.PathError
	var linkErr *os.LinkError
	if errors.As(err, &pathErr) {
		text = pathErr.Op + ": " + pathErr.Err.Error()
	} else if errors.As(err, &linkErr) {
		text = linkErr.Op + ": " + linkErr.Err.Error()
	}
	type replacement struct{ from, to string }
	replacements := []replacement{{root + string(filepath.Separator), ""}, {root, "."}}
	for _, form := range cache {
		if form != "." && form != "" {
			replacements = append(replacements, replacement{form, "<cache>"})
		}
	}
	sort.SliceStable(replacements, func(i, j int) bool { return len(replacements[i].from) > len(replacements[j].from) })
	for _, item := range replacements {
		text = strings.ReplaceAll(text, item.from, item.to)
	}
	text = strings.Join(strings.Fields(text), " ")
	if runes := []rune(text); len(runes) > maxWarmErrorText {
		text = string(runes[:maxWarmErrorText-1]) + "…"
	}
	return text
}

func cacheSizeBytes(cache string) int64 {
	var size int64
	_ = filepath.WalkDir(cache, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return nil
		}
		if info, infoErr := entry.Info(); infoErr == nil {
			size += info.Size()
		}
		return nil
	})
	return size
}

func (s *Server) readWarmStatusFile() (warmStatusFile, bool) {
	var file warmStatusFile
	if !readJSONFile(s.warmStatusPath(), &file) || file.Version != warmStatusVersion {
		return warmStatusFile{}, false
	}
	run := file.Run
	switch run.State {
	case runRunning, runSucceeded, runFailed, runCancelled:
	default:
		return warmStatusFile{}, false
	}
	if run.StartedAt.IsZero() || run.UpdatedAt.IsZero() || run.Scanned < 0 || run.Processed < 0 || run.Generated < 0 || run.Skipped < 0 || run.Errors < 0 {
		return warmStatusFile{}, false
	}
	if file.Cache != nil && !validCacheStatus(*file.Cache) {
		file.Cache = nil
	}
	errorsList := make([]WarmError, 0, len(file.RecentErrors))
	for _, entry := range file.RecentErrors {
		if entry.Path == "" || safeRelativePath(entry.Path) {
			errorsList = append(errorsList, entry)
		}
	}
	if extra := len(errorsList) - maxRecentWarmErrors; extra > 0 {
		errorsList = errorsList[extra:]
	}
	file.RecentErrors = errorsList
	return file, true
}

func validCacheStatus(cache CacheStatus) bool {
	return cache.MediaFiles >= 0 && cache.Images >= 0 && cache.Videos >= 0 &&
		cache.ReadyThumbnails >= 0 && cache.MissingThumbnails >= 0 && cache.UnavailableThumbnails >= 0 &&
		cache.Images+cache.Videos == cache.MediaFiles &&
		cache.ReadyThumbnails+cache.MissingThumbnails+cache.UnavailableThumbnails == cache.MediaFiles &&
		cache.SizeBytes >= 0 && !cache.LastFullScanAt.IsZero()
}

// warmArtifactsReady reports whether a min-interval skip may keep the current
// artifacts as one consistent set: a valid date index, a memories artifact
// built from that index, a ready memories status for that artifact, and a
// succeeded warm status with a valid cache block.
func (s *Server) warmArtifactsReady() bool {
	index, ok := s.readDateIndex()
	if !ok {
		return false
	}
	memories, ok := s.readMemoriesArtifact()
	if !ok || memories.DateIndexVersion != index.Version || !memories.DateIndexGeneratedAt.Equal(index.GeneratedAt) {
		return false
	}
	memoriesStatus, ok := s.readMemoriesStatusFile()
	if !ok || memoriesStatus.State != statusReady || memoriesStatus.ReadyVersion != memories.Revision ||
		memoriesStatus.ReadyAt == nil || !memoriesStatus.ReadyAt.Equal(memories.GeneratedAt) {
		return false
	}
	status, ok := s.readWarmStatusFile()
	return ok && status.Run.State == runSucceeded && status.Cache != nil && validCacheStatus(*status.Cache)
}

func fresh(now, updated time.Time) bool {
	age := now.Sub(updated)
	return age <= warmStatusStaleAfter && age >= -warmStatusStaleAfter
}

func (s *Server) readMemoriesStatusFile() (memoriesStatusFile, bool) {
	var file memoriesStatusFile
	if !readJSONFile(s.memoriesStatusPath(), &file) || file.Version != memoriesStatusVersion || file.UpdatedAt == nil {
		return memoriesStatusFile{}, false
	}
	for _, counter := range []*int{file.Periods, file.Memories, file.Shown, file.Errors} {
		if counter != nil && *counter < 0 {
			return memoriesStatusFile{}, false
		}
	}
	switch file.State {
	case statusRunning, statusReady, runFailed:
	default:
		return memoriesStatusFile{}, false
	}
	return file, true
}

func (s *Server) memoriesStatus(now time.Time) MemoriesStatus {
	file, ok := s.readMemoriesStatusFile()
	if !ok {
		return MemoriesStatus{State: statusUnavailable}
	}
	status := file.MemoriesStatus
	switch status.State {
	case statusRunning:
		if !fresh(now, *status.UpdatedAt) {
			status.State = statusUnavailable
		}
	case runFailed:
		status.State = statusUnavailable
	}
	return status
}

// galleryStatus never fails: a missing or invalid artifact yields the
// unavailable contract.
func (s *Server) galleryStatus(now time.Time) GalleryStatus {
	status := GalleryStatus{
		Version:           galleryStatusVersion,
		State:             statusUnavailable,
		RecentErrors:      []WarmError{},
		RecentErrorsLimit: maxRecentWarmErrors,
		Memories:          s.memoriesStatus(now),
	}
	file, ok := s.readWarmStatusFile()
	if !ok {
		return status
	}
	run := file.Run
	status.Run = &run
	status.Cache = file.Cache
	status.RecentErrors = file.RecentErrors
	switch run.State {
	case runRunning:
		if fresh(now, run.UpdatedAt) {
			status.State = statusRunning
		} else {
			run.Stale = true
		}
	case runSucceeded:
		status.State = statusReady
	}
	return status
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeNoStoreJSON(w, r, func() any { return s.galleryStatus(time.Now()) })
}

// writeNoStoreJSON serves a read-only GET/HEAD JSON document.
func writeNoStoreJSON(w http.ResponseWriter, r *http.Request, value func() any) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := json.Marshal(value())
	if err != nil {
		http.Error(w, "cannot encode response", http.StatusInternalServerError)
		return
	}
	data = append(data, '\n')
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}
