// Package nodes is the workflow node catalog. It merges built-in nodes (simple
// orchestration steps implemented in Go) with plugin-provided nodes harvested
// from the plugin registry. A plugin advertises a node by declaring a capability
// named "node" whose fields describe the node's ports, params, and RPC method.
package nodes

import (
	"atlas/backend/internal/registry"
)

// ParamSpec describes one editable parameter on a node.
type ParamSpec struct {
	Key         string   `json:"key"`
	Kind        string   `json:"kind"` // string | text (multiline) | number | option
	Label       string   `json:"label"`
	Default     any      `json:"default"`
	Options     []string `json:"options,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
	Min         *float64 `json:"min,omitempty"`
	Max         *float64 `json:"max,omitempty"`
	Step        *float64 `json:"step,omitempty"`
}

// Spec is one node type in the catalog. Nodes exchange entity item streams; an
// edge is valid when the upstream has an output and the downstream has an input.
// Accepts declares the exact entities a node works on (field equality over the
// entity snapshot, plus the special "annotation" key = has annotation of type);
// non-matching items pass through around the node.
type Spec struct {
	Type        string         `json:"type"`
	Label       string         `json:"label"`
	Description string         `json:"description"`
	Input       string         `json:"input"`  // empty = entry node
	Output      string         `json:"output"` // empty = terminal node
	Source      string         `json:"source"` // "builtin" or the plugin id
	Plugin      string         `json:"plugin,omitempty"`
	Method      string         `json:"method,omitempty"` // plugin RPC method
	Batch       int            `json:"batch,omitempty"`  // items per RPC call; 0 = all at once
	Accepts     map[string]any `json:"accepts,omitempty"`
	Emits       map[string]any `json:"emits,omitempty"` // fields the node sets on its output items
	// ContentKinds limits the node to projects labelling that kind of entity
	// ("image" or "video"); empty means it applies to both. A plugin declares this
	// on its node capability — the JoyTag tagger reads a still, so it never applies
	// to a project whose entities are temporal spans.
	ContentKinds []string    `json:"content_kinds,omitempty"`
	Params       []ParamSpec `json:"params"`
}

// AppliesTo reports whether this node is offered to a project labelling contentKind.
func (spec Spec) AppliesTo(contentKind string) bool {
	if len(spec.ContentKinds) == 0 {
		return true
	}
	for _, kind := range spec.ContentKinds {
		if kind == contentKind {
			return true
		}
	}
	return false
}

func ptr(value float64) *float64 { return &value }

// builtins are the simple, always-available nodes implemented directly in Go.
func builtins() []Spec {
	return []Spec{
		{Type: "source", Label: "Source", Description: "The session's images", Output: "entities", Source: "builtin", Params: []ParamSpec{}},
		// Extract turns a video source into stills, segment turns it into spans: each
		// only makes sense for the project whose entities it produces.
		{Type: "extract", Label: "Extract frames", Description: "Stream video frames into the session", Input: "entities", Output: "entities", Source: "builtin", ContentKinds: []string{"image"}, Params: []ParamSpec{}},
		// Fixed mode lays windows out by arithmetic on the duration; scene mode cuts where
		// the video actually changes (ffmpeg shot detection, then merging the neighbouring
		// clips an embedding says are the same content).
		{Type: "segment", Label: "Segment video", Description: "Generate temporal clip entities over the video (fixed windows or detected scenes)", Input: "entities", Output: "entities", Source: "builtin", ContentKinds: []string{"video"}, Params: []ParamSpec{
			{Key: "mode", Kind: "option", Label: "Cut at", Default: "fixed", Options: []string{"fixed", "scenes"}},
			{Key: "window", Kind: "number", Label: "Window (s) — fixed: length, scenes: max", Default: 4, Min: ptr(0.1), Step: ptr(0.5)},
			{Key: "stride", Kind: "number", Label: "Stride (s) — fixed only", Default: 4, Min: ptr(0.1), Step: ptr(0.5)},
			{Key: "minLen", Kind: "number", Label: "Min length (s) — scenes only", Default: 2, Min: ptr(0.1), Step: ptr(0.5)},
			{Key: "cutScore", Kind: "number", Label: "Cut sensitivity — scenes only", Default: 0.3, Min: ptr(0.05), Max: ptr(1), Step: ptr(0.05)},
			{Key: "merge", Kind: "number", Label: "Merge similarity — scenes only, 0 = off", Default: 0.9, Min: ptr(0), Max: ptr(1), Step: ptr(0.01)},
		}},
		// Curation nodes shape the stream itself. Unlike a node's `accepts` — which lets
		// non-matching entities flow around it — filter and sample drop what they exclude,
		// so what reaches the next node is exactly what passed.
		{Type: "filter", Label: "Filter", Description: "Keep only the entities matching a condition", Input: "entities", Output: "entities", Source: "builtin", Params: []ParamSpec{
			{Key: "field", Kind: "option", Label: "Field", Default: "status", Options: []string{"status", "embedded", "duration", "confidence", "annotation", "label"}},
			{Key: "op", Kind: "option", Label: "Is", Default: "is", Options: []string{"is", "not", "gt", "lt"}},
			{Key: "value", Kind: "string", Label: "Value", Default: "pending", Placeholder: "pending"},
		}},
		{Type: "sample", Label: "Sample", Description: "Reorder the entities and optionally keep only the first N", Input: "entities", Output: "entities", Source: "builtin", Params: []ParamSpec{
			{Key: "order", Kind: "option", Label: "Order by", Default: "natural", Options: []string{"natural", "random", "uncertain"}},
			{Key: "count", Kind: "number", Label: "Keep (0 = all)", Default: 0, Min: ptr(0), Step: ptr(10)},
		}},
		{Type: "quality", Label: "Quality gate", Description: "Drop black or flat entities, judged from their thumbnail", Input: "entities", Output: "entities", Source: "builtin", Params: []ParamSpec{
			{Key: "check", Kind: "option", Label: "Reject", Default: "both", Options: []string{"black", "flat", "both"}},
			{Key: "black", Kind: "number", Label: "Black below (luma)", Default: 16, Min: ptr(0), Max: ptr(255), Step: ptr(1)},
			{Key: "flat", Kind: "number", Label: "Flat below (contrast)", Default: 8, Min: ptr(0), Max: ptr(128), Step: ptr(1)},
			{Key: "action", Kind: "option", Label: "On reject", Default: "drop", Options: []string{"drop", "skip", "delete"}},
		}},
		{Type: "trim", Label: "Trim to scenes", Description: "Snap clip boundaries onto nearby detected scene cuts", Input: "entities", Output: "entities", Source: "builtin", ContentKinds: []string{"video"}, Params: []ParamSpec{
			{Key: "tolerance", Kind: "number", Label: "Snap within (s)", Default: 1, Min: ptr(0.1), Step: ptr(0.5)},
			{Key: "minLen", Kind: "number", Label: "Min length (s)", Default: 2, Min: ptr(0.1), Step: ptr(0.5)},
			{Key: "cutScore", Kind: "number", Label: "Cut sensitivity", Default: 0.3, Min: ptr(0.05), Max: ptr(1), Step: ptr(0.05)},
		}},
		{Type: "save", Label: "Save", Description: "Persist node results (annotations, embeddings) onto the entities", Input: "entities", Output: "entities", Source: "builtin", Params: []ParamSpec{
			{Key: "mode", Kind: "option", Label: "Write as", Default: "propose", Options: []string{"propose", "confirm"}},
		}},
		{Type: "action", Label: "Action", Description: "Accept, reject, skip or delete the entities flowing into this branch", Input: "entities", Output: "entities", Source: "builtin", Params: []ParamSpec{
			{Key: "action", Kind: "option", Label: "Do", Default: "accept", Options: []string{"accept", "reject", "skip", "delete"}},
		}},
		{Type: "notify", Label: "Notify", Description: "Show a custom notification; Handlebars template over the incoming entities", Input: "entities", Source: "builtin", Params: []ParamSpec{
			{Key: "message", Kind: "text", Label: "Message", Default: "", Placeholder: "Done — {{count}} images"},
			{Key: "kind", Kind: "option", Label: "Show as", Default: "transient", Options: []string{"transient", "persistent"}},
		}},
		{Type: "export", Label: "Export", Description: "Write the labeled pool to a dataset", Source: "builtin", Params: []ParamSpec{
			{Key: "outDir", Kind: "string", Label: "Output dir", Default: "export", Placeholder: "export"},
		}},
	}
}

// pluginNodes harvests node specs from every healthy plugin's "node" capabilities.
func pluginNodes() []Spec {
	var out []Spec
	for _, plugin := range registry.Default.Providers("node") {
		for _, capability := range plugin.Capabilities {
			if name, _ := capability["name"].(string); name != "node" {
				continue
			}
			spec, ok := specFromCapability(plugin.ID, capability)
			if ok {
				out = append(out, spec)
			}
		}
	}
	return out
}

func specFromCapability(pluginID string, capability map[string]any) (Spec, bool) {
	nodeType, _ := capability["type"].(string)
	if nodeType == "" {
		return Spec{}, false
	}
	spec := Spec{
		Type:        nodeType,
		Label:       stringField(capability, "label", nodeType),
		Description: stringField(capability, "description", ""),
		Input:       stringField(capability, "input", "entities"),
		Output:      stringField(capability, "output", "entities"),
		Source:      pluginID,
		Plugin:      pluginID,
		Method:      stringField(capability, "method", nodeType),
		Batch:       intField(capability, "batch"),
		Accepts:      mapField(capability, "accepts"),
		Emits:        mapField(capability, "emits"),
		ContentKinds: stringSliceField(capability, "content_kinds"),
		Params:       paramsField(capability["params"]),
	}
	return spec, true
}

func stringSliceField(m map[string]any, key string) []string {
	list, ok := m[key].([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, item := range list {
		if value, ok := item.(string); ok && value != "" {
			out = append(out, value)
		}
	}
	return out
}

func stringField(m map[string]any, key, fallback string) string {
	if value, ok := m[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

// intField reads a numeric capability field (JSON numbers decode as float64).
func intField(m map[string]any, key string) int {
	if value, ok := m[key].(float64); ok {
		return int(value)
	}
	return 0
}

func mapField(m map[string]any, key string) map[string]any {
	if value, ok := m[key].(map[string]any); ok {
		return value
	}
	return nil
}

// floatField reads an optional numeric param field as a pointer (absent = nil).
func floatField(m map[string]any, key string) *float64 {
	if value, ok := m[key].(float64); ok {
		return &value
	}
	return nil
}

func paramsField(raw any) []ParamSpec {
	list, ok := raw.([]any)
	if !ok {
		return []ParamSpec{}
	}
	params := make([]ParamSpec, 0, len(list))
	for _, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		param := ParamSpec{
			Key:         stringField(entry, "key", ""),
			Kind:        stringField(entry, "kind", "string"),
			Label:       stringField(entry, "label", ""),
			Default:     entry["default"],
			Placeholder: stringField(entry, "placeholder", ""),
			Min:         floatField(entry, "min"),
			Max:         floatField(entry, "max"),
			Step:        floatField(entry, "step"),
		}
		if options, ok := entry["options"].([]any); ok {
			for _, option := range options {
				if str, ok := option.(string); ok {
					param.Options = append(param.Options, str)
				}
			}
		}
		if param.Key != "" {
			params = append(params, param)
		}
	}
	return params
}

// Catalog returns the full node catalog: built-ins plus healthy plugin nodes.
func Catalog() []Spec {
	return append(builtins(), pluginNodes()...)
}

// CatalogFor narrows the catalog to what a project can actually run, so the designer
// does not offer nodes that would silently do nothing:
//
//   - nodes limited to the other content kind (frame extraction in a clip project),
//   - nodes from a model plugin that is not this project's. Every project embeds
//     with exactly one backbone; a vector written by another plugin lands in a
//     different pool and no downstream predict can read it.
//
// Saved workflows are unaffected — the executor resolves node types against the
// full Catalog, so a graph built before a project switched models still runs.
func CatalogFor(contentKind, modelPlugin string) []Spec {
	otherModels := map[string]bool{}
	for _, plugin := range registry.Default.Providers("model") {
		if plugin.ID != modelPlugin {
			otherModels[plugin.ID] = true
		}
	}
	var out []Spec
	for _, spec := range Catalog() {
		if !spec.AppliesTo(contentKind) || otherModels[spec.Source] {
			continue
		}
		out = append(out, spec)
	}
	return out
}

// Find returns the spec for a node type from the current catalog.
func Find(nodeType string) (Spec, bool) {
	for _, spec := range Catalog() {
		if spec.Type == nodeType {
			return spec, true
		}
	}
	return Spec{}, false
}
