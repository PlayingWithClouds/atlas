package workers

import (
	"testing"

	"atlas/backend/internal/config"
	"atlas/backend/internal/nodes"
	"atlas/backend/internal/primitives"
)

func node(id, typ string) config.WorkflowNode {
	return config.WorkflowNode{ID: id, Type: typ}
}

// testCatalog covers the ports exercised by the executor tests.
func testCatalog() map[string]nodes.Spec {
	return map[string]nodes.Spec{
		"source":  {Type: "source", Output: "entities", Source: "builtin"},
		"extract": {Type: "extract", Input: "entities", Output: "entities", Source: "builtin"},
		"embed":   {Type: "embed", Input: "entities", Output: "entities", Source: "model"},
		"predict": {Type: "predict", Input: "entities", Output: "entities", Source: "model"},
		"save":    {Type: "save", Input: "entities", Output: "entities", Source: "builtin"},
		"notify":  {Type: "notify", Input: "entities", Source: "builtin"},
		"export":  {Type: "export", Source: "builtin"},
	}
}

func TestPlanGraphTopoOrder(t *testing.T) {
	graph := &config.WorkflowGraph{
		Nodes: []config.WorkflowNode{node("a", "source"), node("b", "embed"), node("c", "save")},
		Edges: []config.WorkflowEdge{{Source: "a", Target: "b"}, {Source: "b", Target: "c"}},
	}
	ordered, err := planGraph(graph, testCatalog())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"a", "b", "c"}
	for i, id := range want {
		if ordered[i].ID != id {
			t.Fatalf("order[%d] = %q, want %q", i, ordered[i].ID, id)
		}
	}
}

func TestPlanGraphRejectsEdgeIntoInputlessNode(t *testing.T) {
	// export takes no input, so nothing may connect into it.
	graph := &config.WorkflowGraph{
		Nodes: []config.WorkflowNode{node("a", "source"), node("b", "export")},
		Edges: []config.WorkflowEdge{{Source: "a", Target: "b"}},
	}
	if _, err := planGraph(graph, testCatalog()); err == nil {
		t.Fatal("expected inputless-target error, got nil")
	}
}

func TestPlanGraphRejectsEdgeFromTerminalNode(t *testing.T) {
	// notify has no output, so nothing may connect out of it.
	graph := &config.WorkflowGraph{
		Nodes: []config.WorkflowNode{node("a", "source"), node("b", "notify"), node("c", "save")},
		Edges: []config.WorkflowEdge{{Source: "a", Target: "b"}, {Source: "b", Target: "c"}},
	}
	if _, err := planGraph(graph, testCatalog()); err == nil {
		t.Fatal("expected outputless-source error, got nil")
	}
}

func TestPlanGraphRejectsCycle(t *testing.T) {
	graph := &config.WorkflowGraph{
		Nodes: []config.WorkflowNode{node("a", "extract"), node("b", "extract")},
		Edges: []config.WorkflowEdge{{Source: "a", Target: "b"}, {Source: "b", Target: "a"}},
	}
	if _, err := planGraph(graph, testCatalog()); err == nil {
		t.Fatal("expected cycle error, got nil")
	}
}

func TestPlanGraphRejectsUnknownType(t *testing.T) {
	graph := &config.WorkflowGraph{Nodes: []config.WorkflowNode{node("a", "bogus")}}
	if _, err := planGraph(graph, testCatalog()); err == nil {
		t.Fatal("expected unknown-type error, got nil")
	}
}

func TestItemsFromInputsMergesAndDedupes(t *testing.T) {
	inputs := []any{
		[]map[string]any{{"ref": "a"}, {"ref": "b"}},
		[]any{map[string]any{"ref": "b", "extra": true}, map[string]any{"ref": "c"}},
		"not items",
	}
	items := itemsFromInputs(inputs)
	if len(items) != 3 {
		t.Fatalf("len = %d, want 3", len(items))
	}
	want := []string{"a", "b", "c"}
	for i, ref := range want {
		if itemRef(items[i]) != ref {
			t.Fatalf("items[%d].ref = %q, want %q", i, itemRef(items[i]), ref)
		}
	}
	if _, hasExtra := items[1]["extra"]; hasExtra {
		t.Fatal("duplicate ref should keep the first item")
	}
}

func TestMatchesAccepts(t *testing.T) {
	item := map[string]any{
		"ref":      "a",
		"status":   "pending",
		"embedded": true,
		"annotations": []primitives.Annotation{
			{Type: "rect", Value: map[string]any{}},
		},
	}
	cases := []struct {
		accepts map[string]any
		want    bool
	}{
		{nil, true},
		{map[string]any{"status": "pending"}, true},
		{map[string]any{"status": "labeled"}, false},
		{map[string]any{"embedded": true}, true},
		{map[string]any{"embedded": false}, false},
		{map[string]any{"annotation": "rect"}, true},
		{map[string]any{"annotation": "tag"}, false},
		{map[string]any{"status": "pending", "embedded": true}, true},
	}
	for i, testCase := range cases {
		if got := matchesAccepts(item, testCase.accepts); got != testCase.want {
			t.Fatalf("case %d: matchesAccepts = %v, want %v", i, got, testCase.want)
		}
	}
}

func TestSplitByAccepts(t *testing.T) {
	items := []map[string]any{
		{"ref": "a", "embedded": true},
		{"ref": "b", "embedded": false},
	}
	matching, passthrough := splitByAccepts(items, map[string]any{"embedded": true})
	if len(matching) != 1 || itemRef(matching[0]) != "a" {
		t.Fatalf("matching = %v", matching)
	}
	if len(passthrough) != 1 || itemRef(passthrough[0]) != "b" {
		t.Fatalf("passthrough = %v", passthrough)
	}
}

func TestMergeProducedItemsKeepsUpstreamFields(t *testing.T) {
	inputs := []map[string]any{
		{"ref": "a", "status": "pending", "embedded": true},
		{"ref": "b", "status": "pending", "embedded": true},
	}
	produced := []map[string]any{
		{"ref": "a"},                      // sparse survivor (e.g. dedupe)
		{"ref": "b", "embedded": false},   // produced fields win over upstream
		{"ref": "new", "generated": true}, // unknown ref passes through as-is
	}
	merged := mergeProducedItems(inputs, produced)
	if len(merged) != 3 {
		t.Fatalf("len = %d, want 3", len(merged))
	}
	if merged[0]["status"] != "pending" || merged[0]["embedded"] != true {
		t.Fatalf("survivor lost upstream fields: %v", merged[0])
	}
	if merged[1]["embedded"] != false {
		t.Fatalf("produced field should win: %v", merged[1])
	}
	if merged[2]["generated"] != true {
		t.Fatalf("generated item mangled: %v", merged[2])
	}
}

func TestRenderNotifyMessageHandlebars(t *testing.T) {
	inputs := []any{[]map[string]any{{"ref": "a"}, {"ref": "b"}}}
	got := renderNotifyMessage("done {{count}} images ({{length inputs.[0]}})", RunContext{ImageIdx: -1}, inputs)
	if got != "done 2 images (2)" {
		t.Fatalf("rendered = %q", got)
	}
}

func TestRenderNotifyMessageKeepsRawOnTemplateError(t *testing.T) {
	got := renderNotifyMessage("broken {{#if}}", RunContext{ImageIdx: -1}, nil)
	if got != "broken {{#if}}" {
		t.Fatalf("rendered = %q", got)
	}
}

func TestSkippedNodeMessageNamesTheUnmetCondition(t *testing.T) {
	embed := nodes.Spec{Type: "siglip.embed", Label: "Embed", Accepts: map[string]any{"embedded": false}}
	got := skippedNodeMessage(embed, 328)
	want := "Embed skipped — none of the 328 entities are unembedded"
	if got != want {
		t.Errorf("message = %q, want %q", got, want)
	}

	// Several conditions read in a stable order.
	predict := nodes.Spec{Type: "predict", Label: "Predict", Accepts: map[string]any{"embedded": true, "status": "pending"}}
	got = skippedNodeMessage(predict, 12)
	want = "Predict skipped — none of the 12 entities are embedded and pending"
	if got != want {
		t.Errorf("message = %q, want %q", got, want)
	}

	// No declared filter: still say which node stood down.
	plain := nodes.Spec{Type: "custom", Label: "Custom"}
	if got := skippedNodeMessage(plain, 3); got != "Custom skipped — no entities matched" {
		t.Errorf("message = %q, want the generic form", got)
	}
}
