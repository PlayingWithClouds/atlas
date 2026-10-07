package nodes

import "testing"

func TestAppliesToOnlyLimitsWhenDeclared(t *testing.T) {
	unrestricted := Spec{Type: "save"}
	if !unrestricted.AppliesTo("video") || !unrestricted.AppliesTo("image") {
		t.Error("a node with no declared content kinds must apply to every project")
	}

	tagger := Spec{Type: "joytag", ContentKinds: []string{"image"}}
	if !tagger.AppliesTo("image") {
		t.Error("joytag must be offered to an image project")
	}
	if tagger.AppliesTo("video") {
		t.Error("joytag reads a still, so a clip project must not be offered it")
	}
}

func TestBuiltinsSplitExtractAndSegmentByContentKind(t *testing.T) {
	kinds := map[string][]string{}
	for _, spec := range builtins() {
		kinds[spec.Type] = spec.ContentKinds
	}
	if got := kinds["extract"]; len(got) != 1 || got[0] != "image" {
		t.Errorf("extract content kinds = %v, want [image]: it produces stills", got)
	}
	if got := kinds["segment"]; len(got) != 1 || got[0] != "video" {
		t.Errorf("segment content kinds = %v, want [video]: it produces spans", got)
	}
	if got := kinds["trim"]; len(got) != 1 || got[0] != "video" {
		t.Errorf("trim content kinds = %v, want [video]: it moves span boundaries", got)
	}
	// Everything else stays available to both, or existing image workflows lose nodes.
	for _, spec := range builtins() {
		if spec.Type == "extract" || spec.Type == "segment" || spec.Type == "trim" {
			continue
		}
		if len(spec.ContentKinds) != 0 {
			t.Errorf("%s restricted to %v, want unrestricted", spec.Type, spec.ContentKinds)
		}
	}
}

// The registry is empty in a unit test, so CatalogFor exercises the content-kind
// half of the filter here; the model-plugin half is covered by AppliesTo's sibling
// rule being a plain set membership test over registry providers.
func TestCatalogForHidesTheOtherContentKind(t *testing.T) {
	video := map[string]bool{}
	for _, spec := range CatalogFor("video", "siglip") {
		video[spec.Type] = true
	}
	if video["extract"] {
		t.Error("a clip project was offered frame extraction")
	}
	if !video["segment"] {
		t.Error("a clip project must still be offered segmentation")
	}

	image := map[string]bool{}
	for _, spec := range CatalogFor("image", "model") {
		image[spec.Type] = true
	}
	if image["segment"] {
		t.Error("an image project was offered clip segmentation")
	}
	if !image["extract"] || !image["save"] {
		t.Error("an image project lost nodes it can run")
	}
}
