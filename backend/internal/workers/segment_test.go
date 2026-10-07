package workers

import "testing"

func TestPlanSpansFixedWindows(t *testing.T) {
	spans := planSpans("v.mp4", 10, 4, 4)
	// starts at 0,4,8 → three clips, the last clamped to the duration.
	if len(spans) != 3 {
		t.Fatalf("len = %d, want 3", len(spans))
	}
	want := []spanPlan{
		{Ref: "v.mp4#t=0.000,4.000", Start: 0, End: 4},
		{Ref: "v.mp4#t=4.000,8.000", Start: 4, End: 8},
		{Ref: "v.mp4#t=8.000,10.000", Start: 8, End: 10},
	}
	for i, expected := range want {
		if spans[i] != expected {
			t.Fatalf("span[%d] = %+v, want %+v", i, spans[i], expected)
		}
	}
}

func TestPlanSpansOverlappingStride(t *testing.T) {
	// stride < window → overlapping windows (dense coverage).
	spans := planSpans("v.mp4", 5, 4, 2)
	if len(spans) != 3 { // starts 0,2,4
		t.Fatalf("len = %d, want 3", len(spans))
	}
	if spans[1].Start != 2 || spans[1].End != 5 { // 2+4 clamped to 5? no: 2+4=6>5 → 5
		t.Fatalf("span[1] = %+v", spans[1])
	}
}

func TestPlanSpansStrideGapAndClamp(t *testing.T) {
	// stride > window → gaps between clips; last clip clamped.
	spans := planSpans("v.mp4", 9, 2, 5)
	if len(spans) != 2 { // starts 0,5
		t.Fatalf("len = %d, want 2", len(spans))
	}
	if spans[0].End != 2 || spans[1].Start != 5 || spans[1].End != 7 {
		t.Fatalf("spans = %+v", spans)
	}
}

func TestPlanSpansWindowExceedsDuration(t *testing.T) {
	// One clip covering the whole video when the window is longer than it.
	spans := planSpans("v.mp4", 3, 10, 10)
	if len(spans) != 1 || spans[0].Start != 0 || spans[0].End != 3 {
		t.Fatalf("spans = %+v", spans)
	}
}

// starts collapses a plan to its boundaries, which is what these tests are about.
func starts(spans []spanPlan) [][2]float64 {
	out := make([][2]float64, len(spans))
	for i, span := range spans {
		out[i] = [2]float64{span.Start, span.End}
	}
	return out
}

func equalRanges(t *testing.T, spans []spanPlan, want [][2]float64) {
	t.Helper()
	got := starts(spans)
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("span[%d] = %v, want %v (all: %v)", i, got[i], want[i], got)
		}
	}
}

func TestPlanAtomsSplitsAtCuts(t *testing.T) {
	atoms := planAtoms("v.mp4", 10, []float64{3, 7}, 4)
	equalRanges(t, atoms, [][2]float64{{0, 3}, {3, 7}, {7, 10}})
}

func TestPlanAtomsSubdividesLongShots(t *testing.T) {
	// A 9s shot with a 4s ceiling splits into three equal parts, not 4+4+1.
	atoms := planAtoms("v.mp4", 9, nil, 4)
	equalRanges(t, atoms, [][2]float64{{0, 3}, {3, 6}, {6, 9}})
}

func TestPlanAtomsIgnoresUnusableCuts(t *testing.T) {
	// ffmpeg reports a long transition as several frames in a row, and a re-resolved
	// source can be shorter than the pass that produced the cuts.
	atoms := planAtoms("v.mp4", 8, []float64{0, 4, 4, 20}, 8)
	equalRanges(t, atoms, [][2]float64{{0, 4}, {4, 8}})
}

func TestPlanAtomsRejectsBadInput(t *testing.T) {
	if atoms := planAtoms("", 10, nil, 4); atoms != nil {
		t.Fatalf("no url: %v", atoms)
	}
	if atoms := planAtoms("v.mp4", 0, nil, 4); atoms != nil {
		t.Fatalf("no duration: %v", atoms)
	}
	if atoms := planAtoms("v.mp4", 10, nil, 0); atoms != nil {
		t.Fatalf("no max length: %v", atoms)
	}
}

func TestMergeAtomsJoinsSimilarNeighbours(t *testing.T) {
	atoms := planAtoms("v.mp4", 8, []float64{2, 4, 6}, 2)
	// The first three atoms are one act shot from three angles; the last is a new act.
	spans := mergeAtoms("v.mp4", atoms, []float64{0.97, 0.95, 0.2}, 0.9, 1, 8)
	equalRanges(t, spans, [][2]float64{{0, 6}, {6, 8}})
}

func TestMergeAtomsStopsAtMaxLength(t *testing.T) {
	atoms := planAtoms("v.mp4", 8, []float64{2, 4, 6}, 2)
	// Everything is similar, so only the window keeps the merge from running away.
	spans := mergeAtoms("v.mp4", atoms, []float64{0.99, 0.99, 0.99}, 0.9, 1, 4)
	equalRanges(t, spans, [][2]float64{{0, 4}, {4, 8}})
}

func TestMergeAtomsAbsorbsShortClipIntoBetterMatch(t *testing.T) {
	atoms := planAtoms("v.mp4", 9, []float64{4, 5}, 4)
	// The 1s sliver at 4-5 is below minLen: it belongs with whichever side it matches.
	spans := mergeAtoms("v.mp4", atoms, []float64{0.3, 0.95}, 0.99, 2, 9)
	equalRanges(t, spans, [][2]float64{{0, 4}, {4, 9}})
}

func TestMergeAtomsKeepsShortClipWithNoRoom(t *testing.T) {
	atoms := planAtoms("v.mp4", 9, []float64{4, 5}, 4)
	// Both neighbours are already at the window, so the sliver has nowhere to go and
	// stays rather than producing a clip that runs past it.
	spans := mergeAtoms("v.mp4", atoms, []float64{0.95, 0.95}, 0.99, 2, 4)
	equalRanges(t, spans, [][2]float64{{0, 4}, {4, 5}, {5, 9}})
}

func TestMergeAtomsWithoutScoresChangesNothing(t *testing.T) {
	// No model, a failed comparison, or merge=0 all arrive here as missing scores.
	atoms := planAtoms("v.mp4", 8, []float64{2, 4, 6}, 2)
	equalRanges(t, mergeAtoms("v.mp4", atoms, nil, 0.9, 0, 8), starts(atoms))
	equalRanges(t, mergeAtoms("v.mp4", atoms, []float64{0.99, 0.99, 0.99}, 0, 0, 8), starts(atoms))
	// A short score list must not shift the boundaries it does not cover.
	equalRanges(t, mergeAtoms("v.mp4", atoms, []float64{0.99}, 0.9, 0, 8),
		[][2]float64{{0, 4}, {4, 6}, {6, 8}})
}

func TestMergeAtomsRefsMatchRanges(t *testing.T) {
	atoms := planAtoms("v.mp4", 8, []float64{4}, 4)
	spans := mergeAtoms("v.mp4", atoms, []float64{0.99}, 0.9, 1, 8)
	if len(spans) != 1 || spans[0].Ref != "v.mp4#t=0.000,8.000" {
		t.Fatalf("spans = %+v", spans)
	}
}

func TestMergeAtomsEmpty(t *testing.T) {
	if spans := mergeAtoms("v.mp4", nil, nil, 0.9, 2, 4); spans != nil {
		t.Fatalf("spans = %+v", spans)
	}
}

func TestFingerprintTracksOnlyTheModesOwnSettings(t *testing.T) {
	scenes := SegmentParams{Mode: SegmentScenes, Window: 8, Stride: 4, MinLen: 2, CutScore: 0.3, Merge: 0.9}
	restride := scenes
	restride.Stride = 1
	if scenes.fingerprint() != restride.fingerprint() {
		t.Fatal("stride moves no boundary in scene mode but changed the fingerprint")
	}
	retuned := scenes
	retuned.CutScore = 0.4
	if scenes.fingerprint() == retuned.fingerprint() {
		t.Fatal("a new cut threshold moves every boundary but kept the fingerprint")
	}
	fixed := SegmentParams{Mode: SegmentFixed, Window: 8, Stride: 4}
	if fixed.fingerprint() == scenes.fingerprint() {
		t.Fatal("modes with the same window must not share a fingerprint")
	}
}

func TestPlanSpansRejectsBadInput(t *testing.T) {
	cases := []struct {
		url                      string
		duration, window, stride float64
	}{
		{"", 10, 4, 4},
		{"v.mp4", 0, 4, 4},
		{"v.mp4", 10, 0, 4},
		{"v.mp4", 10, 4, 0},
	}
	for i, c := range cases {
		if spans := planSpans(c.url, c.duration, c.window, c.stride); spans != nil {
			t.Fatalf("case %d: expected nil, got %+v", i, spans)
		}
	}
}
