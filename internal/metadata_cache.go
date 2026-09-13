package internal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const metadataManifestVersion = 2

type metadataFileRecord struct {
	Kind             string `json:"kind"`
	Size             int64  `json:"size"`
	ModifiedNS       int64  `json:"modifiedNs"`
	Created          int64  `json:"created"`
	Captured         int64  `json:"captured,omitempty"`
	VideoDateChecked bool   `json:"videoDateChecked,omitempty"`
}

type metadataManifest struct {
	Version int                           `json:"version"`
	Files   map[string]metadataFileRecord `json:"files"`
}

func (record metadataFileRecord) matches(kind string, info os.FileInfo) bool {
	return record.Kind == kind && record.Size == info.Size() && record.ModifiedNS == info.ModTime().UnixNano()
}

func (s *Server) metadataManifestPath(directory string) string {
	keyBytes := sha256.Sum256([]byte(filepath.Clean(directory)))
	key := hex.EncodeToString(keyBytes[:])
	return filepath.Join(s.cfg.Cache, "metadata", key[:2], key+".json")
}

func (s *Server) readMetadataManifest(directory string) metadataManifest {
	manifest := metadataManifest{Version: metadataManifestVersion, Files: make(map[string]metadataFileRecord)}
	data, err := os.ReadFile(s.metadataManifestPath(directory))
	if err != nil {
		return manifest
	}
	var cached metadataManifest
	if json.Unmarshal(data, &cached) != nil || cached.Files == nil {
		return manifest
	}
	if cached.Version == 1 {
		for name, record := range cached.Files {
			if record.Kind == "image" && record.Captured != 0 {
				stored := time.Unix(record.Captured, 0).UTC()
				record.Captured = time.Date(stored.Year(), stored.Month(), stored.Day(), stored.Hour(), stored.Minute(), stored.Second(), stored.Nanosecond(), time.Local).Unix()
				cached.Files[name] = record
			}
		}
		cached.Version = metadataManifestVersion
	}
	if cached.Version != metadataManifestVersion {
		return manifest
	}
	return cached
}

func (s *Server) writeMetadataManifest(directory string, manifest metadataManifest) error {
	destination := s.metadataManifestPath(directory)
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if current, readErr := os.ReadFile(destination); readErr == nil && string(current) == string(data) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".metadata-*.json")
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
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, destination)
}

func validMetadataManifest(cache, path string) bool {
	rel, err := filepath.Rel(cache, path)
	if err != nil {
		return false
	}
	segments := strings.Split(filepath.ToSlash(rel), "/")
	if len(segments) != 3 || segments[0] != "metadata" || len(segments[1]) != 2 || filepath.Ext(segments[2]) != ".json" {
		return false
	}
	key := segments[2][:len(segments[2])-len(".json")]
	if len(key) != 64 || segments[1] != key[:2] {
		return false
	}
	_, err = hex.DecodeString(key)
	return err == nil
}
