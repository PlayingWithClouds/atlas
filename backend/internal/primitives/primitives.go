// Package primitives is the annotation vocabulary (Label Studio–style result schema)
// exchanged over plugin RPC and stored per image. Only `tag` is wired end-to-end; region
// types (rect/polygon/keypoint/mask) are defined but the UI is pending.
package primitives

const (
	TagType     = "tag"
	RectType    = "rect"
	PolygonType = "polygon"
	KeypointpT  = "keypoint"
	MaskType    = "mask"
)

// Annotation is one typed labeling result on an image: {type, value}.
type Annotation struct {
	Type  string         `json:"type"`
	Value map[string]any `json:"value"`
}

// Tag builds a tag annotation wrapping a class list.
func Tag(labels []string) Annotation {
	values := make([]any, len(labels))
	for i, label := range labels {
		values[i] = label
	}
	return Annotation{Type: TagType, Value: map[string]any{"labels": values}}
}

// TagsToAnnotations wraps a class list as a single tag annotation. Empty lists still
// produce one annotation; the store drops empty tags when cleaning.
func TagsToAnnotations(labels []string) []Annotation {
	return []Annotation{Tag(labels)}
}

// LabelsOf flattens the class labels across all tag annotations.
func LabelsOf(annotations []Annotation) []string {
	var out []string
	for _, annotation := range annotations {
		if annotation.Type != TagType {
			continue
		}
		out = append(out, labelStrings(annotation.Value)...)
	}
	return out
}

// labelStrings coerces value["labels"] (which decodes as []any) into []string.
func labelStrings(value map[string]any) []string {
	raw, ok := value["labels"]
	if !ok {
		return nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if str, ok := item.(string); ok {
			out = append(out, str)
		}
	}
	return out
}
