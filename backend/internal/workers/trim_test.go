package workers

import "testing"

func TestNearestCutSnapsWithinTolerance(t *testing.T) {
	cuts := []float64{2.1, 7.9, 12}
	if got := nearestCut(2, cuts, 0.5); got != 2.1 {
		t.Fatalf("got %v, want 2.1", got)
	}
	// Outside tolerance the edge stays where it was.
	if got := nearestCut(5, cuts, 0.5); got != 5 {
		t.Fatalf("got %v, want 5", got)
	}
	// Ties and near-ties resolve to the closest cut, not the first one seen.
	if got := nearestCut(7.95, cuts, 4); got != 7.9 {
		t.Fatalf("got %v, want 7.9", got)
	}
}

func TestSnapToCutsMovesEdgesIndependently(t *testing.T) {
	cuts := []float64{2.1, 7.9}
	start, end := snapToCuts(2, 8, cuts, 30, 0.5, 2)
	if start != 2.1 || end != 7.9 {
		t.Fatalf("got %v-%v, want 2.1-7.9", start, end)
	}
	// Only the start is near a cut; the end must not be dragged anywhere.
	start, end = snapToCuts(2, 6, cuts, 30, 0.5, 2)
	if start != 2.1 || end != 6 {
		t.Fatalf("got %v-%v, want 2.1-6", start, end)
	}
}

func TestSnapToCutsRefusesToUndercutMinLength(t *testing.T) {
	// Snapping both edges inward would leave 1.2s, so the clip keeps its range: a
	// boundary is only worth fixing if what is left is still labelable.
	cuts := []float64{3.9, 5.1}
	start, end := snapToCuts(4, 5, cuts, 30, 1, 2)
	if start != 4 || end != 5 {
		t.Fatalf("got %v-%v, want the original 4-5", start, end)
	}
}

func TestSnapToCutsClampsToDuration(t *testing.T) {
	start, end := snapToCuts(6, 11, []float64{10.5}, 10, 1, 2)
	if start != 6 || end != 10 {
		t.Fatalf("got %v-%v, want 6-10", start, end)
	}
}

func TestSnapToCutsWithoutCutsIsIdentity(t *testing.T) {
	start, end := snapToCuts(4, 8, nil, 30, 1, 2)
	if start != 4 || end != 8 {
		t.Fatalf("got %v-%v", start, end)
	}
}
