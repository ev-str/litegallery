package internal

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

var memoriesTestZone = time.FixedZone("memories-test", 3*60*60)

type memoriesTestDay struct {
	date  string
	count int
	kind  string
}

func memoriesTestIndex(t *testing.T, days ...memoriesTestDay) dateIndex {
	t.Helper()
	index := dateIndex{Version: dateIndexVersion, GeneratedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Items: []dateIndexItem{}}
	for _, day := range days {
		date, err := time.ParseInLocation(memoriesDateLayout, day.date, memoriesTestZone)
		if err != nil {
			t.Fatal(err)
		}
		kind := day.kind
		if kind == "" {
			kind = "image"
		}
		for i := range day.count {
			sortTime := date.Add(time.Duration(12*60+i) * time.Minute).Unix()
			index.Items = append(index.Items, dateIndexItem{Path: fmt.Sprintf("%s/%s-%02d", day.date, kind, i), Kind: kind, SortTime: sortTime, Captured: true})
		}
	}
	return index
}

func memoriesTestNow(t *testing.T, date string) time.Time {
	t.Helper()
	now, err := time.ParseInLocation(memoriesDateLayout, date, memoriesTestZone)
	if err != nil {
		t.Fatal(err)
	}
	return now.Add(10 * time.Hour)
}

func memoryRanges(build memoriesBuild) []string {
	ranges := make([]string, 0, len(build.Artifact.Events))
	for _, event := range build.Artifact.Events {
		ranges = append(ranges, fmt.Sprintf("%s..%s:%d", event.StartDate, event.EndDate, event.MediaCount))
	}
	return ranges
}

func expectMemoryRanges(t *testing.T, build memoriesBuild, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := memoryRanges(build); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestMemoriesSeveralPreviousYears(t *testing.T) {
	index := memoriesTestIndex(t,
		memoriesTestDay{date: "2023-07-12", count: 5},
		memoriesTestDay{date: "2025-07-10", count: 6},
		memoriesTestDay{date: "2026-07-01", count: 9},
	)
	build := buildMemories(index, memoriesTestNow(t, "2026-07-10"))
	expectMemoryRanges(t, build, "2025-07-10..2025-07-10:6", "2023-07-12..2023-07-12:5")
	if years := []int{build.Artifact.Events[0].Year, build.Artifact.Events[1].Year}; !reflect.DeepEqual(years, []int{2025, 2023}) {
		t.Fatalf("years = %v", years)
	}
}

func TestMemoriesSeasonalWindowAndTrailingAnchors(t *testing.T) {
	// Anchors run from 2026-06-11 to 2026-07-10, so the 2025 windows cover
	// 2025-05-28 through 2025-07-24.
	index := memoriesTestIndex(t,
		memoriesTestDay{date: "2025-05-20", count: 5},
		memoriesTestDay{date: "2025-05-28", count: 5},
		memoriesTestDay{date: "2025-07-24", count: 5},
		memoriesTestDay{date: "2025-08-01", count: 5},
	)
	build := buildMemories(index, memoriesTestNow(t, "2026-07-10"))
	expectMemoryRanges(t, build, "2025-07-24..2025-07-24:5", "2025-05-28..2025-05-28:5")
	if got := []string{build.Artifact.Events[0].AnchorDate, build.Artifact.Events[1].AnchorDate}; !reflect.DeepEqual(got, []string{"2026-07-10", "2026-06-11"}) {
		t.Fatalf("anchors = %v", got)
	}

	edges := memoriesTestIndex(t, memoriesTestDay{date: "2025-05-27", count: 5}, memoriesTestDay{date: "2025-07-25", count: 5})
	expectMemoryRanges(t, buildMemories(edges, memoriesTestNow(t, "2026-07-10")))
}

func TestMemoriesMergeEmptyDayGaps(t *testing.T) {
	// 0, 1, and 2 empty days merge; 3 empty days split.
	index := memoriesTestIndex(t,
		memoriesTestDay{date: "2025-07-01", count: 2},
		memoriesTestDay{date: "2025-07-02", count: 2},
		memoriesTestDay{date: "2025-07-04", count: 2},
		memoriesTestDay{date: "2025-07-07", count: 2},
		memoriesTestDay{date: "2025-07-11", count: 5},
	)
	build := buildMemories(index, memoriesTestNow(t, "2026-07-06"))
	expectMemoryRanges(t, build, "2025-07-11..2025-07-11:5", "2025-07-01..2025-07-07:8")
}

func TestMemoriesMinimumMedia(t *testing.T) {
	index := memoriesTestIndex(t,
		memoriesTestDay{date: "2025-07-01", count: 2},
		memoriesTestDay{date: "2025-07-03", count: 2},
		memoriesTestDay{date: "2025-07-10", count: 4},
		memoriesTestDay{date: "2025-07-20", count: 3},
		memoriesTestDay{date: "2025-07-21", count: 2},
	)
	build := buildMemories(index, memoriesTestNow(t, "2026-07-10"))
	expectMemoryRanges(t, build, "2025-07-20..2025-07-21:5")
}

func TestMemoriesLongPeriodKeepsDensestWindow(t *testing.T) {
	var days []memoriesTestDay
	for day := 1; day <= 20; day++ {
		count := 1
		if day == 16 {
			count = 6
		}
		days = append(days, memoriesTestDay{date: fmt.Sprintf("2025-07-%02d", day), count: count})
	}
	build := buildMemories(memoriesTestIndex(t, days...), memoriesTestNow(t, "2026-07-10"))
	// Every 14-day window holding 16 July has 19 files; the earliest wins.
	expectMemoryRanges(t, build, "2025-07-03..2025-07-16:19")
}

func TestMemoriesLongPeriodTieKeepsEarliestWindow(t *testing.T) {
	var days []memoriesTestDay
	for day := 1; day <= 20; day++ {
		days = append(days, memoriesTestDay{date: fmt.Sprintf("2025-07-%02d", day), count: 1})
	}
	build := buildMemories(memoriesTestIndex(t, days...), memoriesTestNow(t, "2026-07-15"))
	expectMemoryRanges(t, build, "2025-07-01..2025-07-14:14")
	event := build.Artifact.Events[0]
	if start, end := mustMemoryDate(t, event.StartDate), mustMemoryDate(t, event.EndDate); end-start+1 != memoriesMaxEventDays {
		t.Fatalf("event length = %d", end-start+1)
	}
}

func TestMemoriesLongSparsePeriodRechecksMinimum(t *testing.T) {
	// Days three apart keep one group; the densest 14-day slice has 5 files.
	var days []memoriesTestDay
	for day := 1; day <= 28; day += 3 {
		days = append(days, memoriesTestDay{date: fmt.Sprintf("2025-07-%02d", day), count: 1})
	}
	build := buildMemories(memoriesTestIndex(t, days...), memoriesTestNow(t, "2026-07-14"))
	expectMemoryRanges(t, build, "2025-07-01..2025-07-13:5")

	spans := canonicalSpans([]civilDay{0, 3, 6, 9, 12, 15}, map[civilDay][]memoryMedia{
		0: make([]memoryMedia, 1), 3: make([]memoryMedia, 1), 6: make([]memoryMedia, 1), 9: make([]memoryMedia, 1), 12: make([]memoryMedia, 1), 15: make([]memoryMedia, 1),
	})
	if !reflect.DeepEqual(spans, []memorySpan{{0, 12}}) {
		t.Fatalf("spans = %v", spans)
	}
}

func TestMemoriesDeduplicateRepeatedDailyMatches(t *testing.T) {
	index := memoriesTestIndex(t, memoriesTestDay{date: "2025-07-01", count: 3}, memoriesTestDay{date: "2025-07-02", count: 3})
	build := buildMemories(index, memoriesTestNow(t, "2026-07-10"))
	expectMemoryRanges(t, build, "2025-07-01..2025-07-02:6")
	// The windows of anchors 2026-06-17..2026-07-10 intersect the trip.
	if build.Periods != 24 {
		t.Fatalf("periods = %d", build.Periods)
	}
}

func TestMemoriesWindowEdgeKeepsWholeTrip(t *testing.T) {
	// The newest window starts at 2025-06-26 inside the trip; the whole trip
	// keeps the newest anchor.
	var days []memoriesTestDay
	for day := 20; day <= 30; day++ {
		days = append(days, memoriesTestDay{date: fmt.Sprintf("2025-06-%02d", day), count: 1})
	}
	build := buildMemories(memoriesTestIndex(t, days...), memoriesTestNow(t, "2026-07-10"))
	expectMemoryRanges(t, build, "2025-06-20..2025-06-30:11")
	if build.Artifact.Events[0].AnchorDate != "2026-07-10" || build.Periods <= 1 {
		t.Fatalf("event = %+v periods = %d", build.Artifact.Events[0], build.Periods)
	}
}

func memoriesTestDays(t *testing.T, start string, days, count int) []memoriesTestDay {
	t.Helper()
	first, err := time.Parse(memoriesDateLayout, start)
	if err != nil {
		t.Fatal(err)
	}
	result := make([]memoriesTestDay, 0, days)
	for i := range days {
		result = append(result, memoriesTestDay{date: first.AddDate(0, 0, i).Format(memoriesDateLayout), count: count})
	}
	return result
}

// stableMemoryEvent drops the fields that may follow now.
func stableMemoryEvent(event memoryEvent) memoryEvent {
	event.AnchorDate = ""
	return event
}

func TestMemoriesTripAtRightWindowEdgeIsWhole(t *testing.T) {
	// The 2025-11-02..2025-11-12 trip enters the newest window from its right
	// edge on 2026-10-19 and is returned whole from that day on. After
	// 2026-11-26 its newest window falls behind today, so only the anchor moves.
	index := memoriesTestIndex(t, memoriesTestDays(t, "2025-11-02", 11, 3)...)
	var first memoryEvent
	for date, anchor := range map[string]string{
		"2026-10-19": "2026-10-19", "2026-10-20": "2026-10-20", "2026-10-23": "2026-10-23", "2026-10-24": "2026-10-24",
		"2026-10-29": "2026-10-29", "2026-11-26": "2026-11-26", "2026-12-10": "2026-11-26",
	} {
		build := buildMemories(index, memoriesTestNow(t, date))
		expectMemoryRanges(t, build, "2025-11-02..2025-11-12:33")
		event := build.Artifact.Events[0]
		if event.ID != "2025-11-02_2025-11-12" || event.AnchorDate != anchor {
			t.Fatalf("%s: event = %s anchor %s", date, event.ID, event.AnchorDate)
		}
		if first.ID == "" {
			first = event
		} else if !reflect.DeepEqual(stableMemoryEvent(event), stableMemoryEvent(first)) {
			t.Fatalf("%s: event changed:\n%+v\n%+v", date, event, first)
		}
	}
	expectMemoryRanges(t, buildMemories(index, memoriesTestNow(t, "2026-10-18")))
}

func TestMemoriesEventsAreStableAcrossDays(t *testing.T) {
	index := memoriesTestIndex(t, append(append(
		memoriesTestDays(t, "2025-10-05", 4, 2),
		memoriesTestDays(t, "2025-11-02", 11, 3)...),
		memoriesTestDays(t, "2024-10-28", 3, 2)...)...)
	seen := map[string]memoryEvent{}
	for day := 0; day < 60; day++ {
		now := memoriesTestNow(t, "2026-10-01").AddDate(0, 0, day)
		for _, event := range buildMemories(index, now).Artifact.Events {
			if previous, ok := seen[event.ID]; ok && !reflect.DeepEqual(stableMemoryEvent(previous), stableMemoryEvent(event)) {
				t.Fatalf("%s: event %s changed:\n%+v\n%+v", now.Format(memoriesDateLayout), event.ID, previous, event)
			}
			seen[event.ID] = event
		}
	}
	var ids []string
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if want := []string{"2024-10-28_2024-10-30", "2025-10-05_2025-10-08", "2025-11-02_2025-11-12"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v", ids)
	}
}

func TestMemoriesSelectEventsIntersectingWindow(t *testing.T) {
	// Anchors 2026-06-11..2026-07-10 cover 2025-05-28 through 2025-07-24.
	now := memoriesTestNow(t, "2026-07-10")
	intersecting := memoriesTestIndex(t, append(memoriesTestDays(t, "2025-05-20", 9, 1), memoriesTestDays(t, "2025-07-24", 5, 1)...)...)
	build := buildMemories(intersecting, now)
	expectMemoryRanges(t, build, "2025-07-24..2025-07-28:5", "2025-05-20..2025-05-28:9")
	if got := []string{build.Artifact.Events[0].AnchorDate, build.Artifact.Events[1].AnchorDate}; !reflect.DeepEqual(got, []string{"2026-07-10", "2026-06-11"}) {
		t.Fatalf("anchors = %v", got)
	}

	outside := memoriesTestIndex(t, append(memoriesTestDays(t, "2025-05-20", 8, 1), memoriesTestDays(t, "2025-07-25", 5, 1)...)...)
	expectMemoryRanges(t, buildMemories(outside, now))
}

func TestMemoriesLongComponentKeepsStableDensestWindow(t *testing.T) {
	// The densest 14-day windows hold 20..22 June; the earliest is 9..22 June.
	var days []memoriesTestDay
	for _, day := range memoriesTestDays(t, "2025-06-01", 30, 1) {
		if day.date >= "2025-06-20" && day.date <= "2025-06-22" {
			day.count = 5
		}
		days = append(days, day)
	}
	index := memoriesTestIndex(t, days...)
	matched := 0
	for day := 0; day < 70; day++ {
		now := memoriesTestNow(t, "2026-05-20").AddDate(0, 0, day)
		build := buildMemories(index, now)
		if len(build.Artifact.Events) == 0 {
			continue
		}
		matched++
		expectMemoryRanges(t, build, "2025-06-09..2025-06-22:26")
	}
	if matched == 0 {
		t.Fatal("component was never selected")
	}
	// Other days of the component never form their own event.
	expectMemoryRanges(t, buildMemories(index, memoriesTestNow(t, "2026-05-24")))
}

func TestMemoriesDeterministicIDsAndOrder(t *testing.T) {
	index := memoriesTestIndex(t,
		memoriesTestDay{date: "2022-07-09", count: 5, kind: "video"},
		memoriesTestDay{date: "2024-06-20", count: 7},
		memoriesTestDay{date: "2025-07-10", count: 5},
		memoriesTestDay{date: "2025-07-11", count: 2, kind: "video"},
	)
	now := memoriesTestNow(t, "2026-07-10")
	first := buildMemories(index, now)
	shuffled := index
	shuffled.Items = append([]dateIndexItem(nil), index.Items...)
	rand.New(rand.NewSource(1)).Shuffle(len(shuffled.Items), func(i, j int) {
		shuffled.Items[i], shuffled.Items[j] = shuffled.Items[j], shuffled.Items[i]
	})
	second := buildMemories(shuffled, now)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("builds differ:\n%+v\n%+v", first, second)
	}
	var ids []string
	for _, event := range first.Artifact.Events {
		ids = append(ids, event.ID)
	}
	// Today's anchor first (newest year first), then older anchors.
	if want := []string{"2025-07-10_2025-07-11", "2022-07-09_2022-07-09", "2024-06-20_2024-06-20"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v", ids)
	}
	media := first.Artifact.Events[0].Media
	for i := 1; i < len(media); i++ {
		if media[i-1].SortTime > media[i].SortTime || (media[i-1].SortTime == media[i].SortTime && media[i-1].Path >= media[i].Path) {
			t.Fatalf("media order: %+v", media)
		}
	}
	if first.Artifact.Revision == "" || first.Artifact.Revision != memoriesRevision(first.Artifact.Events) || !validMemoriesArtifact(first.Artifact) {
		t.Fatalf("artifact: %+v", first.Artifact)
	}
}

func TestMemoriesYearBoundary(t *testing.T) {
	index := memoriesTestIndex(t,
		memoriesTestDay{date: "2024-12-29", count: 2},
		memoriesTestDay{date: "2024-12-31", count: 2},
		memoriesTestDay{date: "2025-01-02", count: 2},
	)
	// Anchors 2025-12-07..2026-01-05 reach this trip from both 2024 and 2025.
	build := buildMemories(index, memoriesTestNow(t, "2026-01-05"))
	expectMemoryRanges(t, build, "2024-12-29..2025-01-02:6")
	event := build.Artifact.Events[0]
	if event.ID != "2024-12-29_2025-01-02" || event.Year != 2024 || event.AnchorDate != "2026-01-05" {
		t.Fatalf("event = %+v", event)
	}
}

func TestMemoriesLeapDay(t *testing.T) {
	// 29 February maps to 28 February in 2027, so the window ends 14 March.
	index := memoriesTestIndex(t,
		memoriesTestDay{date: "2027-03-14", count: 5},
		memoriesTestDay{date: "2024-02-29", count: 5},
	)
	build := buildMemories(index, memoriesTestNow(t, "2028-02-29"))
	expectMemoryRanges(t, build, "2027-03-14..2027-03-14:5", "2024-02-29..2024-02-29:5")
	expectMemoryRanges(t, buildMemories(memoriesTestIndex(t, memoriesTestDay{date: "2027-03-15", count: 5}), memoriesTestNow(t, "2028-02-29")))

	// A leap-day trip is remembered in a non-leap year.
	expectMemoryRanges(t, buildMemories(memoriesTestIndex(t, memoriesTestDay{date: "2024-02-29", count: 5}), memoriesTestNow(t, "2025-02-28")),
		"2024-02-29..2024-02-29:5")
	if got := seasonalDay(2027, time.February, 29); got.String() != "2027-02-28" {
		t.Fatalf("seasonal day = %s", got)
	}
}

func TestMemoriesImagesVideosAndUncapturedTimes(t *testing.T) {
	index := memoriesTestIndex(t, memoriesTestDay{date: "2025-07-10", count: 3, kind: "video"}, memoriesTestDay{date: "2025-07-10", count: 2})
	// Uncaptured items still sort and group by their SortTime fallback.
	for i := range index.Items {
		if index.Items[i].Kind == "image" {
			index.Items[i].Captured = false
		}
	}
	build := buildMemories(index, memoriesTestNow(t, "2026-07-10"))
	expectMemoryRanges(t, build, "2025-07-10..2025-07-10:5")
	kinds := map[string]int{}
	for _, media := range build.Artifact.Events[0].Media {
		kinds[media.Kind]++
		if media.Captured != (media.Kind == "video") || strings.HasPrefix(media.Path, "/") {
			t.Fatalf("media = %+v", media)
		}
	}
	if kinds["image"] != 2 || kinds["video"] != 3 {
		t.Fatalf("kinds = %v", kinds)
	}
}

func TestMemoriesUseNowLocationForCalendarDays(t *testing.T) {
	// 22:30 UTC on 9 July is 01:30 on 10 July in the +03:00 test zone.
	sortTime := time.Date(2025, 7, 9, 22, 30, 0, 0, time.UTC).Unix()
	index := dateIndex{Version: dateIndexVersion, GeneratedAt: time.Now(), Items: []dateIndexItem{}}
	for i := range 5 {
		index.Items = append(index.Items, dateIndexItem{Path: fmt.Sprintf("late-%d.jpg", i), Kind: "image", SortTime: sortTime + int64(i)})
	}
	expectMemoryRanges(t, buildMemories(index, memoriesTestNow(t, "2026-07-10")), "2025-07-10..2025-07-10:5")
}

func TestMemoriesEmptyIndex(t *testing.T) {
	build := buildMemories(dateIndex{Version: dateIndexVersion, GeneratedAt: time.Now(), Items: []dateIndexItem{}}, memoriesTestNow(t, "2026-07-10"))
	if build.Artifact.Events == nil || len(build.Artifact.Events) != 0 || build.Periods != 0 {
		t.Fatalf("build = %+v", build)
	}
}

func mustMemoryDate(t *testing.T, value string) civilDay {
	t.Helper()
	day, ok := parseMemoryDate(value)
	if !ok {
		t.Fatalf("bad date %q", value)
	}
	return day
}
