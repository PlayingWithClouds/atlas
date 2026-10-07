// Curation nodes shape the entity stream a workflow carries: filter narrows it, sample
// reorders and truncates it, quality drops entities whose thumbnail says there is
// nothing to look at. They differ from a node's `accepts` on purpose — accepts lets
// non-matching entities flow around a node, while these remove them from the stream.
package workers

import (
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"math"
	"math/rand"
	"os"
	"strconv"

	"atlas/backend/internal/config"
	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/primitives"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

// runFilterNode keeps only the entities matching the node's condition.
func runFilterNode(node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	items := itemsFromInputs(inputs)
	predicate := filterPredicate{
		Field: stringParam(node.Params, "field", "status"),
		Op:    stringParam(node.Params, "op", "is"),
		Value: stringParam(node.Params, "value", ""),
	}
	job.Update(map[string]any{"total": len(items), "phase": node.Type})
	kept := applyFilter(items, predicate)
	job.Tick(len(items))
	return kept, nil
}

// filterPredicate is one condition over an entity snapshot.
type filterPredicate struct {
	Field string
	Op    string
	Value string
}

func applyFilter(items []map[string]any, predicate filterPredicate) []map[string]any {
	kept := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if predicate.matches(item) {
			kept = append(kept, item)
		}
	}
	return kept
}

// matches evaluates the condition against one entity. An entity that does not carry the
// field never matches, whichever way the condition points: a clip with no prediction is
// not "confidence below 0.5", it is simply not a candidate.
func (p filterPredicate) matches(item map[string]any) bool {
	switch p.Field {
	case "annotation", "label":
		return p.matchesAnnotation(item)
	}
	if p.Op == "gt" || p.Op == "lt" {
		return p.matchesNumeric(item)
	}
	return p.matchesText(item)
}

func (p filterPredicate) matchesText(item map[string]any) bool {
	value, ok := fieldText(item, p.Field)
	if !ok {
		return false
	}
	if p.Op == "not" {
		return value != p.Value
	}
	return value == p.Value
}

func (p filterPredicate) matchesNumeric(item map[string]any) bool {
	value, ok := fieldNumber(item, p.Field)
	if !ok {
		return false
	}
	want, err := strconv.ParseFloat(p.Value, 64)
	if err != nil {
		return false
	}
	if p.Op == "lt" {
		return value < want
	}
	return value > want
}

// matchesAnnotation covers the two annotation-shaped fields: "annotation" asks whether
// an annotation of that type exists, "label" whether a tag carries that class.
func (p filterPredicate) matchesAnnotation(item map[string]any) bool {
	var found bool
	if p.Field == "annotation" {
		found = hasAnnotationType(item, p.Value)
	} else {
		found = hasLabel(item, p.Value)
	}
	if p.Op == "not" {
		return !found
	}
	return found
}

func hasLabel(item map[string]any, label string) bool {
	annotations, ok := decodeAnnotations(item["annotations"])
	if !ok {
		return false
	}
	for _, name := range primitives.LabelsOf(annotations) {
		if name == label {
			return true
		}
	}
	return false
}

// fieldText renders a scalar entity field for equality comparison.
func fieldText(item map[string]any, field string) (string, bool) {
	value, present := item[field]
	if !present || value == nil {
		return "", false
	}
	return fmt.Sprintf("%v", value), true
}

// fieldNumber reads a numeric entity field. Duration is derived rather than stored: a
// span carries its range, not its length.
func fieldNumber(item map[string]any, field string) (float64, bool) {
	if field != "duration" {
		return toFloat(item[field])
	}
	start, startOK := toFloat(item["t_start"])
	end, endOK := toFloat(item["t_end"])
	if !startOK || !endOK {
		return 0, false
	}
	return end - start, true
}

// toFloat accepts the numeric shapes an item can arrive in: a Go float from a builtin
// snapshot, or whatever JSON decoding produced for a plugin's response.
func toFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case string:
		parsed, err := strconv.ParseFloat(typed, 64)
		return parsed, err == nil
	}
	return 0, false
}

// runSampleNode reorders the stream and optionally keeps only the first N.
func runSampleNode(runCtx RunContext, node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	items := itemsFromInputs(inputs)
	order := stringParam(node.Params, "order", "natural")
	count := int(floatParam(node.Params, "count", 0))
	job.Update(map[string]any{"total": len(items), "phase": node.Type})

	ordered := orderItems(context.Background(), runCtx.Session, items, order)
	job.Tick(len(items))
	return takeFirst(ordered, count), nil
}

func orderItems(ctx context.Context, session *sessions.Session, items []map[string]any, order string) []map[string]any {
	switch order {
	case "random":
		return shuffled(items)
	case "uncertain":
		return rankedByUncertainty(ctx, session, items)
	default:
		return items
	}
}

func shuffled(items []map[string]any) []map[string]any {
	out := make([]map[string]any, len(items))
	copy(out, items)
	rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// rankedByUncertainty asks the model plugin for the order it would present these
// entities in — the same ranking the labeling path uses, exposed to workflows so one can
// say "the fifty the model is least sure about". Rank echoes its input when there is no
// model or no trained head, so the stream simply stays in natural order.
func rankedByUncertainty(ctx context.Context, session *sessions.Session, items []map[string]any) []map[string]any {
	if session == nil || !modelclient.Available() || len(items) < 2 {
		return items
	}
	refs := make([]string, 0, len(items))
	pending := make(map[string]map[string]any, len(items))
	for _, item := range items {
		ref := itemRef(item)
		if ref == "" {
			continue
		}
		refs = append(refs, ref)
		pending[ref] = item
	}

	ordered := make([]map[string]any, 0, len(items))
	for _, ref := range modelclient.Rank(ctx, refs, classesFor(ctx, session.Project), session.Project) {
		if item, ok := pending[ref]; ok {
			ordered = append(ordered, item)
			delete(pending, ref)
		}
	}
	// Anything the ranker did not mention (or that carries no ref) keeps its order at
	// the end, so sampling never silently loses entities.
	for _, item := range items {
		ref := itemRef(item)
		if _, unplaced := pending[ref]; ref == "" || unplaced {
			ordered = append(ordered, item)
			delete(pending, ref)
		}
	}
	return ordered
}

func takeFirst(items []map[string]any, count int) []map[string]any {
	if count <= 0 || count >= len(items) {
		return items
	}
	return items[:count]
}

// runQualityNode rejects entities whose thumbnail shows nothing worth labeling: a black
// frame, or a flat one (an empty wall, a fade, a heavily blurred still).
func runQualityNode(runCtx RunContext, node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	ctx := context.Background()
	session := runCtx.Session
	items := itemsFromInputs(inputs)
	settings := qualitySettings{
		Check:  stringParam(node.Params, "check", "both"),
		Black:  floatParam(node.Params, "black", 16),
		Flat:   floatParam(node.Params, "flat", 8),
		Action: stringParam(node.Params, "action", "drop"),
	}
	job.Update(map[string]any{"total": len(items), "phase": node.Type})

	spec := sources.SpecFrom(session.Video)
	st := store.Open(session.ID, classesFor(ctx, session.Project))
	byRef, err := loadRefIndex(ctx, st)
	if err != nil {
		return nil, err
	}

	kept := make([]map[string]any, 0, len(items))
	rejected := 0
	for _, item := range items {
		job.Tick(1)
		if !settings.rejects(thumbnailOf(spec, session.ID, item)) {
			kept = append(kept, item)
			continue
		}
		rejected++
		if settings.Action == "drop" {
			continue
		}
		if idx, ok := byRef[itemRef(item)]; ok {
			if err := applyImageAction(ctx, session, st, idx, settings.Action); err != nil {
				return nil, err
			}
		}
	}
	if rejected > 0 && settings.Action != "drop" {
		hub.Default.Notify()
	}
	return kept, nil
}

type qualitySettings struct {
	Check  string
	Black  float64
	Flat   float64
	Action string
}

// rejects judges one thumbnail. Metrics it could not read pass: a missing poster is a
// caching problem, and deleting entities over it would be the wrong answer.
func (q qualitySettings) rejects(metrics thumbnailMetrics) bool {
	if !metrics.OK {
		return false
	}
	if q.Check != "flat" && metrics.Luma < q.Black {
		return true
	}
	if q.Check != "black" && metrics.Contrast < q.Flat {
		return true
	}
	return false
}

// thumbnailMetrics summarizes a still: average brightness and how far the picture
// strays from it. One frame per entity is the whole point — the posters are already on
// disk, so this costs a JPEG decode rather than an ffmpeg pass. It cannot see a freeze
// (that needs several frames); it sees black, blank, and blurred-to-mush.
type thumbnailMetrics struct {
	Luma     float64
	Contrast float64
	OK       bool
}

// thumbnailOf reads the entity's cached poster, cutting it first if the cache is cold.
// A plain image entity is measured from the file itself.
func thumbnailOf(spec *sources.VideoSpec, sid string, item map[string]any) thumbnailMetrics {
	ref := itemRef(item)
	if ref == "" {
		return thumbnailMetrics{}
	}
	start, startOK := toFloat(item["t_start"])
	end, endOK := toFloat(item["t_end"])
	if !startOK || !endOK {
		return measureImage(ref)
	}
	path, ok := sources.EnsurePoster(spec, sid, ref, start, end)
	if !ok {
		return thumbnailMetrics{}
	}
	return measureImage(path)
}

func measureImage(path string) thumbnailMetrics {
	file, err := os.Open(path)
	if err != nil {
		return thumbnailMetrics{}
	}
	defer file.Close()
	decoded, err := jpeg.Decode(file)
	if err != nil {
		return thumbnailMetrics{}
	}
	return measureLuma(decoded)
}

// measureLuma walks a grid of samples rather than every pixel: contrast on a 16×16 grid
// is the same story as on two million pixels, at a fraction of the work.
func measureLuma(picture image.Image) thumbnailMetrics {
	bounds := picture.Bounds()
	if bounds.Dx() < 2 || bounds.Dy() < 2 {
		return thumbnailMetrics{}
	}
	const grid = 16
	samples := make([]float64, 0, grid*grid)
	total := 0.0
	for row := range grid {
		for column := range grid {
			x := bounds.Min.X + bounds.Dx()*column/grid
			y := bounds.Min.Y + bounds.Dy()*row/grid
			red, green, blue, _ := picture.At(x, y).RGBA()
			// Rec. 601 luma, on the 0-255 scale RGBA()'s 16-bit values scale down to.
			luma := (0.299*float64(red) + 0.587*float64(green) + 0.114*float64(blue)) / 257
			samples = append(samples, luma)
			total += luma
		}
	}

	mean := total / float64(len(samples))
	deviation := 0.0
	for _, luma := range samples {
		deviation += (luma - mean) * (luma - mean)
	}
	return thumbnailMetrics{
		Luma:     mean,
		Contrast: math.Sqrt(deviation / float64(len(samples))),
		OK:       true,
	}
}
