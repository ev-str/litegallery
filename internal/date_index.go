package internal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const dateIndexVersion = 1

// dateIndexItem is one supported media file. SortTime is the cached capture
// time when known (Captured is then true), otherwise the file creation time
// with the modification-time fallback used by /api/list. Size and ModifiedNS
// are the version key: an item is current while both still match the file.
type dateIndexItem struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	SortTime   int64  `json:"sortTime"`
	Captured   bool   `json:"captured,omitempty"`
	Size       int64  `json:"size"`
	ModifiedNS int64  `json:"modifiedNs"`
}

type dateIndex struct {
	Version     int             `json:"version"`
	GeneratedAt time.Time       `json:"generatedAt"`
	Items       []dateIndexItem `json:"items"`
}

func (s *Server) dateIndexPath() string {
	return filepath.Join(s.cfg.Cache, "index", "dates-v1.json")
}

// buildDateIndex orders items by sort time, then by relative path, so equal
// libraries always produce the same item order; generatedAt changes per run.
func (s *Server) buildDateIndex(manifests map[string]metadataManifest, generatedAt time.Time) dateIndex {
	items := make([]dateIndexItem, 0)
	for directory, manifest := range manifests {
		for name, record := range manifest.Files {
			rel := relativeMediaPath(s.cfg.Root, filepath.Join(directory, name))
			if rel == "" || rel == "." {
				continue
			}
			item := dateIndexItem{Path: rel, Kind: record.Kind, SortTime: record.Created, Size: record.Size, ModifiedNS: record.ModifiedNS}
			if record.Captured != 0 {
				item.SortTime = record.Captured
				item.Captured = true
			}
			items = append(items, item)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].SortTime != items[j].SortTime {
			return items[i].SortTime < items[j].SortTime
		}
		return items[i].Path < items[j].Path
	})
	return dateIndex{Version: dateIndexVersion, GeneratedAt: statusTime(generatedAt), Items: items}
}

func (s *Server) writeDateIndex(index dateIndex) error {
	data, err := json.Marshal(index)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.dateIndexPath(), data)
}

// readDateIndex treats a missing, corrupt, or unknown-version index as
// unavailable.
func (s *Server) readDateIndex() (dateIndex, bool) {
	data, err := os.ReadFile(s.dateIndexPath())
	if err != nil {
		return dateIndex{}, false
	}
	var index dateIndex
	if json.Unmarshal(data, &index) != nil || index.Version != dateIndexVersion || index.Items == nil || index.GeneratedAt.IsZero() {
		return dateIndex{}, false
	}
	for _, item := range index.Items {
		if (item.Kind != "image" && item.Kind != "video") || !safeRelativePath(item.Path) || item.Size < 0 {
			return dateIndex{}, false
		}
	}
	return index, true
}

func safeRelativePath(path string) bool {
	return path != "" && path != "." && !strings.HasPrefix(path, "/") && !strings.ContainsRune(path, 0) &&
		path != ".." && !strings.HasPrefix(path, "../") && !strings.Contains(path, "/../") && !strings.HasSuffix(path, "/..")
}
