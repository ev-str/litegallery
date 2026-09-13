package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"photoview/internal"
)

//go:embed web/*
var webFiles embed.FS

func main() {
	var cfg internal.Config
	var warmCache bool
	var pruneCache bool
	var warmWorkers int
	var pruneAfter time.Duration
	var minInterval time.Duration
	flag.StringVar(&cfg.Root, "root", "", "photo library root (required)")
	flag.StringVar(&cfg.Cache, "cache", "./cache", "thumbnail cache directory")
	flag.StringVar(&cfg.Listen, "listen", "127.0.0.1:8090", "HTTP listen address")
	flag.StringVar(&cfg.Title, "title", "Gallery", "page title")
	flag.IntVar(&cfg.ThumbSize, "thumb-size", 480, "maximum thumbnail side in pixels")
	flag.BoolVar(&warmCache, "warm-cache", false, "generate missing thumbnails, then exit")
	flag.BoolVar(&pruneCache, "prune-cache", false, "remove stale cache entries after a successful warm scan")
	flag.IntVar(&warmWorkers, "workers", 1, "thumbnail workers used by -warm-cache")
	flag.DurationVar(&pruneAfter, "prune-after", 168*time.Hour, "minimum age of stale cache entries before removal")
	flag.DurationVar(&minInterval, "min-interval", 24*time.Hour, "skip warming when the previous successful scan is newer than this")
	flag.Parse()

	if cfg.Root == "" {
		log.Fatal("-root is required")
	}
	root, err := filepath.Abs(cfg.Root)
	if err != nil {
		log.Fatalf("resolve root: %v", err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		log.Fatalf("open root: %v", err)
	}
	cfg.Root = root
	if cfg.ThumbSize < 128 || cfg.ThumbSize > 1600 {
		log.Fatal("-thumb-size must be between 128 and 1600")
	}
	if warmWorkers < 1 || warmWorkers > 16 {
		log.Fatal("-workers must be between 1 and 16")
	}
	if pruneAfter < 0 || minInterval < 0 {
		log.Fatal("-prune-after and -min-interval cannot be negative")
	}
	if pruneCache && !warmCache {
		log.Fatal("-prune-cache requires -warm-cache")
	}
	if err := os.MkdirAll(cfg.Cache, 0o755); err != nil {
		log.Fatalf("create cache: %v", err)
	}

	web, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	app, err := internal.New(cfg, web)
	if err != nil {
		log.Fatal(err)
	}
	if warmCache {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		lastReport := time.Now()
		stats, err := app.WarmCache(ctx, internal.WarmOptions{
			Workers:     warmWorkers,
			Prune:       pruneCache,
			PruneAfter:  pruneAfter,
			MinInterval: minInterval,
			OnError: func(operation, path string, err error) {
				log.Printf("Cache warming error: operation=%s path=%q error=%q", operation, path, err.Error())
			},
			Progress: func(stats internal.WarmStats) {
				if time.Since(lastReport) >= time.Minute {
					log.Printf("Cache warming: processed=%d generated=%d skipped=%d errors=%d", stats.Processed, stats.Generated, stats.Skipped, stats.Errors)
					lastReport = time.Now()
				}
			},
		})
		if errors.Is(err, internal.ErrWarmCacheRunning) {
			log.Print("Cache warming is already running; skipping")
			return
		}
		if err != nil {
			log.Fatalf("warm cache: %v", err)
		}
		if stats.SkippedRecent {
			log.Print("Cache warming skipped: a successful scan ran recently")
			return
		}
		log.Printf("Cache warming complete: media=%d images=%d videos=%d generated=%d skipped=%d errors=%d pruned=%d duration=%s", stats.Media, stats.Images, stats.Videos, stats.Generated, stats.Skipped, stats.Errors, stats.Pruned, stats.Duration.Round(time.Second))
		return
	}

	httpServer := &http.Server{
		Addr:              cfg.Listen,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	go func() {
		log.Printf("Gallery listening on http://%s (root %s)", cfg.Listen, cfg.Root)
		if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "shutdown: %v\n", err)
	}
}
