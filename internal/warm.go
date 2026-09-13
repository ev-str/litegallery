package internal

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

var ErrWarmCacheRunning = errors.New("cache warming is already running")

type WarmOptions struct {
	Workers     int
	Prune       bool
	PruneAfter  time.Duration
	MinInterval time.Duration
	Progress    func(WarmStats)
	OnError     func(operation, path string, err error)
}

type WarmStats struct {
	Media         int
	Images        int
	Videos        int
	Processed     int
	Generated     int
	Skipped       int
	Errors        int
	Pruned        int
	SkippedRecent bool
	Duration      time.Duration
}

type warmJob struct {
	source         string
	cache          string
	kind           string
	thumbnail      bool
	metadataNeeded bool
}

type warmResult struct {
	source          string
	operation       string
	generated       bool
	err             error
	captured        int64
	metadataChecked bool
	metadataErr     error
}

func (s *Server) WarmCache(ctx context.Context, options WarmOptions) (stats WarmStats, err error) {
	started := time.Now()
	defer func() { stats.Duration = time.Since(started) }()
	if options.Workers < 1 {
		options.Workers = 1
	}

	lock, err := acquireWarmLock(s.cfg.Cache)
	if err != nil {
		return stats, err
	}
	defer releaseWarmLock(lock)

	stamp := filepath.Join(s.cfg.Cache, ".warm-success")
	if options.MinInterval > 0 {
		if info, statErr := os.Stat(stamp); statErr == nil && time.Since(info.ModTime()) < options.MinInterval {
			stats.SkippedRecent = true
			return stats, nil
		}
	}

	live := make(map[string]struct{})
	jobs := make([]warmJob, 0, 1024)
	manifests := make(map[string]metadataManifest)
	cachedManifests := make(map[string]metadataManifest)
	scanErrors := 0
	cacheRoot, err := filepath.Abs(s.cfg.Cache)
	if err != nil {
		return stats, err
	}
	if realCacheRoot, evalErr := filepath.EvalSymlinks(cacheRoot); evalErr == nil {
		cacheRoot = realCacheRoot
	}
	cacheRoot = filepath.Clean(cacheRoot)
	if cacheRoot == filepath.Clean(s.cfg.Root) {
		return stats, errors.New("cache directory cannot be the photo library root")
	}
	err = filepath.WalkDir(s.cfg.Root, func(path string, entry fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if walkErr != nil {
			scanErrors++
			reportWarmError(options, "walk", path, walkErr)
			return nil
		}
		if entry.IsDir() && filepath.Clean(path) == cacheRoot {
			return filepath.SkipDir
		}
		if path != s.cfg.Root && hidden(entry.Name()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		kind := mediaKind(entry.Name())
		if kind == "" {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			scanErrors++
			reportWarmError(options, "stat", path, infoErr)
			return nil
		}
		if !info.Mode().IsRegular() {
			scanErrors++
			reportWarmError(options, "stat", path, errors.New("not a regular file"))
			return nil
		}
		cached, _ := s.thumbnailCachePath(path, info)
		live[filepath.Clean(cached)] = struct{}{}
		directory := filepath.Dir(path)
		manifest, exists := manifests[directory]
		if !exists {
			manifest = metadataManifest{Version: metadataManifestVersion, Files: make(map[string]metadataFileRecord)}
			cachedManifests[directory] = s.readMetadataManifest(directory)
		}
		record := metadataFileRecord{Kind: kind, Size: info.Size(), ModifiedNS: info.ModTime().UnixNano(), Created: fileCreatedUnix(info)}
		metadataNeeded := kind == "image" || (kind == "video" && supportsVideoCaptureTime(path))
		if cachedRecord, ok := cachedManifests[directory].Files[entry.Name()]; ok && cachedRecord.matches(kind, info) {
			record.Captured = cachedRecord.Captured
			record.VideoDateChecked = cachedRecord.VideoDateChecked
			if kind == "image" || cachedRecord.VideoDateChecked {
				metadataNeeded = false
			}
		}
		manifest.Files[entry.Name()] = record
		manifests[directory] = manifest
		live[filepath.Clean(s.metadataManifestPath(directory))] = struct{}{}
		stats.Media++
		if kind == "video" {
			stats.Videos++
			if metadataNeeded {
				jobs = append(jobs, warmJob{source: path, kind: kind, metadataNeeded: true})
			}
			return nil
		}
		stats.Images++
		jobs = append(jobs, warmJob{source: path, cache: cached, kind: kind, thumbnail: true, metadataNeeded: metadataNeeded})
		return nil
	})
	if err != nil {
		return stats, err
	}
	stats.Errors += scanErrors
	if stats.Media == 0 {
		return stats, errors.New("no media found; refusing to mark the scan successful or prune the cache")
	}

	results := make(chan warmResult)
	work := make(chan warmJob)
	var workers sync.WaitGroup
	for range options.Workers {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range work {
				result := warmResult{source: job.source}
				if ctx.Err() != nil {
					result.operation = "thumbnail"
					result.err = ctx.Err()
					results <- result
					continue
				}
				if !job.thumbnail {
					// Video posters remain browser-generated.
				} else if _, statErr := os.Stat(job.cache); statErr == nil {
					// The thumbnail is already warm.
				} else if !errors.Is(statErr, os.ErrNotExist) {
					result.operation = "cache-stat"
					result.err = statErr
				} else {
					makeErr := makeThumbnail(job.source, job.cache, s.cfg.ThumbSize)
					result.operation = "thumbnail"
					result.generated = makeErr == nil
					result.err = makeErr
				}
				if job.metadataNeeded {
					if job.kind == "video" {
						captured, metadataErr := readVideoCaptureTime(job.source)
						result.metadataErr = metadataErr
						result.metadataChecked = metadataErr == nil
						if !captured.IsZero() {
							result.captured = captured.Unix()
						}
					} else {
						metadata, metadataErr := readPhotoMetadata(job.source)
						result.metadataErr = metadataErr
						if metadataErr == nil && !metadata.capturedTime.IsZero() {
							result.captured = metadata.capturedTime.Unix()
						}
					}
				}
				results <- result
			}
		}()
	}
	go func() {
		defer close(work)
		for _, job := range jobs {
			select {
			case work <- job:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		workers.Wait()
		close(results)
	}()
	for result := range results {
		stats.Processed++
		if result.err != nil {
			stats.Errors++
			if !errors.Is(result.err, context.Canceled) {
				reportWarmError(options, result.operation, result.source, result.err)
			}
		} else if !supportsVideoCaptureTime(result.source) && result.generated {
			stats.Generated++
		} else if !supportsVideoCaptureTime(result.source) {
			stats.Skipped++
		}
		if result.metadataErr != nil {
			stats.Errors++
			reportWarmError(options, "metadata", result.source, result.metadataErr)
		}
		if result.captured != 0 || result.metadataChecked {
			directory := filepath.Dir(result.source)
			manifest := manifests[directory]
			record := manifest.Files[filepath.Base(result.source)]
			record.Captured = result.captured
			if record.Kind == "video" && result.metadataChecked {
				record.VideoDateChecked = true
			}
			manifest.Files[filepath.Base(result.source)] = record
			manifests[directory] = manifest
		}
		if options.Progress != nil {
			options.Progress(stats)
		}
	}
	if ctx.Err() != nil {
		return stats, ctx.Err()
	}
	if scanErrors > 0 {
		return stats, fmt.Errorf("scan completed with %d filesystem errors; refusing to prune", scanErrors)
	}
	for directory, manifest := range manifests {
		if err := s.writeMetadataManifest(directory, manifest); err != nil {
			stats.Errors++
			reportWarmError(options, "metadata-cache", directory, err)
			return stats, fmt.Errorf("write metadata cache for %q: %w", directory, err)
		}
	}

	if options.Prune {
		stats.Pruned, err = pruneCache(s.cfg.Cache, live, options.PruneAfter, time.Now())
		if err != nil {
			return stats, err
		}
	}
	if err := writeWarmStamp(stamp); err != nil {
		return stats, err
	}
	return stats, nil
}

func reportWarmError(options WarmOptions, operation, path string, err error) {
	if options.OnError != nil && err != nil {
		options.OnError(operation, path, err)
	}
}

func acquireWarmLock(cache string) (*os.File, error) {
	lock, err := os.OpenFile(filepath.Join(cache, ".warm.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrWarmCacheRunning
		}
		return nil, err
	}
	return lock, nil
}

func releaseWarmLock(lock *os.File) {
	_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	_ = lock.Close()
}

func pruneCache(cache string, live map[string]struct{}, minimumAge time.Duration, now time.Time) (int, error) {
	pruned := 0
	err := filepath.WalkDir(cache, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || (!validCacheJPEG(cache, path) && !validMetadataManifest(cache, path)) {
			return nil
		}
		if _, ok := live[filepath.Clean(path)]; ok {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if minimumAge > 0 && now.Sub(info.ModTime()) < minimumAge {
			return nil
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		pruned++
		return nil
	})
	return pruned, err
}

func validCacheJPEG(cache, path string) bool {
	rel, err := filepath.Rel(cache, path)
	if err != nil {
		return false
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != 2 || len(parts[0]) != 2 || filepath.Ext(parts[1]) != ".jpg" {
		return false
	}
	key := strings.TrimSuffix(parts[1], ".jpg")
	if len(key) != 64 || parts[0] != key[:2] {
		return false
	}
	_, err = hex.DecodeString(key)
	return err == nil
}

func writeWarmStamp(destination string) error {
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".warm-success-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := fmt.Fprintln(tmp, time.Now().Format(time.RFC3339)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, destination)
}
