package primitives

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestTagRoundTrip(t *testing.T) {
	annotation := Tag([]string{"doggy", "nude"})
	if annotation.Type != TagType {
		t.Fatalf("type = %q, want %q", annotation.Type, TagType)
	}
	labels := LabelsOf([]Annotation{annotation})
	if !reflect.DeepEqual(labels, []string{"doggy", "nude"}) {
		t.Fatalf("labels = %v, want [doggy nude]", labels)
	}
}

func TestLabelsOfDecodedJSON(t *testing.T) {
	// Simulate an annotation decoded from storage (labels as []any, not []string).
	raw := `[{"type":"tag","value":{"labels":["blowjob","cumshot"]}},{"type":"rect","value":{"labels":["x"]}}]`
	var annotations []Annotation
	if err := json.Unmarshal([]byte(raw), &annotations); err != nil {
		t.Fatal(err)
	}
	labels := LabelsOf(annotations)
	// Only the tag annotation's labels are flattened; the rect is ignored.
	if !reflect.DeepEqual(labels, []string{"blowjob", "cumshot"}) {
		t.Fatalf("labels = %v, want [blowjob cumshot]", labels)
	}
}

func TestTagsToAnnotationsEmpty(t *testing.T) {
	annotations := TagsToAnnotations(nil)
	if len(annotations) != 1 || annotations[0].Type != TagType {
		t.Fatalf("expected a single empty tag annotation, got %v", annotations)
	}
	if got := LabelsOf(annotations); len(got) != 0 {
		t.Fatalf("empty tag should yield no labels, got %v", got)
	}
}
