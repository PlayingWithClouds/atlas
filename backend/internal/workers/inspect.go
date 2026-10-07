// Graph inspection: what a workflow is, and what it would do, without running it.
// Authoring a graph — by hand in the designer or by an assistant — needs an answer to
// "is this wired correctly" and "would this touch anything" that costs nothing and
// writes nothing.
package workers

import (
	"context"
	"fmt"
	"sort"

	"atlas/backend/internal/config"
	"atlas/backend/internal/nodes"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/store"
)

// GraphReport is the outcome of checking a graph. Errors mean it cannot run; warnings
// mean it can, but probably not as intended.
type GraphReport struct {
	OK       bool     `json:"ok"`
	Errors   []string `json:"errors"`
	Warnings []string `json:"warnings"`
}

// ValidateGraph checks a graph the way a run would, plus the param and shape problems a
// run would simply carry out. It never touches a session.
func ValidateGraph(graph *config.WorkflowGraph, contentKind, modelPlugin string) GraphReport {
	report := GraphReport{Errors: []string{}, Warnings: []string{}}
	catalog := specIndex()

	if _, err := planGraph(graph, catalog); err != nil {
		report.Errors = append(report.Errors, err.Error())
		// Node-level checks below still run: an unknown type is worth reporting
		// alongside the params of the nodes that are known.
	}
	if graph == nil {
		return report
	}

	for _, node := range graph.Nodes {
		spec, known := catalog[node.Type]
		if !known {
			continue
		}
		report.Errors = append(report.Errors, paramErrors(node, spec)...)
		if contentKind != "" && !spec.AppliesTo(contentKind) {
			report.Warnings = append(report.Warnings, fmt.Sprintf(
				"node %s (%s) does not apply to %s projects", node.ID, node.Type, contentKind))
		}
		if spec.Plugin != "" && modelPlugin != "" && spec.Plugin != modelPlugin {
			report.Warnings = append(report.Warnings, fmt.Sprintf(
				"node %s comes from plugin %q, but this project uses %q", node.ID, spec.Plugin, modelPlugin))
		}
	}
	report.Warnings = append(report.Warnings, danglingNodeWarnings(graph, catalog)...)
	report.OK = len(report.Errors) == 0
	return report
}

// paramErrors reports params the designer would have prevented but an API caller
// (or an assistant) can still send: unknown keys, out-of-range numbers, bad options.
func paramErrors(node config.WorkflowNode, spec nodes.Spec) []string {
	byKey := map[string]nodes.ParamSpec{}
	for _, param := range spec.Params {
		byKey[param.Key] = param
	}

	var problems []string
	for _, key := range sortedKeys(node.Params) {
		param, known := byKey[key]
		if !known {
			problems = append(problems, fmt.Sprintf("node %s (%s) has no param %q", node.ID, node.Type, key))
			continue
		}
		if problem := paramProblem(node, param, node.Params[key]); problem != "" {
			problems = append(problems, problem)
		}
	}
	return problems
}

func paramProblem(node config.WorkflowNode, param nodes.ParamSpec, value any) string {
	if param.Kind == "option" {
		return optionProblem(node, param, value)
	}
	if param.Kind != "number" {
		return ""
	}
	number, ok := toFloat(value)
	if !ok {
		return fmt.Sprintf("node %s: param %q wants a number, got %v", node.ID, param.Key, value)
	}
	if param.Min != nil && number < *param.Min {
		return fmt.Sprintf("node %s: param %q is %v, below the minimum %v", node.ID, param.Key, number, *param.Min)
	}
	if param.Max != nil && number > *param.Max {
		return fmt.Sprintf("node %s: param %q is %v, above the maximum %v", node.ID, param.Key, number, *param.Max)
	}
	return ""
}

func optionProblem(node config.WorkflowNode, param nodes.ParamSpec, value any) string {
	text := fmt.Sprintf("%v", value)
	for _, option := range param.Options {
		if option == text {
			return ""
		}
	}
	return fmt.Sprintf("node %s: param %q is %q, not one of %v", node.ID, param.Key, text, param.Options)
}

// danglingNodeWarnings flags nodes that are wired to nothing. They are legal — the
// executor runs every node in the graph — but a save left unconnected saves the session
// rather than the branch its author meant, which is the kind of mistake worth naming.
func danglingNodeWarnings(graph *config.WorkflowGraph, catalog map[string]nodes.Spec) []string {
	wired := map[string]bool{}
	for _, edge := range graph.Edges {
		wired[edge.Source] = true
		wired[edge.Target] = true
	}
	var warnings []string
	for _, node := range graph.Nodes {
		if wired[node.ID] || len(graph.Nodes) == 1 {
			continue
		}
		if spec, known := catalog[node.Type]; known && spec.Input == "" && spec.Output == "" {
			continue // a standalone terminal node (export) is wired to nothing by design
		}
		warnings = append(warnings, fmt.Sprintf("node %s (%s) is not connected to anything", node.ID, node.Type))
	}
	return warnings
}

func sortedKeys(params map[string]any) []string {
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// NodeEstimate is one node's share of a dry run.
type NodeEstimate struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	In          int    `json:"in"`
	Matched     int    `json:"matched"`
	Passthrough int    `json:"passthrough"`
	Out         int    `json:"out"`
	Note        string `json:"note,omitempty"`
}

// DryRunReport is what a graph would touch, per node.
type DryRunReport struct {
	Report   GraphReport    `json:"report"`
	Entities int            `json:"entities"`
	Nodes    []NodeEstimate `json:"nodes"`
}

// DryRun walks the graph over a snapshot of the session's entities and reports how many
// would reach each node and survive it.
//
// It is a simulation of the stream, not of the work: no plugin is called, nothing is
// written, and so it cannot know what predict would propose or what cluster would group.
// What it does catch is the mistake that actually gets made — a node whose accepts
// matches nothing, or a filter that empties the stream before the node that mattered.
func DryRun(ctx context.Context, session *sessions.Session, graph *config.WorkflowGraph) (DryRunReport, error) {
	catalog := specIndex()
	result := DryRunReport{Report: ValidateGraph(graph, "", ""), Nodes: []NodeEstimate{}}

	ordered, err := planGraph(graph, catalog)
	if err != nil {
		return result, nil // the validation report already carries the reason
	}
	entities, err := sessionSnapshot(ctx, session)
	if err != nil {
		return result, err
	}
	result.Entities = len(entities)

	incoming := incomingSources(graph)
	outputs := map[string][]map[string]any{}
	for _, node := range ordered {
		inputs := gatherEstimateInputs(node.ID, incoming, outputs)
		estimate, out := estimateNode(node, catalog[node.Type], entities, inputs)
		outputs[node.ID] = out
		result.Nodes = append(result.Nodes, estimate)
	}
	return result, nil
}

func sessionSnapshot(ctx context.Context, session *sessions.Session) ([]map[string]any, error) {
	st := store.Open(session.ID, classesFor(ctx, session.Project))
	images, err := st.All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(images))
	for _, image := range images {
		items = append(items, entitySnapshot(image))
	}
	return items, nil
}

func gatherEstimateInputs(nodeID string, incoming map[string][]string, outputs map[string][]map[string]any) []map[string]any {
	var items []map[string]any
	seen := map[string]bool{}
	for _, sourceID := range incoming[nodeID] {
		for _, item := range outputs[sourceID] {
			ref := itemRef(item)
			if ref != "" && seen[ref] {
				continue
			}
			seen[ref] = true
			items = append(items, item)
		}
	}
	return items
}

// estimateNode predicts one node's effect on the stream. Entry nodes read the session;
// filter and sample are simulated exactly, since they are pure; every other node is
// assumed to pass on what it received, which is what the executor does once its accepts
// filter has split the stream.
func estimateNode(node config.WorkflowNode, spec nodes.Spec, entities []map[string]any,
	inputs []map[string]any) (NodeEstimate, []map[string]any) {

	estimate := NodeEstimate{ID: node.ID, Type: node.Type, In: len(inputs)}
	items := inputs
	if spec.Input == "" {
		items = entities
		estimate.In = len(entities)
	}

	matching, passthrough := splitByAccepts(items, spec.Accepts)
	estimate.Matched = len(matching)
	estimate.Passthrough = len(passthrough)

	out := simulateNode(node, matching)
	if len(matching) == 0 && spec.Input != "" && len(spec.Accepts) > 0 {
		estimate.Note = skippedNodeMessage(spec, len(items))
	}
	if node.Type == "filter" && len(out) == 0 && len(matching) > 0 {
		estimate.Note = "this filter empties the stream"
	}

	out = append(out, passthrough...)
	estimate.Out = len(out)
	return estimate, out
}

// simulateNode reproduces the nodes whose effect on the stream is computable without
// doing any work. Everything else passes its matching items through.
func simulateNode(node config.WorkflowNode, matching []map[string]any) []map[string]any {
	switch node.Type {
	case "filter":
		return applyFilter(matching, filterPredicate{
			Field: stringParam(node.Params, "field", "status"),
			Op:    stringParam(node.Params, "op", "is"),
			Value: stringParam(node.Params, "value", ""),
		})
	case "sample":
		return takeFirst(matching, int(floatParam(node.Params, "count", 0)))
	default:
		return matching
	}
}
