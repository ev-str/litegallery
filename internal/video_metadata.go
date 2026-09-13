package internal

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/abema/go-mp4"
)

const mp4EpochOffset = int64(2082844800)

func supportsVideoCaptureTime(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".mov", ".m4v", ".3gp":
		return true
	default:
		return false
	}
}

func readVideoCaptureTime(path string) (time.Time, error) {
	file, err := os.Open(path)
	if err != nil {
		return time.Time{}, err
	}
	defer file.Close()

	boxes, err := mp4.ExtractBoxWithPayload(file, nil, mp4.BoxPath{mp4.BoxTypeMoov(), mp4.BoxTypeMvhd()})
	if err != nil {
		return time.Time{}, err
	}
	if len(boxes) == 0 {
		return time.Time{}, nil
	}
	mvhd, ok := boxes[0].Payload.(*mp4.Mvhd)
	if !ok {
		return time.Time{}, errors.New("invalid mvhd payload")
	}
	seconds := int64(mvhd.GetCreationTime())
	if seconds <= mp4EpochOffset {
		return time.Time{}, nil
	}
	captured := time.Unix(seconds-mp4EpochOffset, 0)
	if captured.After(time.Now().Add(24 * time.Hour)) {
		return time.Time{}, nil
	}
	return captured, nil
}
