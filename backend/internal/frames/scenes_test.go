package frames

import "testing"

// Real ffmpeg output: the metadata filter prints a frame line per selected frame,
// followed by the score that selected it.
const sceneOutput = `frame:0    pts:0       pts_time:0
lavfi.scene_score=0.000000
frame:31   pts:31744   pts_time:1.322667
lavfi.scene_score=0.412331
frame:96   pts:98304   pts_time:4.096
lavfi.scene_score=0.884019
`

func TestParseSceneCuts(t *testing.T) {
	cuts := ParseSceneCuts(sceneOutput)
	want := []float64{0, 1.322667, 4.096}
	if len(cuts) != len(want) {
		t.Fatalf("len = %d, want %d (%v)", len(cuts), len(want), cuts)
	}
	for i, expected := range want {
		if cuts[i] != expected {
			t.Fatalf("cut[%d] = %v, want %v", i, cuts[i], expected)
		}
	}
}

func TestParseSceneCutsIgnoresNoise(t *testing.T) {
	// A killed pass leaves a partial line, and a score line carries no timestamp.
	cuts := ParseSceneCuts("lavfi.scene_score=0.5\nframe:1 pts:1024 pts_time:0.04\nframe:2 pts:20")
	if len(cuts) != 1 || cuts[0] != 0.04 {
		t.Fatalf("cuts = %v, want [0.04]", cuts)
	}
}

func TestParseSceneCutsEmpty(t *testing.T) {
	if cuts := ParseSceneCuts(""); cuts != nil {
		t.Fatalf("cuts = %v, want nil", cuts)
	}
}

func TestSceneTimeoutHasAFloor(t *testing.T) {
	// A 30s clip must not get a 15s deadline; a two-hour film must get more than the floor.
	if got := sceneTimeout(30); got != sceneFloorTimeout {
		t.Fatalf("sceneTimeout(30) = %v, want %v", got, sceneFloorTimeout)
	}
	if got := sceneTimeout(7200); got <= sceneFloorTimeout {
		t.Fatalf("sceneTimeout(7200) = %v, want > %v", got, sceneFloorTimeout)
	}
}
