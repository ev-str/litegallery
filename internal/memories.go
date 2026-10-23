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
	// Periods counts canonical event matches over all anchors and years
	// before deduplication.
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
// Events are built once from the whole index, so their ID, dates, and media
// never depend on now; now only selects events and sets AnchorDate.
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
	spanDays := func(span memorySpan) []civilDay {
		first := sort.Search(len(days), func(i int) bool { return days[i] >= span.start })
		last := sort.Search(len(days), func(i int) bool { return days[i] > span.end })
		return days[first:last]
	}
	spanCount := func(span memorySpan) int {
		total := 0
		for _, day := range spanDays(span) {
			total += len(byDay[day])
		}
		return total
	}

	var spans []memorySpan
	for _, span := range canonicalSpans(days, byDay) {
		if spanCount(span) >= memoriesMinMedia {
			spans = append(spans, span)
		}
	}

	// Anchors run from today back, so the first match of an event is its most
	// recent anchor. Canonical spans are disjoint and sorted by start, so their
	// ends are sorted too.
	periods := 0
	anchorAge := make(map[int]int)
	today := civilDayOf(now.Date())
	for age := 0; age < memoriesAnchorDays && len(spans) > 0; age++ {
		anchorYear, anchorMonth, anchorDay := (today - civilDay(age)).date().Date()
		for year := anchorYear - 1; ; year-- {
			center := seasonalDay(year, anchorMonth, anchorDay)
			low, high := center-memoriesSeasonDays, center+memoriesSeasonDays
			if high < spans[0].start {
				break
			}
			for i := sort.Search(len(spans), func(i int) bool { return spans[i].end >= low }); i < len(spans) && spans[i].start <= high; i++ {
				periods++
				if _, matched := anchorAge[i]; !matched {
					anchorAge[i] = age
				}
			}
		}
	}

	selected := make([]int, 0, len(anchorAge))
	for i := range anchorAge {
		selected = append(selected, i)
	}
	sort.Slice(selected, func(i, j int) bool {
		a, b := selected[i], selected[j]
		if anchorAge[a] != anchorAge[b] {
			return anchorAge[a] < anchorAge[b]
		}
		return spans[a].start > spans[b].start
	})

	events := make([]memoryEvent, 0, len(selected))
	for _, i := range selected {
		span := spans[i]
		media := make([]memoryMedia, 0, spanCount(span))
		for _, day := range spanDays(span) {
			media = append(media, byDay[day]...)
		}
		events = append(events, memoryEvent{
			ID:         memoryEventID(span.start, span.end),
			Year:       span.start.date().Year(),
			StartDate:  span.start.String(),
			EndDate:    span.end.String(),
			AnchorDate: (today - civilDay(anchorAge[i])).String(),
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

// canonicalSpans groups sorted media days when at most memoriesMaxGapDays
// empty days separate them. A longer group is narrowed to its densest
// memoriesMaxEventDays window, the earliest one on ties.
func canonicalSpans(days []civilDay, byDay map[civilDay][]memoryMedia) []memorySpan {
	var spans []memorySpan
	for begin := 0; begin < len(days); {
		end := begin
		for end+1 < len(days) && days[end+1]-days[end] <= memoriesMaxGapDays+1 {
			end++
		}
		group := days[begin : end+1]
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
