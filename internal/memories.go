package internal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"
)

const (
	memoriesVersion      = 1
	memoriesSeasonDays   = 14
	memoriesMaxGapDays   = 2
	memoriesMaxEventDays = 14
	memoriesMinMedia     = 5
	memoriesAnchorDays   = 30
	memoriesShownLimit   = 6
	memoriesDateLayout   = "2006-01-02"
)

type memoryMedia struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	SortTime int64  `json:"sortTime"`
	Captured bool   `json:"captured,omitempty"`
}

// memoryEvent dates are calendar days in the builder's time zone. Year is the
// year of StartDate; AnchorDate is the most recent anchor day that matched.
type memoryEvent struct {
	ID         string        `json:"id"`
	Year       int           `json:"year"`
	StartDate  string        `json:"startDate"`
	EndDate    string        `json:"endDate"`
	AnchorDate string        `json:"anchorDate"`
	MediaCount int           `json:"mediaCount"`
	Media      []memoryMedia `json:"media"`
}

type memoriesArtifact struct {
	Version              int           `json:"version"`
	GeneratedAt          time.Time     `json:"generatedAt"`
	Revision             string        `json:"revision"`
	DateIndexVersion     int           `json:"dateIndexVersion"`
	DateIndexGeneratedAt time.Time     `json:"dateIndexGeneratedAt"`
	Events               []memoryEvent `json:"events"`
}

type memoriesBuild struct {
	Artifact memoriesArtifact
	// Periods counts saturated periods over all anchors and years before
	// deduplication.
	Periods int
}

// civilDay numbers calendar days from 1970-01-01, independent of time zones.
type civilDay int64

func civilDayOf(year int, month time.Month, day int) civilDay {
	return civilDay(time.Date(year, month, day, 0, 0, 0, 0, time.UTC).Unix() / 86400)
}

func (d civilDay) date() time.Time {
	return time.Unix(int64(d)*86400, 0).UTC()
}

func (d civilDay) String() string {
	return d.date().Format(memoriesDateLayout)
}

// seasonalDay maps month/day into year; 29 February becomes 28 February in a
// non-leap year.
func seasonalDay(year int, month time.Month, day int) civilDay {
	if month == time.February && day == 29 && time.Date(year, time.March, 0, 0, 0, 0, 0, time.UTC).Day() != 29 {
		day = 28
	}
	return civilDayOf(year, month, day)
}

func memoryEventID(start, end civilDay) string {
	return start.String() + "_" + end.String()
}

func memoriesRevision(events []memoryEvent) string {
	data, _ := json.Marshal(events)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

type memorySpan struct{ start, end civilDay }

// buildMemories is a pure function of the date index and now. Calendar days
// use now's location, which matches the local wall-clock capture times.
func buildMemories(index dateIndex, now time.Time) memoriesBuild {
	location := now.Location()
	byDay := make(map[civilDay][]memoryMedia)
	for _, item := range index.Items {
		t := time.Unix(item.SortTime, 0).In(location)
		if t.Year() < 1 || t.Year() > 9999 {
			continue
		}
		day := civilDayOf(t.Date())
		byDay[day] = append(byDay[day], memoryMedia{Path: item.Path, Kind: item.Kind, SortTime: item.SortTime, Captured: item.Captured})
	}
	days := make([]civilDay, 0, len(byDay))
	for day, media := range byDay {
		sort.Slice(media, func(i, j int) bool {
			if media[i].SortTime != media[j].SortTime {
				return media[i].SortTime < media[j].SortTime
			}
			return media[i].Path < media[j].Path
		})
		days = append(days, day)
	}
	sort.Slice(days, func(i, j int) bool { return days[i] < days[j] })
	count := func(start, end civilDay) int {
		total := 0
		for i := sort.Search(len(days), func(i int) bool { return days[i] >= start }); i < len(days) && days[i] <= end; i++ {
			total += len(byDay[days[i]])
		}
		return total
	}

	periods := 0
	anchorAge := make(map[memorySpan]int)
	today := civilDayOf(now.Date())
	for age := 0; age < memoriesAnchorDays && len(days) > 0; age++ {
		anchorYear, anchorMonth, anchorDay := (today - civilDay(age)).date().Date()
		for year := anchorYear - 1; ; year-- {
			center := seasonalDay(year, anchorMonth, anchorDay)
			if center+memoriesSeasonDays < days[0] {
				break
			}
			for _, span := range saturatedPeriods(days, center-memoriesSeasonDays, center+memoriesSeasonDays, byDay) {
				if count(span.start, span.end) < memoriesMinMedia {
					continue
				}
				periods++
				if previous, ok := anchorAge[span]; !ok || age < previous {
					anchorAge[span] = age
				}
			}
		}
	}

	// Sliding anchor windows clip one trip differently at their edges, so
	// overlapping periods keep only the fullest one: most media, then earliest
	// start, then earliest end. The winner keeps the most recent anchor.
	spans := make([]memorySpan, 0, len(anchorAge))
	for span := range anchorAge {
		spans = append(spans, span)
	}
	sort.Slice(spans, func(i, j int) bool {
		a, b := spans[i], spans[j]
		if ca, cb := count(a.start, a.end), count(b.start, b.end); ca != cb {
			return ca > cb
		}
		if a.start != b.start {
			return a.start < b.start
		}
		return a.end < b.end
	})
	kept := make([]memorySpan, 0, len(spans))
	for _, span := range spans {
		overlapped := false
		for _, winner := range kept {
			if span.start <= winner.end && winner.start <= span.end {
				anchorAge[winner] = min(anchorAge[winner], anchorAge[span])
				overlapped = true
				break
			}
		}
		if !overlapped {
			kept = append(kept, span)
		}
	}
	sort.Slice(kept, func(i, j int) bool {
		a, b := kept[i], kept[j]
		if anchorAge[a] != anchorAge[b] {
			return anchorAge[a] < anchorAge[b]
		}
		return a.start > b.start
	})

	events := make([]memoryEvent, 0, len(kept))
	for _, span := range kept {
		media := make([]memoryMedia, 0, count(span.start, span.end))
		for i := sort.Search(len(days), func(i int) bool { return days[i] >= span.start }); i < len(days) && days[i] <= span.end; i++ {
			media = append(media, byDay[days[i]]...)
		}
		events = append(events, memoryEvent{
			ID:         memoryEventID(span.start, span.end),
			Year:       span.start.date().Year(),
			StartDate:  span.start.String(),
			EndDate:    span.end.String(),
			AnchorDate: (today - civilDay(anchorAge[span])).String(),
			MediaCount: len(media),
			Media:      media,
		})
	}
	return memoriesBuild{
		Artifact: memoriesArtifact{
			Version:              memoriesVersion,
			GeneratedAt:          statusTime(now),
			Revision:             memoriesRevision(events),
			DateIndexVersion:     index.Version,
			DateIndexGeneratedAt: index.GeneratedAt,
			Events:               events,
		},
		Periods: periods,
	}
}

// saturatedPeriods groups media days inside [low, high] when at most
// memoriesMaxGapDays empty days separate them. A longer group is narrowed to
// its densest memoriesMaxEventDays window, the earliest one on ties.
func saturatedPeriods(days []civilDay, low, high civilDay, byDay map[civilDay][]memoryMedia) []memorySpan {
	first := sort.Search(len(days), func(i int) bool { return days[i] >= low })
	last := sort.Search(len(days), func(i int) bool { return days[i] > high })
	window := days[first:last]
	var spans []memorySpan
	for begin := 0; begin < len(window); {
		end := begin
		for end+1 < len(window) && window[end+1]-window[end] <= memoriesMaxGapDays+1 {
			end++
		}
		group := window[begin : end+1]
		begin = end + 1
		if group[len(group)-1]-group[0] < memoriesMaxEventDays {
			spans = append(spans, memorySpan{group[0], group[len(group)-1]})
			continue
		}
		best, bestCount := memorySpan{}, -1
		right, total := 0, 0
		for left := range group {
			for right < len(group) && group[right]-group[left] < memoriesMaxEventDays {
				total += len(byDay[group[right]])
				right++
			}
			if total > bestCount {
				best, bestCount = memorySpan{group[left], group[right-1]}, total
			}
			total -= len(byDay[group[left]])
		}
		spans = append(spans, best)
	}
	return spans
}
