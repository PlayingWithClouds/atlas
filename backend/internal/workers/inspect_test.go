package workers

import (
	"strings"
	"testing"

	"atlas/backend/internal/config"
	"atlas/backend/internal/nodes"
)

func graphOf(nodeList []config.WorkflowNode, edges ...config.WorkflowEdge) *config.WorkflowGraph {
	return &config.WorkflowGraph{Nodes: nodeList, Edges: edges}
}

func graphNode(id, nodeType string, params map[string]any) config.WorkflowNode {
	return config.WorkflowNode{ID: id, Type: nodeType, Params: params}
}

func joined(messages []string) string {
	return strings.Join(messages, " | ")
}

func TestValidateGraphAcceptsAWorkingGraph(t *testing.T) {
	graph := graphOf(
		[]config.WorkflowNode{
			graphNode("source-0", "source", nil),
			graphNode("filter-1", "filter", map[string]any{"field": "status", "op": "is", "value": "pending"}),
			graphNode("save-2", "save", map[string]any{"mode": "propose"}),
		},
		config.WorkflowEdge{Source: "source-0", Target: "filter-1"},
		config.WorkflowEdge{Source: "filter-1", Target: "save-2"},
	)
	report := ValidateGraph(graph, "video", "")
	if !report.OK {
		t.Fatalf("errors = %s", joined(report.Errors))
	}
	if len(report.Warnings) != 0 {
		t.Fatalf("warnings = %s", joined(report.Warnings))
	}
}

func TestValidateGraphRejectsStructuralProblems(t *testing.T) {
	cases := []struct {
		name  string
		graph *config.WorkflowGraph
		want  string
	}{
		{
			name:  "unknown type",
			graph: graphOf([]config.WorkflowNode{graphNode("a", "teleport", nil)}),
			want:  "unknown node type",
		},
		{
			name: "dangling edge",
			graph: graphOf([]config.WorkflowNode{graphNode("source-0", "source", nil)},
				config.WorkflowEdge{Source: "source-0", Target: "ghost"}),
			want: "missing node",
		},
		{
			name: "cycle",
			graph: graphOf(
				[]config.WorkflowNode{graphNode("filter-0", "filter", nil), graphNode("filter-1", "filter", nil)},
				config.WorkflowEdge{Source: "filter-0", Target: "filter-1"},
				config.WorkflowEdge{Source: "filter-1", Target: "filter-0"},
			),
			want: "cycle",
		},
		{
			name: "wiring into an entry node",
			graph: graphOf(
				[]config.WorkflowNode{graphNode("source-0", "source", nil), graphNode("source-1", "source", nil)},
				config.WorkflowEdge{Source: "source-0", Target: "source-1"},
			),
			want: "takes no input",
		},
		{
			name:  "empty graph",
			graph: graphOf(nil),
			want:  "empty workflow graph",
		},
	}
	for _, testCase := range cases {
		report := ValidateGraph(testCase.graph, "", "")
		if report.OK {
			t.Fatalf("%s: expected failure", testCase.name)
		}
		if !strings.Contains(joined(report.Errors), testCase.want) {
			t.Fatalf("%s: errors = %s, want something about %q", testCase.name, joined(report.Errors), testCase.want)
		}
	}
}

func TestValidateGraphChecksParams(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]any
		want   string
	}{
		{"unknown key", map[string]any{"windows": 4.0}, "has no param"},
		{"below minimum", map[string]any{"cutScore": 0.0}, "below the minimum"},
		{"above maximum", map[string]any{"merge": 4.0}, "above the maximum"},
		{"not a number", map[string]any{"window": "wide"}, "wants a number"},
		{"bad option", map[string]any{"mode": "vibes"}, "not one of"},
	}
	for _, testCase := range cases {
		graph := graphOf([]config.WorkflowNode{graphNode("segment-0", "segment", testCase.params)})
		report := ValidateGraph(graph, "", "")
		if !strings.Contains(joined(report.Errors), testCase.want) {
			t.Fatalf("%s: errors = %s, want something about %q", testCase.name, joined(report.Errors), testCase.want)
		}
	}
}

func TestValidateGraphWarnsAboutTheWrongContentKind(t *testing.T) {
	graph := graphOf([]config.WorkflowNode{graphNode("segment-0", "segment", nil)})
	report := ValidateGraph(graph, "image", "")
	if !report.OK {
		t.Fatalf("a video node in an image project is a warning, not an error: %s", joined(report.Errors))
	}
	if !strings.Contains(joined(report.Warnings), "does not apply to image projects") {
		t.Fatalf("warnings = %s", joined(report.Warnings))
	}
}

func TestValidateGraphWarnsAboutUnwiredNodes(t *testing.T) {
	graph := graphOf(
		[]config.WorkflowNode{
			graphNode("source-0", "source", nil),
			graphNode("save-1", "save", nil),
			graphNode("notify-2", "notify", nil),
		},
		config.WorkflowEdge{Source: "source-0", Target: "save-1"},
	)
	report := ValidateGraph(graph, "", "")
	if !strings.Contains(joined(report.Warnings), "notify-2") {
		t.Fatalf("warnings = %s", joined(report.Warnings))
	}
}

func TestEstimateNodeCountsAcceptsSplit(t *testing.T) {
	entities := []map[string]any{
		clip("a", 0, 4, nil),
		clip("b", 4, 8, map[string]any{"embedded": false}),
	}
	spec := nodes.Spec{Type: "embed", Input: "entities", Output: "entities",
		Accepts: map[string]any{"embedded": false}}

	estimate, out := estimateNode(graphNode("embed-0", "embed", nil), spec, nil, entities)
	if estimate.In != 2 || estimate.Matched != 1 || estimate.Passthrough != 1 || estimate.Out != 2 {
		t.Fatalf("estimate = %+v", estimate)
	}
	if len(out) != 2 {
		t.Fatalf("out = %d, want the matched item plus the one that flowed around", len(out))
	}
}

func TestEstimateNodeExplainsANodeThatMatchesNothing(t *testing.T) {
	entities := []map[string]any{clip("a", 0, 4, nil)}
	spec := nodes.Spec{Type: "embed", Label: "Embed", Input: "entities", Output: "entities",
		Accepts: map[string]any{"embedded": false}}

	estimate, _ := estimateNode(graphNode("embed-0", "embed", nil), spec, nil, entities)
	if estimate.Matched != 0 || !strings.Contains(estimate.Note, "none of the 1 entities") {
		t.Fatalf("estimate = %+v", estimate)
	}
}

func TestEstimateNodeSimulatesFilterAndSample(t *testing.T) {
	entities := []map[string]any{
		clip("a", 0, 4, nil),
		clip("b", 4, 8, map[string]any{"status": "labeled"}),
		clip("c", 8, 12, nil),
	}
	spec := nodes.Spec{Type: "filter", Input: "entities", Output: "entities"}

	filterNode := graphNode("filter-0", "filter", map[string]any{"field": "status", "op": "is", "value": "pending"})
	estimate, out := estimateNode(filterNode, spec, nil, entities)
	if estimate.Out != 2 || len(out) != 2 {
		t.Fatalf("filter estimate = %+v", estimate)
	}

	sampleSpec := nodes.Spec{Type: "sample", Input: "entities", Output: "entities"}
	sampleNode := graphNode("sample-0", "sample", map[string]any{"count": 1.0})
	estimate, out = estimateNode(sampleNode, sampleSpec, nil, entities)
	if estimate.Out != 1 || len(out) != 1 {
		t.Fatalf("sample estimate = %+v", estimate)
	}
}

func TestEstimateNodeFlagsAFilterThatEmptiesTheStream(t *testing.T) {
	entities := []map[string]any{clip("a", 0, 4, nil)}
	spec := nodes.Spec{Type: "filter", Input: "entities", Output: "entities"}
	filterNode := graphNode("filter-0", "filter", map[string]any{"field": "status", "op": "is", "value": "labeled"})

	estimate, _ := estimateNode(filterNode, spec, nil, entities)
	if estimate.Out != 0 || !strings.Contains(estimate.Note, "empties the stream") {
		t.Fatalf("estimate = %+v", estimate)
	}
}

func TestEstimateNodeReadsTheSessionForEntryNodes(t *testing.T) {
	entities := []map[string]any{clip("a", 0, 4, nil), clip("b", 4, 8, nil)}
	spec := nodes.Spec{Type: "source", Output: "entities"}

	estimate, out := estimateNode(graphNode("source-0", "source", nil), spec, entities, nil)
	if estimate.In != 2 || estimate.Out != 2 || len(out) != 2 {
		t.Fatalf("estimate = %+v", estimate)
	}
}
