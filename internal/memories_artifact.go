package internal

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type memoriesResponse struct {
	Version     int           `json:"version"`
	State       string        `json:"state"`
	GeneratedAt *time.Time    `json:"generatedAt,omitempty"`
	Revision    string        `json:"revision,omitempty"`
	Shown       int           `json:"shown"`
	Events      []memoryEvent `json:"events"`
}

func (s *Server) memoriesPath() string {
	return filepath.Join(s.cfg.Cache, "memories", "memories-v1.json")
}

func (s *Server) writeMemoriesArtifact(artifact memoriesArtifact) error {
	data, err := json.Marshal(artifact)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.memoriesPath(), data)
}

// readMemoriesArtifact treats a missing, corrupt, unknown-version, or
// inconsistent artifact as unavailable.
func (s *Server) readMemoriesArtifact() (memoriesArtifact, bool) {
	data, err := os.ReadFile(s.memoriesPath())
	if err != nil {
		return memoriesArtifact{}, false
	}
	var artifact memoriesArtifact
	if json.Unmarshal(data, &artifact) != nil || !validMemoriesArtifact(artifact) {
		return memoriesArtifact{}, false
	}
	return artifact, true
}

func validMemoriesArtifact(artifact memoriesArtifact) bool {
	if artifact.Version != memoriesVersion || artifact.GeneratedAt.IsZero() || artifact.Events == nil ||
		artifact.DateIndexVersion != dateIndexVersion || artifact.DateIndexGeneratedAt.IsZero() ||
		artifact.Revision != memoriesRevision(artifact.Events) {
		return false
	}
	ids := make(map[string]struct{}, len(artifact.Events))
	for _, event := range artifact.Events {
		start, startOK := parseMemoryDate(event.StartDate)
		end, endOK := parseMemoryDate(event.EndDate)
		_, anchorOK := parseMemoryDate(event.AnchorDate)
		if !startOK || !endOK || !anchorOK || end < start || end-start >= memoriesMaxEventDays ||
			event.ID != memoryEventID(start, end) || event.Year != start.date().Year() ||
			event.MediaCount < memoriesMinMedia || event.MediaCount != len(event.Media) {
			return false
		}
		if _, duplicate := ids[event.ID]; duplicate {
			return false
		}
		ids[event.ID] = struct{}{}
		for _, media := range event.Media {
			if (media.Kind != "image" && media.Kind != "video") || !safeRelativePath(media.Path) {
				return false
			}
		}
	}
	return true
}

func parseMemoryDate(value string) (civilDay, bool) {
	t, err := time.Parse(memoriesDateLayout, value)
	if err != nil {
		return 0, false
	}
	return civilDayOf(t.Date()), true
}

func (s *Server) writeMemoriesStatus(status MemoriesStatus) error {
	data, err := json.Marshal(memoriesStatusFile{Version: memoriesStatusVersion, MemoriesStatus: status})
	if err != nil {
		return err
	}
	return writeFileAtomic(s.memoriesStatusPath(), data)
}

// refreshMemories rebuilds the memories artifact from a freshly written date
// index. A failure keeps the last valid artifact and its ready version. The
// running status is best effort; artifact and final status errors are joined.
func (s *Server) refreshMemories(index dateIndex, now time.Time) error {
	base := MemoriesStatus{}
	if previous, ok := s.readMemoriesArtifact(); ok {
		readyAt := previous.GeneratedAt
		base.ReadyVersion, base.ReadyAt = previous.Revision, &readyAt
	}
	started := statusTime(time.Now())
	running := base
	running.State, running.UpdatedAt = statusRunning, &started
	_ = s.writeMemoriesStatus(running)

	build := buildMemories(index, now)
	artifactErr := s.writeMemoriesArtifact(build.Artifact)
	finished := statusTime(time.Now())
	memories, shown, errorCount := len(build.Artifact.Events), min(memoriesShownLimit, len(build.Artifact.Events)), 0
	result := base
	result.State, result.UpdatedAt = statusReady, &finished
	if artifactErr != nil {
		result.State, errorCount = runFailed, 1
	} else {
		readyAt := build.Artifact.GeneratedAt
		result.ReadyVersion, result.ReadyAt = build.Artifact.Revision, &readyAt
	}
	result.Periods, result.Memories, result.Shown, result.Errors = &build.Periods, &memories, &shown, &errorCount
	var statusErr error
	if err := s.writeMemoriesStatus(result); err != nil {
		statusErr = fmt.Errorf("write memories status: %w", err)
	}
	if artifactErr != nil {
		artifactErr = fmt.Errorf("write memories artifact: %w", artifactErr)
	}
	return errors.Join(artifactErr, statusErr)
}

func (s *Server) memoriesResponse() memoriesResponse {
	artifact, ok := s.readMemoriesArtifact()
	if !ok {
		return memoriesResponse{Version: memoriesVersion, State: statusUnavailable, Events: []memoryEvent{}}
	}
	generated := artifact.GeneratedAt
	return memoriesResponse{
		Version:     memoriesVersion,
		State:       statusReady,
		GeneratedAt: &generated,
		Revision:    artifact.Revision,
		Shown:       min(memoriesShownLimit, len(artifact.Events)),
		Events:      artifact.Events,
	}
}

func (s *Server) handleMemories(w http.ResponseWriter, r *http.Request) {
	writeNoStoreJSON(w, r, func() any { return s.memoriesResponse() })
}
