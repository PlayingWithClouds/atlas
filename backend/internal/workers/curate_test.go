package workers

import (
	"image"
	"image/color"
	"testing"

	"atlas/backend/internal/primitives"
)

func clip(ref string, start, end float64, extra map[string]any) map[string]any {
	item := map[string]any{"ref": ref, "status": "pending", "embedded": true,
		"t_start": start, "t_end": end}
	for key, value := range extra {
		item[key] = value
	}
	return item
}

func refsOf(items []map[string]any) []string {
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = itemRef(item)
	}
	return out
}

func TestFilterOnText(t *testing.T) {
	items := []map[string]any{
		clip("a", 0, 4, nil),
		clip("b", 4, 8, map[string]any{"status": "labeled"}),
	}
	kept := applyFilter(items, filterPredicate{Field: "status", Op: "is", Value: "pending"})
	if len(kept) != 1 || itemRef(kept[0]) != "a" {
		t.Fatalf("kept = %v", refsOf(kept))
	}
	kept = applyFilter(items, filterPredicate{Field: "status", Op: "not", Value: "pending"})
	if len(kept) != 1 || itemRef(kept[0]) != "b" {
		t.Fatalf("negated kept = %v", refsOf(kept))
	}
}

func TestFilterOnBoolField(t *testing.T) {
	items := []map[string]any{
		clip("a", 0, 4, map[string]any{"embedded": false}),
		clip("b", 4, 8, nil),
	}
	kept := applyFilter(items, filterPredicate{Field: "embedded", Op: "is", Value: "false"})
	if len(kept) != 1 || itemRef(kept[0]) != "a" {
		t.Fatalf("kept = %v", refsOf(kept))
	}
}

func TestFilterOnDuration(t *testing.T) {
	items := []map[string]any{
		clip("short", 0, 1.5, nil),
		clip("long", 2, 8, nil),
		{"ref": "still", "status": "pending"}, // a plain image has no range
	}
	kept := applyFilter(items, filterPredicate{Field: "duration", Op: "gt", Value: "2"})
	if len(kept) != 1 || itemRef(kept[0]) != "long" {
		t.Fatalf("kept = %v", refsOf(kept))
	}
	kept = applyFilter(items, filterPredicate{Field: "duration", Op: "lt", Value: "2"})
	if len(kept) != 1 || itemRef(kept[0]) != "short" {
		t.Fatalf("kept = %v", refsOf(kept))
	}
}

func TestFilterMissingFieldNeverMatches(t *testing.T) {
	// A clip with no prediction is not "confidence below 0.9" — it is not a candidate,
	// or a filter meant to catch uncertain clips would sweep up every unpredicted one.
	items := []map[string]any{clip("a", 0, 4, nil)}
	for _, op := range []string{"gt", "lt", "is", "not"} {
		if kept := applyFilter(items, filterPredicate{Field: "confidence", Op: op, Value: "0.9"}); len(kept) != 0 {
			t.Fatalf("op %s kept %v", op, refsOf(kept))
		}
	}
}

func TestFilterOnAnnotationAndLabel(t *testing.T) {
	tagged := clip("a", 0, 4, map[string]any{
		"annotations": []primitives.Annotation{primitives.Tag([]string{"blowjob"})},
	})
	bare := clip("b", 4, 8, nil)
	items := []map[string]any{tagged, bare}

	kept := applyFilter(items, filterPredicate{Field: "annotation", Op: "is", Value: "tag"})
	if len(kept) != 1 || itemRef(kept[0]) != "a" {
		t.Fatalf("by type = %v", refsOf(kept))
	}
	kept = applyFilter(items, filterPredicate{Field: "label", Op: "is", Value: "blowjob"})
	if len(kept) != 1 || itemRef(kept[0]) != "a" {
		t.Fatalf("by label = %v", refsOf(kept))
	}
	kept = applyFilter(items, filterPredicate{Field: "label", Op: "not", Value: "blowjob"})
	if len(kept) != 1 || itemRef(kept[0]) != "b" {
		t.Fatalf("negated label = %v", refsOf(kept))
	}
}

func TestFilterOnDecodedPluginAnnotations(t *testing.T) {
	// Plugin nodes hand back JSON-decoded maps rather than typed annotations.
	item := clip("a", 0, 4, map[string]any{
		"annotations": []any{map[string]any{"type": "tag", "value": map[string]any{"labels": []any{"anal"}}}},
	})
	kept := applyFilter([]map[string]any{item}, filterPredicate{Field: "label", Op: "is", Value: "anal"})
	if len(kept) != 1 {
		t.Fatalf("kept = %v", refsOf(kept))
	}
}

func TestTakeFirst(t *testing.T) {
	items := []map[string]any{clip("a", 0, 1, nil), clip("b", 1, 2, nil), clip("c", 2, 3, nil)}
	if got := takeFirst(items, 0); len(got) != 3 {
		t.Fatalf("count 0 should keep everything, got %d", len(got))
	}
	if got := takeFirst(items, 99); len(got) != 3 {
		t.Fatalf("count past the end should keep everything, got %d", len(got))
	}
	if got := takeFirst(items, 2); len(got) != 2 || itemRef(got[1]) != "b" {
		t.Fatalf("got %v", refsOf(got))
	}
}

func TestShuffledKeepsEveryItem(t *testing.T) {
	items := []map[string]any{clip("a", 0, 1, nil), clip("b", 1, 2, nil), clip("c", 2, 3, nil)}
	shuffledItems := shuffled(items)
	if len(shuffledItems) != len(items) {
		t.Fatalf("len = %d, want %d", len(shuffledItems), len(items))
	}
	seen := map[string]bool{}
	for _, item := range shuffledItems {
		seen[itemRef(item)] = true
	}
	for _, ref := range []string{"a", "b", "c"} {
		if !seen[ref] {
			t.Fatalf("%s went missing: %v", ref, refsOf(shuffledItems))
		}
	}
	// The input order must survive: sample is not supposed to mutate the stream.
	if itemRef(items[0]) != "a" {
		t.Fatal("shuffled reordered its input")
	}
}

// solid paints one colour; checkers alternates black and white cells.
func solid(luma uint8) image.Image {
	picture := image.NewGray(image.Rect(0, 0, 64, 64))
	for y := range 64 {
		for x := range 64 {
			picture.SetGray(x, y, color.Gray{Y: luma})
		}
	}
	return picture
}

func checkers() image.Image {
	picture := image.NewGray(image.Rect(0, 0, 64, 64))
	for y := range 64 {
		for x := range 64 {
			shade := uint8(0)
			if (x/8+y/8)%2 == 0 {
				shade = 255
			}
			picture.SetGray(x, y, color.Gray{Y: shade})
		}
	}
	return picture
}

func TestMeasureLuma(t *testing.T) {
	black := measureLuma(solid(0))
	if !black.OK || black.Luma > 1 || black.Contrast > 1 {
		t.Fatalf("black = %+v", black)
	}
	grey := measureLuma(solid(128))
	if grey.Luma < 120 || grey.Luma > 136 || grey.Contrast > 1 {
		t.Fatalf("flat grey = %+v", grey)
	}
	textured := measureLuma(checkers())
	if textured.Contrast < 50 {
		t.Fatalf("checkerboard should read as high contrast: %+v", textured)
	}
}

func TestQualityRejects(t *testing.T) {
	settings := qualitySettings{Check: "both", Black: 16, Flat: 8}
	if !settings.rejects(measureLuma(solid(0))) {
		t.Fatal("a black thumbnail should be rejected")
	}
	if !settings.rejects(measureLuma(solid(128))) {
		t.Fatal("a flat thumbnail should be rejected")
	}
	if settings.rejects(measureLuma(checkers())) {
		t.Fatal("a textured thumbnail should pass")
	}

	blackOnly := qualitySettings{Check: "black", Black: 16, Flat: 8}
	if blackOnly.rejects(measureLuma(solid(128))) {
		t.Fatal("flat grey is not black")
	}
	flatOnly := qualitySettings{Check: "flat", Black: 16, Flat: 8}
	if !flatOnly.rejects(measureLuma(solid(0))) {
		t.Fatal("black is also flat")
	}
}

func TestQualityKeepsUnreadableThumbnails(t *testing.T) {
	// A poster that could not be cut is a caching problem; deleting entities over it
	// would be the wrong answer.
	settings := qualitySettings{Check: "both", Black: 16, Flat: 8}
	if settings.rejects(thumbnailMetrics{}) {
		t.Fatal("an unreadable thumbnail must pass")
	}
}
