// Executor runs a visual-designer workflow graph over one session. Nodes are the
// processing steps authored in the UI; edges express execution order and the
// "state" that flows between ports. Built-in nodes map to worker functions here;
// plugin-provided nodes are dispatched generically to the plugin's RPC method.
package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mailgun/raymond/v2"

	"atlas/backend/internal/config"
	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/labeling"
	"atlas/backend/internal/nodes"
	"atlas/backend/internal/notifications"
	"atlas/backend/internal/primitives"
	"atlas/backend/internal/registry"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/store"
)

const pluginNodeTimeout = 120 * time.Second

// The "length" Handlebars helper counts any list/map/string value, so notify
// templates can write {{length inputs.[0]}} alongside the prebuilt {{count}}.
func init() {
	raymond.RegisterHelper("length", func(value any) int {
		if value == nil {
			return 0
		}
		rv := reflect.ValueOf(value)
		switch rv.Kind() {
		case reflect.Slice, reflect.Array, reflect.Map, reflect.String:
			return rv.Len()
		default:
			return 0
		}
	})
}

// RunAndNotify runs a workflow graph and reports the result: success is a
// transient toast, failure additionally stays in the tray until dismissed.
func RunAndNotify(runCtx RunContext, graph *config.WorkflowGraph, label string, job *jobs.Job) error {
	err := RunWorkflowGraph(runCtx, graph, job)
	sid := ""
	if runCtx.Session != nil {
		sid = runCtx.Session.ID
	}
	if err != nil {
		message := fmt.Sprintf("Workflow %q failed: %v", label, err)
		_ = notifications.Persist(context.Background(), "", message, sid, "error")
		notifications.Notify(message, sid, "error")
	} else {
		notifications.Notify(fmt.Sprintf("Workflow %q finished", label), sid, "success")
	}
	return err
}

// RunContext is the input a triggered workflow runs against. ImageIdx >= 0 scopes
// the run to a single image (image-level triggers); -1 means the whole session.
type RunContext struct {
	Session  *sessions.Session
	ImageIdx int
}

// RunWorkflowGraph validates the graph, orders it topologically, then runs each
// node against the run context as a single tracked job. Each node produces an
// output value that flows to the nodes it connects to (see gatherInputs).
func RunWorkflowGraph(runCtx RunContext, graph *config.WorkflowGraph, job *jobs.Job) error {
	catalog := specIndex()
	ordered, err := planGraph(graph, catalog)
	if err != nil {
		return err
	}
	incoming := incomingSources(graph)
	outputs := map[string]any{}
	for _, node := range ordered {
		inputs := gatherInputs(node.ID, incoming, outputs)
		output, err := runNode(runCtx, node, catalog[node.Type], job, inputs)
		if err != nil {
			return fmt.Errorf("node %s (%s): %w", node.ID, node.Type, err)
		}
		outputs[node.ID] = output
	}
	return nil
}

// incomingSources maps each node id to its upstream source ids, in edge order, so a
// node's inputs ($0, $1, …) line up with the order its wires were created.
func incomingSources(graph *config.WorkflowGraph) map[string][]string {
	incoming := map[string][]string{}
	for _, edge := range graph.Edges {
		incoming[edge.Target] = append(incoming[edge.Target], edge.Source)
	}
	return incoming
}

// gatherInputs collects the outputs of a node's upstream nodes, in edge order.
func gatherInputs(nodeID string, incoming map[string][]string, outputs map[string]any) []any {
	sources := incoming[nodeID]
	inputs := make([]any, 0, len(sources))
	for _, sourceID := range sources {
		inputs = append(inputs, outputs[sourceID])
	}
	return inputs
}

func specIndex() map[string]nodes.Spec {
	index := map[string]nodes.Spec{}
	for _, spec := range nodes.Catalog() {
		index[spec.Type] = spec
	}
	return index
}

// planGraph validates node types + edge port compatibility and returns the nodes
// in a runnable topological order (Kahn's algorithm). It errors on unknown node
// types, dangling edges, incompatible ports, or cycles.
func planGraph(graph *config.WorkflowGraph, catalog map[string]nodes.Spec) ([]config.WorkflowNode, error) {
	if graph == nil || len(graph.Nodes) == 0 {
		return nil, fmt.Errorf("empty workflow graph")
	}

	byID := map[string]config.WorkflowNode{}
	for _, node := range graph.Nodes {
		if _, ok := catalog[node.Type]; !ok {
			return nil, fmt.Errorf("unknown node type %q (plugin unavailable?)", node.Type)
		}
		byID[node.ID] = node
	}

	if err := validateEdges(graph, byID, catalog); err != nil {
		return nil, err
	}
	return topoSort(graph, byID)
}

func validateEdges(graph *config.WorkflowGraph, byID map[string]config.WorkflowNode, catalog map[string]nodes.Spec) error {
	for _, edge := range graph.Edges {
		source, ok := byID[edge.Source]
		if !ok {
			return fmt.Errorf("edge references missing node %q", edge.Source)
		}
		target, ok := byID[edge.Target]
		if !ok {
			return fmt.Errorf("edge references missing node %q", edge.Target)
		}
		if catalog[source.Type].Output == "" {
			return fmt.Errorf("node %s (%s) has no output to connect", source.ID, source.Type)
		}
		if catalog[target.Type].Input == "" {
			return fmt.Errorf("node %s (%s) takes no input", target.ID, target.Type)
		}
	}
	return nil
}

func topoSort(graph *config.WorkflowGraph, byID map[string]config.WorkflowNode) ([]config.WorkflowNode, error) {
	indegree := map[string]int{}
	for id := range byID {
		indegree[id] = 0
	}
	adjacency := map[string][]string{}
	for _, edge := range graph.Edges {
		adjacency[edge.Source] = append(adjacency[edge.Source], edge.Target)
		indegree[edge.Target]++
	}

	var queue []string
	for _, node := range graph.Nodes {
		if indegree[node.ID] == 0 {
			queue = append(queue, node.ID)
		}
	}

	var ordered []config.WorkflowNode
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		ordered = append(ordered, byID[id])
		for _, next := range adjacency[id] {
			indegree[next]--
			if indegree[next] == 0 {
				queue = append(queue, next)
			}
		}
	}

	if len(ordered) != len(graph.Nodes) {
		return nil, fmt.Errorf("workflow graph has a cycle")
	}
	return ordered, nil
}

// runNode runs one node and returns its output (the entity items flowing onward),
// which downstream nodes receive as their input.
func runNode(runCtx RunContext, node config.WorkflowNode, spec nodes.Spec, job *jobs.Job, inputs []any) (any, error) {
	job.Update(map[string]any{"phase": node.Type})

	// Built-in nodes are implemented directly here.
	if spec.Source == "builtin" {
		return runBuiltin(runCtx, node, job, inputs)
	}
	// Plugin nodes are dispatched generically to the plugin's declared RPC method.
	return runPluginNode(runCtx, node, spec, job, inputs)
}

// scopeToImage restricts a working set to a single image when the run is
// image-scoped (ImageIdx >= 0); otherwise it returns the set unchanged.
func scopeToImage(images []store.Image, imageIdx int) []store.Image {
	if imageIdx < 0 {
		return images
	}
	for _, image := range images {
		if image.Idx == imageIdx {
			return []store.Image{image}
		}
	}
	return nil
}

func runBuiltin(runCtx RunContext, node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	switch node.Type {
	case "source":
		return workingItems(runCtx)
	case "extract":
		if err := ExtractAndIngest(runCtx.Session, job); err != nil {
			return nil, err
		}
		return workingItems(runCtx)
	case "segment":
		settings := SegmentParams{
			Mode:     stringParam(node.Params, "mode", SegmentFixed),
			Window:   floatParam(node.Params, "window", 4),
			Stride:   floatParam(node.Params, "stride", 4),
			MinLen:   floatParam(node.Params, "minLen", 2),
			CutScore: floatParam(node.Params, "cutScore", 0.3),
			Merge:    floatParam(node.Params, "merge", 0.9),
		}
		if err := SegmentVideo(runCtx.Session, job, settings); err != nil {
			return nil, err
		}
		return workingItems(runCtx)
	case "filter":
		return runFilterNode(node, job, inputs)
	case "sample":
		return runSampleNode(runCtx, node, job, inputs)
	case "quality":
		return runQualityNode(runCtx, node, job, inputs)
	case "trim":
		return runTrimNode(runCtx, node, job, inputs)
	case "save":
		return runSaveNode(runCtx, node, job, inputs)
	case "action":
		return runActionNode(runCtx, node, job, inputs)
	case "notify":
		return runNotifyNode(runCtx, node, job, inputs)
	case "export":
		outDir := stringParam(node.Params, "outDir", "")
		if outDir == "" {
			return nil, fmt.Errorf("export node requires an outDir param")
		}
		return nil, ExportDataset(resolveOutDir(outDir), job)
	default:
		return nil, fmt.Errorf("unhandled builtin node %q", node.Type)
	}
}

// workingItems returns entity snapshots for the images this run operates on: the
// whole session, or just the scoped image for an image-level run. These items are
// what flows between workflow nodes.
func workingItems(runCtx RunContext) ([]map[string]any, error) {
	ctx := context.Background()
	session := runCtx.Session
	st := store.Open(session.ID, classesFor(ctx, session.Project))
	images, err := st.All(ctx)
	if err != nil {
		return nil, err
	}
	images = scopeToImage(images, runCtx.ImageIdx)
	items := make([]map[string]any, 0, len(images))
	for _, image := range images {
		items = append(items, entitySnapshot(image))
	}
	return items, nil
}

func entitySnapshot(image store.Image) map[string]any {
	annotations := image.Annotations
	if annotations == nil {
		annotations = []primitives.Annotation{}
	}
	snapshot := map[string]any{
		"ref":         image.Ref,
		"status":      image.Status,
		"embedded":    image.Embedded,
		"annotations": annotations,
	}
	// Temporal spans carry their time range so plugins/notify templates see it;
	// plain images omit it entirely.
	if image.TStart != nil && image.TEnd != nil {
		snapshot["t_start"] = *image.TStart
		snapshot["t_end"] = *image.TEnd
	}
	return snapshot
}

// itemsFromInputs flattens the upstream outputs into one item list, in edge order,
// dropping duplicate refs (first wins) and tolerating non-item inputs.
func itemsFromInputs(inputs []any) []map[string]any {
	var items []map[string]any
	seen := map[string]bool{}
	for _, input := range inputs {
		for _, item := range asItems(input) {
			ref := itemRef(item)
			if ref != "" && seen[ref] {
				continue
			}
			if ref != "" {
				seen[ref] = true
			}
			items = append(items, item)
		}
	}
	return items
}

// asItems coerces one upstream output into an item list. Outputs are either
// []map[string]any (builtin nodes) or []any of maps (JSON-decoded plugin output).
func asItems(input any) []map[string]any {
	switch value := input.(type) {
	case []map[string]any:
		return value
	case []any:
		items := make([]map[string]any, 0, len(value))
		for _, entry := range value {
			if item, ok := entry.(map[string]any); ok {
				items = append(items, item)
			}
		}
		return items
	default:
		return nil
	}
}

func itemRef(item map[string]any) string {
	ref, _ := item["ref"].(string)
	return ref
}

// refIndex maps image refs to their session indices.
func refIndex(images []store.Image) map[string]int {
	index := make(map[string]int, len(images))
	for _, image := range images {
		index[image.Ref] = image.Idx
	}
	return index
}

// matchesAccepts reports whether an entity snapshot satisfies a node's accepts
// declaration: field equality per key, with the special key "annotation" meaning
// the entity has an annotation of that type.
func matchesAccepts(item map[string]any, accepts map[string]any) bool {
	for key, want := range accepts {
		if key == "annotation" {
			if !hasAnnotationType(item, fmt.Sprintf("%v", want)) {
				return false
			}
			continue
		}
		if fmt.Sprintf("%v", item[key]) != fmt.Sprintf("%v", want) {
			return false
		}
	}
	return true
}

func hasAnnotationType(item map[string]any, annotationType string) bool {
	for _, annotation := range asItems(item["annotations"]) {
		if fmt.Sprintf("%v", annotation["type"]) == annotationType {
			return true
		}
	}
	// Builtin snapshots hold typed annotations rather than decoded JSON maps.
	if typed, ok := item["annotations"].([]primitives.Annotation); ok {
		for _, annotation := range typed {
			if annotation.Type == annotationType {
				return true
			}
		}
	}
	return false
}

// splitByAccepts partitions items into those a node works on and those that pass
// through around it.
func splitByAccepts(items []map[string]any, accepts map[string]any) (matching, passthrough []map[string]any) {
	if len(accepts) == 0 {
		return items, nil
	}
	for _, item := range items {
		if matchesAccepts(item, accepts) {
			matching = append(matching, item)
		} else {
			passthrough = append(passthrough, item)
		}
	}
	return matching, passthrough
}

// runPluginNode dispatches a node generically to its plugin's declared RPC method.
// The plugin receives the matching entity items plus the node params; its response
// items become the node output. Items carrying a reserved "action" field are applied
// to the entities and consumed instead of flowing onward.
func runPluginNode(runCtx RunContext, node config.WorkflowNode, spec nodes.Spec, job *jobs.Job, inputs []any) (any, error) {
	ctx := context.Background()
	session := runCtx.Session
	items := itemsFromInputs(inputs)
	matching, passthrough := splitByAccepts(items, spec.Accepts)
	if len(matching) == 0 && spec.Input != "" {
		// Silence here is how "the workflow ran and embedded nothing" happens: every
		// entity fails the node's accepts filter, the items flow around it, and a
		// downstream notify still counts them. Say which node stood down and why.
		notifications.Notify(skippedNodeMessage(spec, len(items)), session.ID, "info")
		return items, nil
	}

	classes := classesFor(ctx, session.Project)
	job.Update(map[string]any{"total": len(matching), "phase": spec.Type})
	produced, reported, err := callPluginNode(ctx, session.Project, node, spec, matching, classes, job)
	if err != nil {
		return nil, err
	}
	for _, message := range reported {
		notifications.Notify(message, session.ID, "info")
	}
	produced = mergeProducedItems(matching, produced)

	st := store.Open(session.ID, classes)
	survivors, err := applyItemActions(ctx, session, st, produced)
	if err != nil {
		return nil, err
	}
	return append(survivors, passthrough...), nil
}

// skippedNodeMessage explains a node that matched nothing, in the terms the node
// itself declares: "Embed skipped — none of the 328 entities are unembedded".
func skippedNodeMessage(spec nodes.Spec, total int) string {
	label := spec.Label
	if label == "" {
		label = spec.Type
	}
	if requirement := describeAccepts(spec.Accepts); requirement != "" {
		return fmt.Sprintf("%s skipped — none of the %d entities %s", label, total, requirement)
	}
	return fmt.Sprintf("%s skipped — no entities matched", label)
}

// describeAccepts renders an accepts filter as the condition entities failed.
func describeAccepts(accepts map[string]any) string {
	if len(accepts) == 0 {
		return ""
	}
	// Sorted so the same filter always reads the same way.
	keys := make([]string, 0, len(accepts))
	for key := range accepts {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, describeCondition(key, accepts[key]))
	}
	return "are " + strings.Join(parts, " and ")
}

func describeCondition(key string, want any) string {
	switch key {
	case "embedded":
		if isTrue(want) {
			return "embedded"
		}
		return "unembedded"
	case "annotation":
		return fmt.Sprintf("annotated with %v", want)
	case "status":
		return fmt.Sprintf("%v", want)
	}
	return fmt.Sprintf("%s=%v", key, want)
}

// mergeProducedItems overlays each produced item onto the input item with the same
// ref, so upstream entity fields (status, embedded, annotations, ...) survive plugin
// nodes that return sparse results — e.g. embed's {ref, embedded} keeps its status,
// and a later save still sees embedded=true after dedupe/predict. Produced items
// without a matching input ref pass through as-is (generator nodes).
func mergeProducedItems(inputs, produced []map[string]any) []map[string]any {
	byRef := map[string]map[string]any{}
	for _, item := range inputs {
		if ref := itemRef(item); ref != "" {
			byRef[ref] = item
		}
	}
	merged := make([]map[string]any, 0, len(produced))
	for _, item := range produced {
		base, found := byRef[itemRef(item)]
		if !found {
			merged = append(merged, item)
			continue
		}
		combined := make(map[string]any, len(base)+len(item))
		for key, value := range base {
			combined[key] = value
		}
		for key, value := range item {
			combined[key] = value
		}
		merged = append(merged, combined)
	}
	return merged
}

// callPluginNode chunks the items by the node's declared batch size and merges the
// plugin's response items. batch 0 means one call with everything (e.g. dedupe
// compares items against each other).
// callPluginNode returns the produced items plus any distinct diagnostics the plugin
// reported, so a node that ran without doing anything can explain itself.
func callPluginNode(ctx context.Context, project string, node config.WorkflowNode, spec nodes.Spec, items []map[string]any, classes []string, job *jobs.Job) ([]map[string]any, []string, error) {
	messages := map[string]bool{}
	batch := spec.Batch
	if batch <= 0 {
		batch = len(items)
	}
	if batch == 0 {
		batch = 1 // entry nodes call once with an empty item list
	}
	var produced []map[string]any
	for start := 0; start < len(items) || (start == 0 && len(items) == 0); start += batch {
		end := min(start+batch, len(items))
		chunk := items[start:end]
		raw, err := registry.Default.Call(ctx, spec.Plugin, spec.Method,
			map[string]any{"items": chunk, "params": node.Params, "project": project, "classes": classes},
			pluginNodeTimeout)
		if err != nil {
			return nil, nil, err
		}
		var result struct {
			Items []map[string]any `json:"items"`
			// A node that ran but could not do its job says so here — an untrained
			// classifier head returns a full set of empty predictions, which is
			// indistinguishable from "nothing applies" without this.
			Message string `json:"message"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return nil, nil, fmt.Errorf("node %s returned malformed items: %w", spec.Type, err)
		}
		produced = append(produced, result.Items...)
		if result.Message != "" {
			messages[result.Message] = true
		}
		job.Tick(len(chunk))
		hub.Default.Notify()
	}
	reported := make([]string, 0, len(messages))
	for message := range messages {
		reported = append(reported, message)
	}
	sort.Strings(reported)
	return produced, reported, nil
}

// applyItemActions executes the reserved "action" field (accept | skip | delete)
// on the entities that carry it and consumes those items; the rest flow onward.
func applyItemActions(ctx context.Context, session *sessions.Session, st *store.Store, items []map[string]any) ([]map[string]any, error) {
	byRef, err := loadRefIndex(ctx, st)
	if err != nil {
		return nil, err
	}
	var survivors []map[string]any
	acted := 0
	for _, item := range items {
		action, _ := item["action"].(string)
		if action == "" {
			survivors = append(survivors, item)
			continue
		}
		idx, ok := byRef[itemRef(item)]
		if !ok {
			continue
		}
		if err := applyImageAction(ctx, session, st, idx, action); err != nil {
			return nil, err
		}
		acted++
	}
	if acted > 0 {
		hub.Default.Notify()
	}
	return survivors, nil
}

func loadRefIndex(ctx context.Context, st *store.Store) (map[string]int, error) {
	images, err := st.All(ctx)
	if err != nil {
		return nil, err
	}
	return refIndex(images), nil
}

// runSaveNode persists the recognized result fields of the incoming items onto
// their entities: "embedded" marks entities embedded, "annotations" writes them as
// proposals (pending human review) or confirmed labels depending on the mode param.
func runSaveNode(runCtx RunContext, node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	ctx := context.Background()
	session := runCtx.Session
	st := store.Open(session.ID, classesFor(ctx, session.Project))
	byRef, err := loadRefIndex(ctx, st)
	if err != nil {
		return nil, err
	}
	items := itemsFromInputs(inputs)
	mode := stringParam(node.Params, "mode", "propose")
	job.Update(map[string]any{"total": len(items), "phase": node.Type})

	var embeddedIdxs []int
	for _, item := range items {
		idx, ok := byRef[itemRef(item)]
		if !ok {
			job.Tick(1)
			continue
		}
		if isTrue(item["embedded"]) {
			embeddedIdxs = append(embeddedIdxs, idx)
		}
		if err := saveItemAnnotations(ctx, session, st, idx, item, mode); err != nil {
			return nil, err
		}
		job.Tick(1)
	}
	if len(embeddedIdxs) > 0 {
		if err := st.MarkEmbedded(ctx, embeddedIdxs); err != nil {
			return nil, err
		}
		labeling.BackfillPool(ctx, session, st)
	}
	hub.Default.Notify()
	return items, nil
}

func isTrue(value any) bool {
	flag, ok := value.(bool)
	return ok && flag
}

// saveItemAnnotations writes an item's "annotations" field (if present) onto its
// entity. Malformed annotation payloads skip the item rather than failing the run.
func saveItemAnnotations(ctx context.Context, session *sessions.Session, st *store.Store, idx int, item map[string]any, mode string) error {
	raw, present := item["annotations"]
	if !present {
		return nil
	}
	annotations, ok := decodeAnnotations(raw)
	if !ok {
		return nil
	}
	if mode == "confirm" {
		return labeling.ConfirmLabel(ctx, session, st, idx, annotations)
	}
	return st.SetProposedAnnotations(ctx, idx, annotations)
}

func decodeAnnotations(raw any) ([]primitives.Annotation, bool) {
	if typed, ok := raw.([]primitives.Annotation); ok {
		return typed, true
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, false
	}
	var annotations []primitives.Annotation
	if err := json.Unmarshal(encoded, &annotations); err != nil {
		return nil, false
	}
	return annotations, true
}

// runActionNode applies one bulk decision to the entities flowing into this branch.
// It outputs the items it acted on.
func runActionNode(runCtx RunContext, node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	ctx := context.Background()
	session := runCtx.Session
	st := store.Open(session.ID, classesFor(ctx, session.Project))
	byRef, err := loadRefIndex(ctx, st)
	if err != nil {
		return nil, err
	}
	items := itemsFromInputs(inputs)
	action := stringParam(node.Params, "action", "accept")
	job.Update(map[string]any{"total": len(items), "phase": node.Type})
	var acted []map[string]any
	for _, item := range items {
		idx, ok := byRef[itemRef(item)]
		if !ok {
			job.Tick(1)
			continue
		}
		if err := applyImageAction(ctx, session, st, idx, action); err != nil {
			return nil, err
		}
		acted = append(acted, item)
		job.Tick(1)
	}
	hub.Default.Notify()
	return acted, nil
}

// applyImageAction performs one workflow decision on a single image. accept confirms
// the image's current (proposed) annotations; reject and skip mark it skipped; delete
// removes it from the session. Triggers are not fired here to avoid workflow recursion.
func applyImageAction(ctx context.Context, session *sessions.Session, st *store.Store, idx int, action string) error {
	switch action {
	case "accept":
		image, err := st.GetImage(ctx, idx)
		if err != nil {
			return err
		}
		if image == nil {
			return nil
		}
		return labeling.ConfirmLabel(ctx, session, st, idx, image.Annotations)
	case "reject", "skip":
		return st.Skip(ctx, idx)
	case "delete":
		return st.Delete(ctx, idx)
	default:
		return fmt.Errorf("unknown action %q", action)
	}
}

// runNotifyNode surfaces a user-facing notification. The message is a Handlebars
// template rendered against the incoming entities (see renderNotifyMessage). The
// "kind" param picks between a transient toast (default) and a persistent tray
// entry the user has to dismiss.
func runNotifyNode(runCtx RunContext, node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	message := stringParam(node.Params, "message", "")
	if message == "" {
		message = "Workflow reached notify step"
	}
	message = renderNotifyMessage(message, runCtx, inputs)
	sid := ""
	if runCtx.Session != nil {
		sid = runCtx.Session.ID
	}
	job.Update(map[string]any{"phase": node.Type})
	if stringParam(node.Params, "kind", "transient") == "persistent" {
		if err := notifications.Persist(context.Background(), "", message, sid, "info"); err != nil {
			return nil, err
		}
		return message, nil
	}
	notifications.Notify(message, sid, "info")
	return message, nil
}

// renderNotifyMessage renders the message as a Handlebars template. Context:
// items (the entities flowing in), count (their number), inputs (per-upstream
// item lists), and session {id, label}. A "length" helper counts any list, e.g.
// {{count}} images, {{length inputs.[0]}}, {{session.label}}, {{#each items}}.
// A template error keeps the raw message rather than failing the workflow.
func renderNotifyMessage(message string, runCtx RunContext, inputs []any) string {
	items := itemsFromInputs(inputs)
	context := map[string]any{
		"items":  items,
		"count":  len(items),
		"inputs": inputs,
	}
	if runCtx.Session != nil {
		context["session"] = map[string]any{"id": runCtx.Session.ID, "label": runCtx.Session.Label}
	}
	rendered, err := raymond.Render(message, context)
	if err != nil {
		return message
	}
	return rendered
}

func stringParam(params map[string]any, key, fallback string) string {
	if params == nil {
		return fallback
	}
	if value, ok := params[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

// floatParam reads a numeric node param (JSON numbers decode as float64; a numeric
// string is tolerated for params typed loosely by the designer UI).
func floatParam(params map[string]any, key string, fallback float64) float64 {
	if params == nil {
		return fallback
	}
	switch value := params[key].(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case string:
		if parsed, err := strconv.ParseFloat(value, 64); err == nil {
			return parsed
		}
	}
	return fallback
}

// resolveOutDir keeps relative export paths under the config directory (repo root).
func resolveOutDir(outDir string) string {
	if len(outDir) > 0 && (outDir[0] == '/' || outDir[0] == '~') {
		return outDir
	}
	return config.Get().Dir() + "/" + outDir
}
