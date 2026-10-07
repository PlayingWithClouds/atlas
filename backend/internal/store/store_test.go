package store

import "testing"

func TestSpanRefRoundTrip(t *testing.T) {
	cases := []struct {
		name   string
		base   string
		tStart float64
		tEnd   float64
	}{
		{"remote url", "https://cdn.example.com/scene.mp4", 12.5, 16.5},
		{"local path", "/videos/clip.mp4", 0, 4},
		{"url with query", "https://cdn.example.com/a.mp4?token=abc", 3.25, 7.75},
		{"url already carrying a fragment marker", "https://cdn.example.com/a.mp4?x=#t=9", 1, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ref := SpanRef(tc.base, tc.tStart, tc.tEnd)
			base, tStart, tEnd, ok := SplitSpanRef(ref)
			if !ok {
				t.Fatalf("SplitSpanRef(%q) reported not a span", ref)
			}
			if base != tc.base {
				t.Errorf("base = %q, want %q", base, tc.base)
			}
			if tStart != tc.tStart || tEnd != tc.tEnd {
				t.Errorf("range = (%v, %v), want (%v, %v)", tStart, tEnd, tc.tStart, tc.tEnd)
			}
		})
	}
}

func TestSplitSpanRefRejects(t *testing.T) {
	refs := []string{
		"/images/frame_00001.jpg",
		"https://cdn.example.com/a.mp4#t=",
		"https://cdn.example.com/a.mp4#t=1",
		"https://cdn.example.com/a.mp4#t=1,2,3",
		"https://cdn.example.com/a.mp4#t=abc,2",
		"https://cdn.example.com/a.mp4#t=5.000,1.000",
	}
	for _, ref := range refs {
		if _, _, _, ok := SplitSpanRef(ref); ok {
			t.Errorf("SplitSpanRef(%q) = ok, want rejected", ref)
		}
	}
}

func spanImage(idx int, ref string, start float64, status string) Image {
	end := start + 4
	return Image{Idx: idx, Ref: ref, Status: status, TStart: &start, TEnd: &end}
}

func TestSplitDuplicatesKeepsOnePerRefInTimeOrder(t *testing.T) {
	// A segment node that ran three times: the same windows appended over and over.
	images := []Image{
		spanImage(0, "v.mp4#t=0.000,4.000", 0, StatusPending),
		spanImage(1, "v.mp4#t=4.000,8.000", 4, StatusPending),
		spanImage(2, "v.mp4#t=0.000,4.000", 0, StatusPending),
		spanImage(3, "v.mp4#t=4.000,8.000", 4, StatusLabeled), // human work on a later copy
		spanImage(4, "v.mp4#t=0.000,4.000", 0, StatusPending),
	}

	keepers, doomed := splitDuplicates(images)
	if len(keepers) != 2 {
		t.Fatalf("kept %d rows, want one per distinct ref", len(keepers))
	}
	if len(doomed) != 3 {
		t.Fatalf("doomed = %v, want the three extra copies", doomed)
	}
	if *keepers[0].TStart != 0 || *keepers[1].TStart != 4 {
		t.Errorf("keepers out of time order: %v, %v", *keepers[0].TStart, *keepers[1].TStart)
	}
	// The labeled copy must survive, or human work is thrown away.
	if keepers[1].Idx != 3 || keepers[1].Status != StatusLabeled {
		t.Errorf("kept %+v for 4–8s, want the labeled copy (idx 3)", keepers[1])
	}
}

func TestSplitDuplicatesOrdersSpansByTimeAfterPlainEntities(t *testing.T) {
	images := []Image{
		spanImage(0, "v.mp4#t=8.000,12.000", 8, StatusPending),
		{Idx: 1, Ref: "/frames/frame_00000.jpg", Status: StatusPending},
		spanImage(2, "v.mp4#t=0.000,4.000", 0, StatusPending),
	}

	keepers, doomed := splitDuplicates(images)
	if len(doomed) != 0 {
		t.Fatalf("doomed = %v, want nothing dropped", doomed)
	}
	if keepers[0].Ref != "/frames/frame_00000.jpg" {
		t.Errorf("plain entity should head the list, got %q", keepers[0].Ref)
	}
	if *keepers[1].TStart != 0 || *keepers[2].TStart != 8 {
		t.Errorf("spans out of time order: %v", keepers)
	}
}

func TestPreferImagePicksHumanWorkThenEmbeddedThenEarliest(t *testing.T) {
	labeled := Image{Idx: 9, Status: StatusLabeled}
	pending := Image{Idx: 1, Status: StatusPending}
	if !preferImage(labeled, pending) {
		t.Error("a labeled copy must beat an earlier pending one")
	}
	if preferImage(pending, labeled) {
		t.Error("a pending copy must not beat a labeled one")
	}
	embedded := Image{Idx: 9, Status: StatusPending, Embedded: true}
	if !preferImage(embedded, pending) {
		t.Error("an embedded copy must beat an unembedded one")
	}
	early := Image{Idx: 1, Status: StatusPending}
	late := Image{Idx: 7, Status: StatusPending}
	if preferImage(late, early) {
		t.Error("with nothing else to separate them, the earliest row wins")
	}
}
