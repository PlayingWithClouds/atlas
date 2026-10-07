// Package store is the per-session image repository over the `image` table in SurrealDB.
// Each image row carries its annotations, skip/embedded flags, and an explicit status
// (pending|labeled|skipped) that is the source of truth for the loop. Plugin predictions
// pre-fill annotations while leaving the image pending for human review.
package store

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	"atlas/backend/internal/db"
	"atlas/backend/internal/primitives"
)

const (
	StatusPending = "pending"
	StatusLabeled = "labeled"
	StatusSkipped = "skipped"
)

// Image is one entity row. A plain image has TStart/TEnd nil; a temporal span
// (video clip, audio window) carries the time range it covers over its source,
// and its Ref is a media-fragment URI "<source>#t=<start>,<end>".
type Image struct {
	Idx         int                     `json:"idx"`
	Ref         string                  `json:"ref"`
	Annotations []primitives.Annotation `json:"annotations"`
	Skipped     bool                    `json:"skipped"`
	Embedded    bool                    `json:"embedded"`
	Status      string                  `json:"status"`
	TStart      *float64                `json:"t_start,omitempty"`
	TEnd        *float64                `json:"t_end,omitempty"`
}

// SpanRef builds the media-fragment URI for a temporal span. This is the only
// place the format is written: the model plugin's parse_span reads it back and
// the vector pool is keyed by it.
func SpanRef(base string, tStart, tEnd float64) string {
	return fmt.Sprintf("%s#t=%.3f,%.3f", base, tStart, tEnd)
}

// SplitSpanRef splits a media-fragment ref into its source and time range. It
// splits on the last "#t=" so a source URL containing one survives, mirroring
// parse_span in plugins/model/embedder.py.
func SplitSpanRef(ref string) (base string, tStart, tEnd float64, ok bool) {
	marker := strings.LastIndex(ref, "#t=")
	if marker < 0 {
		return "", 0, 0, false
	}
	base, span := ref[:marker], ref[marker+len("#t="):]
	parts := strings.Split(span, ",")
	if len(parts) != 2 {
		return "", 0, 0, false
	}
	tStart, startErr := strconv.ParseFloat(parts[0], 64)
	tEnd, endErr := strconv.ParseFloat(parts[1], 64)
	if startErr != nil || endErr != nil || tEnd < tStart {
		return "", 0, 0, false
	}
	return base, tStart, tEnd, true
}

// Store is a session's image repository.
type Store struct {
	SID     string
	Classes []string
}

// Open binds a store to a session and its class list.
func Open(sid string, classes []string) *Store {
	return &Store{SID: sid, Classes: classes}
}

const imageFields = "idx, ref, annotations, skipped, embedded, status, t_start, t_end"

// InsertImages bulk-inserts the initial image rows for a new session.
func InsertImages(ctx context.Context, sid string, refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	rows := make([]map[string]any, len(refs))
	for i, ref := range refs {
		rows[i] = map[string]any{
			"session": sid, "idx": i, "ref": ref,
			"annotations": []primitives.Annotation{},
			"skipped":     false, "embedded": false, "status": StatusPending,
		}
	}
	return db.Exec(ctx, "INSERT INTO image $rows", map[string]any{"rows": rows})
}

// GetImage returns a single image row by idx (nil if missing).
func (s *Store) GetImage(ctx context.Context, idx int) (*Image, error) {
	return s.get(ctx, idx)
}

func (s *Store) get(ctx context.Context, idx int) (*Image, error) {
	rows, err := db.Query[Image](ctx,
		"SELECT "+imageFields+" FROM image WHERE session=$sid AND idx=$idx",
		map[string]any{"sid": s.SID, "idx": idx})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return &rows[0], nil
}

// All returns every image row for the session in idx order.
func (s *Store) All(ctx context.Context) ([]Image, error) {
	return db.Query[Image](ctx,
		"SELECT "+imageFields+" FROM image WHERE session=$sid ORDER BY idx",
		map[string]any{"sid": s.SID})
}

// Count returns the number of images in the session.
func (s *Store) Count(ctx context.Context) (int, error) {
	rows, err := db.Query[struct {
		Count int `json:"count"`
	}](ctx, "SELECT count() AS count FROM image WHERE session=$sid GROUP ALL", map[string]any{"sid": s.SID})
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	return rows[0].Count, nil
}

// Ref returns an image's ref by idx.
func (s *Store) Ref(ctx context.Context, idx int) (string, error) {
	image, err := s.get(ctx, idx)
	if err != nil || image == nil {
		return "", err
	}
	return image.Ref, nil
}

// clean drops labels not in the class list and empty tag annotations.
func (s *Store) clean(annotations []primitives.Annotation) []primitives.Annotation {
	allowed := map[string]bool{}
	for _, class := range s.Classes {
		allowed[class] = true
	}
	out := []primitives.Annotation{}
	for _, annotation := range annotations {
		labels := filterLabels(annotation.Value, allowed)
		if annotation.Type == primitives.TagType {
			if len(labels) == 0 {
				continue
			}
			out = append(out, primitives.Tag(toStrings(labels)))
			continue
		}
		value := copyValue(annotation.Value)
		value["labels"] = labels
		out = append(out, primitives.Annotation{Type: annotation.Type, Value: value})
	}
	return out
}

// SetAnnotations confirms a human annotation set: status becomes labeled, skip cleared.
func (s *Store) SetAnnotations(ctx context.Context, idx int, annotations []primitives.Annotation) error {
	clean := s.clean(annotations)
	return db.Exec(ctx,
		"UPDATE image SET annotations=$anns, skipped=false, status=$status WHERE session=$sid AND idx=$idx",
		map[string]any{"sid": s.SID, "idx": idx, "anns": clean, "status": StatusLabeled})
}

// SetLabel confirms a tag class list.
func (s *Store) SetLabel(ctx context.Context, idx int, classes []string) error {
	return s.SetAnnotations(ctx, idx, primitives.TagsToAnnotations(classes))
}

// SetProposedAnnotations pre-fills annotations from a plugin result, leaving the
// image pending for human review. Labeled/skipped images are left untouched.
func (s *Store) SetProposedAnnotations(ctx context.Context, idx int, annotations []primitives.Annotation) error {
	clean := s.clean(annotations)
	return db.Exec(ctx,
		"UPDATE image SET annotations=$anns WHERE session=$sid AND idx=$idx AND status=$pending",
		map[string]any{"sid": s.SID, "idx": idx, "anns": clean, "pending": StatusPending})
}

// Annotations returns the confirmed annotations for an image.
func (s *Store) Annotations(ctx context.Context, idx int) ([]primitives.Annotation, error) {
	image, err := s.get(ctx, idx)
	if err != nil || image == nil {
		return nil, err
	}
	return image.Annotations, nil
}

// Skip marks an image skipped.
func (s *Store) Skip(ctx context.Context, idx int) error {
	return db.Exec(ctx,
		"UPDATE image SET skipped=true, status=$status WHERE session=$sid AND idx=$idx AND status!='labeled'",
		map[string]any{"sid": s.SID, "idx": idx, "status": StatusSkipped})
}

// Delete removes an image from the session entirely (unlike Skip, which keeps it).
func (s *Store) Delete(ctx context.Context, idx int) error {
	return db.Exec(ctx,
		"DELETE image WHERE session=$sid AND idx=$idx",
		map[string]any{"sid": s.SID, "idx": idx})
}

// LabeledIndices returns idx of all human-labeled images.
func (s *Store) LabeledIndices(ctx context.Context) ([]int, error) {
	return s.indicesWhere(ctx, "status='labeled'")
}

func (s *Store) indicesWhere(ctx context.Context, condition string) ([]int, error) {
	rows, err := db.Query[struct {
		Idx int `json:"idx"`
	}](ctx, "SELECT idx FROM image WHERE session=$sid AND "+condition+" ORDER BY idx", map[string]any{"sid": s.SID})
	if err != nil {
		return nil, err
	}
	out := make([]int, len(rows))
	for i, row := range rows {
		out[i] = row.Idx
	}
	return out, nil
}

// PendingEmbedded returns idx+ref of pending images whose embeddings are warm.
func (s *Store) PendingEmbedded(ctx context.Context) ([]Image, error) {
	return db.Query[Image](ctx,
		"SELECT "+imageFields+" FROM image WHERE session=$sid AND status='pending' AND embedded=true ORDER BY idx",
		map[string]any{"sid": s.SID})
}

// Pending returns idx+ref of all pending images (embedded or not).
func (s *Store) Pending(ctx context.Context) ([]Image, error) {
	return db.Query[Image](ctx,
		"SELECT "+imageFields+" FROM image WHERE session=$sid AND status='pending' ORDER BY idx",
		map[string]any{"sid": s.SID})
}

// Unembedded returns idx+ref of images without warm embeddings.
func (s *Store) Unembedded(ctx context.Context) ([]Image, error) {
	return db.Query[Image](ctx,
		"SELECT "+imageFields+" FROM image WHERE session=$sid AND embedded=false ORDER BY idx",
		map[string]any{"sid": s.SID})
}

// MarkEmbedded flags the given idx as embedded.
func (s *Store) MarkEmbedded(ctx context.Context, idxs []int) error {
	if len(idxs) == 0 {
		return nil
	}
	return db.Exec(ctx, "UPDATE image SET embedded=true WHERE session=$sid AND idx IN $idxs",
		map[string]any{"sid": s.SID, "idxs": idxs})
}

// appendLocks serialize idx allocation per session: reading the next idx and inserting
// it is two statements, and two producers could otherwise pick the same one.
var appendLocks sync.Map

func lockFor(sid string) *sync.Mutex {
	lock, _ := appendLocks.LoadOrStore(sid, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

// nextIdx is one past the highest idx in the session. Counting rows instead would reuse
// an idx after any delete, silently merging two entities. This reads the top row rather
// than math::max, which answers int64-min for an empty session.
func (s *Store) nextIdx(ctx context.Context) (int, error) {
	rows, err := db.Query[struct {
		Idx int `json:"idx"`
	}](ctx, "SELECT idx FROM image WHERE session=$sid ORDER BY idx DESC LIMIT 1",
		map[string]any{"sid": s.SID})
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	return rows[0].Idx + 1, nil
}

// AppendRef adds a new image (streaming video frame) and returns its idx.
func (s *Store) AppendRef(ctx context.Context, ref string) (int, error) {
	lock := lockFor(s.SID)
	lock.Lock()
	defer lock.Unlock()

	idx, err := s.nextIdx(ctx)
	if err != nil {
		return 0, err
	}
	err = db.Exec(ctx,
		"INSERT INTO image { session:$sid, idx:$idx, ref:$ref, annotations:[], skipped:false, embedded:false, status:'pending' }",
		map[string]any{"sid": s.SID, "idx": idx, "ref": ref})
	return idx, err
}

// AppendSpan adds a temporal span entity (video clip, audio window) covering
// [tStart, tEnd] over its source, and returns its idx. Ref is the media-fragment
// URI "<source>#t=<start>,<end>" the embedding backbone decodes frames from.
func (s *Store) AppendSpan(ctx context.Context, ref string, tStart, tEnd float64) (int, error) {
	lock := lockFor(s.SID)
	lock.Lock()
	defer lock.Unlock()

	idx, err := s.nextIdx(ctx)
	if err != nil {
		return 0, err
	}
	err = db.Exec(ctx,
		"INSERT INTO image { session:$sid, idx:$idx, ref:$ref, annotations:[], skipped:false, embedded:false, status:'pending', t_start:$t_start, t_end:$t_end }",
		map[string]any{"sid": s.SID, "idx": idx, "ref": ref, "t_start": tStart, "t_end": tEnd})
	return idx, err
}

// SpanInput is one span to append: its media-fragment ref and the range it covers.
type SpanInput struct {
	Ref    string
	TStart float64
	TEnd   float64
}

// AppendSpans adds a run of spans in a single insert and returns their idx in order.
// Segmenting a feature-length video appends hundreds of windows, and AppendSpan costs
// two round-trips each — one idx read plus one insert.
func (s *Store) AppendSpans(ctx context.Context, spans []SpanInput) ([]int, error) {
	if len(spans) == 0 {
		return nil, nil
	}
	lock := lockFor(s.SID)
	lock.Lock()
	defer lock.Unlock()

	first, err := s.nextIdx(ctx)
	if err != nil {
		return nil, err
	}
	idxs := make([]int, len(spans))
	rows := make([]map[string]any, len(spans))
	for offset, span := range spans {
		idxs[offset] = first + offset
		rows[offset] = map[string]any{
			"session": s.SID, "idx": idxs[offset], "ref": span.Ref,
			"annotations": []primitives.Annotation{},
			"skipped":     false, "embedded": false, "status": StatusPending,
			"t_start": span.TStart, "t_end": span.TEnd,
		}
	}
	if err := db.Exec(ctx, "INSERT INTO image $rows", map[string]any{"rows": rows}); err != nil {
		return nil, err
	}
	return idxs, nil
}

// SetSpan moves a span's time range. The ref moves with it, and embedded is
// cleared: the model plugin keys vectors by ref, so a new range is a new entity
// to the pool and has to be embedded again.
func (s *Store) SetSpan(ctx context.Context, idx int, ref string, tStart, tEnd float64) error {
	return db.Exec(ctx,
		"UPDATE image SET ref=$ref, t_start=$t_start, t_end=$t_end, embedded=false WHERE session=$sid AND idx=$idx",
		map[string]any{"sid": s.SID, "idx": idx, "ref": ref, "t_start": tStart, "t_end": tEnd})
}

// Compact removes entities that repeat a ref and renumbers idx so spans run in time
// order. Re-running a segment node used to append its windows again, so a session could
// hold the same clip many times over; a labeled copy always wins over an unlabeled one.
// Returns how many rows were dropped.
func (s *Store) Compact(ctx context.Context) (int, error) {
	images, err := s.All(ctx)
	if err != nil {
		return 0, err
	}
	keepers, doomed := splitDuplicates(images)
	if len(doomed) > 0 {
		if err := db.Exec(ctx, "DELETE image WHERE session=$sid AND idx IN $idxs",
			map[string]any{"sid": s.SID, "idxs": doomed}); err != nil {
			return 0, err
		}
	}
	if err := s.renumber(ctx, keepers); err != nil {
		return len(doomed), err
	}
	return len(doomed), nil
}

// splitDuplicates picks one row per ref and returns the survivors in display order
// (plain entities first in their existing order, then spans by time) plus the idx of
// everything to delete.
func splitDuplicates(images []Image) ([]Image, []int) {
	best := map[string]Image{}
	var order []string
	for _, image := range images {
		existing, seen := best[image.Ref]
		if !seen {
			best[image.Ref] = image
			order = append(order, image.Ref)
			continue
		}
		if preferImage(image, existing) {
			best[image.Ref] = image
		}
	}

	keepers := make([]Image, 0, len(order))
	kept := map[int]bool{}
	for _, ref := range order {
		keepers = append(keepers, best[ref])
		kept[best[ref].Idx] = true
	}
	sortForDisplay(keepers)

	var doomed []int
	for _, image := range images {
		if !kept[image.Idx] {
			doomed = append(doomed, image.Idx)
		}
	}
	return keepers, doomed
}

// preferImage reports whether candidate should replace current as the surviving copy:
// human work first, then anything already embedded, then the earliest row.
func preferImage(candidate, current Image) bool {
	if (candidate.Status == StatusLabeled) != (current.Status == StatusLabeled) {
		return candidate.Status == StatusLabeled
	}
	if len(candidate.Annotations) != len(current.Annotations) {
		return len(candidate.Annotations) > len(current.Annotations)
	}
	if candidate.Embedded != current.Embedded {
		return candidate.Embedded
	}
	return candidate.Idx < current.Idx
}

func sortForDisplay(images []Image) {
	sort.SliceStable(images, func(a, b int) bool {
		first, second := images[a], images[b]
		if (first.TStart == nil) != (second.TStart == nil) {
			return first.TStart == nil // plain entities keep the head of the list
		}
		if first.TStart == nil {
			return first.Idx < second.Idx
		}
		if *first.TStart != *second.TStart {
			return *first.TStart < *second.TStart
		}
		return first.Idx < second.Idx
	})
}

// renumber rewrites idx to match the given order. Rows are first parked above the
// current maximum, because assigning final positions one at a time would collide with
// rows that have not moved yet (idx is the session-unique handle). The parking range is
// positive: negative placeholders come back from the driver mangled.
func (s *Store) renumber(ctx context.Context, images []Image) error {
	moved := false
	offset := 0
	for position, image := range images {
		if image.Idx != position {
			moved = true
		}
		if image.Idx >= offset {
			offset = image.Idx + 1
		}
	}
	if !moved {
		return nil
	}
	for position, image := range images {
		if err := db.Exec(ctx, "UPDATE image SET idx=$next WHERE session=$sid AND idx=$idx",
			map[string]any{"sid": s.SID, "idx": image.Idx, "next": offset + position}); err != nil {
			return err
		}
	}
	return db.Exec(ctx, "UPDATE image SET idx = idx - $offset WHERE session=$sid AND idx >= $offset",
		map[string]any{"sid": s.SID, "offset": offset})
}

// Refs returns every ref in the session, for skipping work that already exists.
func (s *Store) Refs(ctx context.Context) (map[string]bool, error) {
	images, err := s.All(ctx)
	if err != nil {
		return nil, err
	}
	refs := make(map[string]bool, len(images))
	for _, image := range images {
		refs[image.Ref] = true
	}
	return refs, nil
}

// Labels returns the confirmed tag labels for an image.
func (s *Store) Labels(ctx context.Context, idx int) ([]string, error) {
	annotations, err := s.Annotations(ctx, idx)
	if err != nil {
		return nil, err
	}
	return primitives.LabelsOf(annotations), nil
}

// --- helpers ---------------------------------------------------------------

func filterLabels(value map[string]any, allowed map[string]bool) []any {
	raw, _ := value["labels"].([]any)
	out := []any{}
	for _, item := range raw {
		if str, ok := item.(string); ok && allowed[str] {
			out = append(out, str)
		}
	}
	return out
}

func toStrings(values []any) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if str, ok := value.(string); ok {
			out = append(out, str)
		}
	}
	return out
}

func copyValue(value map[string]any) map[string]any {
	out := make(map[string]any, len(value))
	for key, val := range value {
		out[key] = val
	}
	return out
}
