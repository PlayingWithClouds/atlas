// Package workers holds the background job bodies: warm embeddings, extract video frames,
// and dataset export/import. Each takes a *jobs.Job for progress and runs on its own
// background context.
package workers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"atlas/backend/internal/frames"
	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/labeling"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/notifications"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

var fetchHeaders = map[string]string{"User-Agent": "Mozilla/5.0", "Referer": "https://www.pornpics.com/"}

func classesFor(ctx context.Context, projectID string) []string {
	project, err := projects.Default.Get(ctx, projectID)
	if err != nil || project == nil {
		return nil
	}
	return project.Classes()
}

// EmbedMissing warms embeddings for a session's un-embedded images via the model plugin.
func EmbedMissing(session *sessions.Session, job *jobs.Job) error {
	ctx := context.Background()
	st := store.Open(session.ID, classesFor(ctx, session.Project))
	missing, err := st.Unembedded(ctx)
	if err != nil {
		return err
	}
	job.Update(map[string]any{"total": len(missing), "phase": "embedding"})
	if !modelclient.Available() {
		return nil
	}
	for start := 0; start < len(missing); start += 16 {
		end := min(start+16, len(missing))
		chunk := missing[start:end]
		refs := make([]string, len(chunk))
		refToIdx := map[string]int{}
		for i, image := range chunk {
			refs[i] = image.Ref
			refToIdx[image.Ref] = image.Idx
		}
		embedded, embedErr := modelclient.Embed(ctx, refs, session.Project)
		if embedErr == nil {
			idxs := make([]int, 0, len(embedded))
			for _, ref := range embedded {
				idxs = append(idxs, refToIdx[ref])
			}
			_ = st.MarkEmbedded(ctx, idxs)
		}
		job.Tick(len(chunk))
		hub.Default.Notify()
	}
	labeling.BackfillPool(ctx, session, st)
	return nil
}

// ExtractAndIngest streams a video's frames to disk, ingesting + embedding each.
func ExtractAndIngest(session *sessions.Session, job *jobs.Job) error {
	ctx := context.Background()
	spec := sources.SpecFrom(session.Video)
	if spec == nil {
		return nil
	}
	url, headers, duration := spec.URL, spec.Headers, spec.Duration
	interval := spec.Interval
	if interval <= 0 {
		interval = 20
	}
	framesDir := spec.FramesDir
	if framesDir == "" {
		framesDir = filepath.Join(sources.FramesRoot(), session.ID)
	}
	if err := os.MkdirAll(framesDir, 0o755); err != nil {
		return err
	}

	st := store.Open(session.ID, classesFor(ctx, session.Project))
	_ = sessions.Default.SetProducing(ctx, session.ID, true)
	defer func() {
		_ = sessions.Default.SetProducing(ctx, session.ID, false)
		hub.Default.Notify()
	}()

	if duration > 0 && interval > 0 {
		job.Update(map[string]any{"total": int(duration/interval) + 1, "phase": "extracting"})
	}
	// One tray notification per ingest, updated in place as frames land.
	progressKey := "ingest:" + session.ID
	ingested := 0
	for index := 0; ; index++ {
		seconds := float64(index) * interval
		if duration > 0 && seconds > duration {
			break
		}
		path := filepath.Join(framesDir, fmt.Sprintf("frame_%05d.jpg", index))
		if _, statErr := os.Stat(path); statErr != nil {
			if !frames.SeekFrame(url, path, seconds, headers) {
				break
			}
		}
		idx, appendErr := st.AppendRef(ctx, path)
		if appendErr != nil {
			return appendErr
		}
		if modelclient.Available() {
			if embedded, _ := modelclient.Embed(ctx, []string{path}, session.Project); len(embedded) > 0 {
				_ = st.MarkEmbedded(ctx, []int{idx})
			}
		}
		ingested++
		message := fmt.Sprintf("Ingesting %q — %d frames", session.Label, ingested)
		_ = notifications.Persist(ctx, progressKey, message, session.ID, "info")
		job.Tick(1)
		hub.Default.Notify()
	}
	if ingested > 0 {
		message := fmt.Sprintf("Ingested %d frames from %q", ingested, session.Label)
		_ = notifications.Persist(ctx, progressKey, message, session.ID, "success")
	}
	labeling.BackfillPool(ctx, session, st)
	return nil
}

// spanPlan is one planned temporal clip: its time range and media-fragment ref.
type spanPlan struct {
	Ref   string
	Start float64
	End   float64
}

// planSpans lays out fixed windows of `window` seconds every `stride` seconds across a
// video's duration. The final window is clamped to the duration, so no clip runs past
// the end. Non-positive inputs yield no spans.
func planSpans(url string, duration, window, stride float64) []spanPlan {
	if url == "" || duration <= 0 || window <= 0 || stride <= 0 {
		return nil
	}
	var spans []spanPlan
	for start := 0.0; start < duration; start += stride {
		end := min(start+window, duration)
		spans = append(spans, spanPlan{
			Ref:   store.SpanRef(url, start, end),
			Start: start,
			End:   end,
		})
	}
	return spans
}

// planAtoms lays out the smallest clips scene mode will consider: the video split at
// every detected cut, with any piece longer than maxLen divided further. An atom
// therefore never straddles a cut and never outlives the window.
func planAtoms(url string, duration float64, cuts []float64, maxLen float64) []spanPlan {
	if url == "" || duration <= 0 || maxLen <= 0 {
		return nil
	}
	var atoms []spanPlan
	for _, shot := range shotRanges(duration, cuts) {
		atoms = append(atoms, subdivide(url, shot, maxLen)...)
	}
	return atoms
}

// shotRange is one detected shot: the video between two cuts.
type shotRange struct {
	Start float64
	End   float64
}

// shotRanges turns cut timestamps into the ranges between them. Cuts outside the video,
// and cuts that do not advance past the previous one, are ignored — ffmpeg reports a
// long transition as several frames in a row, and each extra one would open an empty shot.
func shotRanges(duration float64, cuts []float64) []shotRange {
	var shots []shotRange
	start := 0.0
	for _, cut := range cuts {
		if cut <= start || cut >= duration {
			continue
		}
		shots = append(shots, shotRange{Start: start, End: cut})
		start = cut
	}
	return append(shots, shotRange{Start: start, End: duration})
}

// subdivide splits one shot into equal parts no longer than maxLen. Equal parts rather
// than maxLen-sized ones plus a remainder: a 4.1s shot should read as two halves, not as
// a 4s clip trailed by a 0.1s sliver nothing can be labeled from.
func subdivide(url string, shot shotRange, maxLen float64) []spanPlan {
	span := shot.End - shot.Start
	if span <= 0 {
		return nil
	}
	// The epsilon keeps a shot that is exactly maxLen long from rounding up to two parts.
	parts := max(int(math.Ceil(span/maxLen-1e-9)), 1)
	step := span / float64(parts)

	atoms := make([]spanPlan, 0, parts)
	for part := range parts {
		start := shot.Start + float64(part)*step
		end := min(start+step, shot.End)
		atoms = append(atoms, spanPlan{Ref: store.SpanRef(url, start, end), Start: start, End: end})
	}
	return atoms
}

// atomGroup is a run of adjacent atoms that will become one clip, held as indices so the
// similarity of the pair across any two groups stays easy to look up.
type atomGroup struct {
	First int
	Last  int
}

// mergeAtoms joins the neighbouring atoms the model reports as the same content, then
// folds away whatever is left shorter than minLen. scores[i] is the similarity between
// atoms[i] and atoms[i+1]; a nil or short score list merges nothing, which is exactly
// what should happen when the comparison could not run.
func mergeAtoms(url string, atoms []spanPlan, scores []float64,
	merge, minLen, maxLen float64) []spanPlan {

	if len(atoms) == 0 {
		return nil
	}
	groups := joinSimilar(atoms, scores, merge, maxLen)
	groups = absorbShort(atoms, groups, scores, minLen, maxLen)
	return materialize(url, atoms, groups)
}

// joinSimilar walks the atoms in playback order, extending the current group while the
// next atom is the same content and the group stays inside maxLen. This is what re-joins
// a run of angle changes within one act, and what keeps a position change under a
// continuous take apart even though no cut was detected there.
func joinSimilar(atoms []spanPlan, scores []float64, merge, maxLen float64) []atomGroup {
	groups := []atomGroup{{First: 0, Last: 0}}
	for index := 1; index < len(atoms); index++ {
		current := &groups[len(groups)-1]
		joined := atoms[index].End - atoms[current.First].Start
		if merge > 0 && boundaryScore(scores, index-1) >= merge && joined <= maxLen {
			current.Last = index
			continue
		}
		groups = append(groups, atomGroup{First: index, Last: index})
	}
	return groups
}

// absorbShort folds groups shorter than minLen into a neighbour, shortest first. A group
// with nowhere to go without breaking maxLen is left alone: a short clip is a smaller
// problem than one that runs past the window.
func absorbShort(atoms []spanPlan, groups []atomGroup, scores []float64,
	minLen, maxLen float64) []atomGroup {

	for {
		index, target := shortestAbsorbable(atoms, groups, scores, minLen, maxLen)
		if index < 0 {
			return groups
		}
		groups = joinGroups(groups, index, target)
	}
}

// shortestAbsorbable returns the shortest group still under minLen that has somewhere to
// go, plus the neighbour it should join, or (-1, -1) when nothing is left to fold.
func shortestAbsorbable(atoms []spanPlan, groups []atomGroup, scores []float64,
	minLen, maxLen float64) (int, int) {

	shortest, into, length := -1, -1, minLen
	for index, group := range groups {
		if groupLength(atoms, group) >= length {
			continue
		}
		target := absorbTarget(atoms, groups, scores, index, maxLen)
		if target < 0 {
			continue
		}
		shortest, into, length = index, target, groupLength(atoms, group)
	}
	return shortest, into
}

// absorbTarget is the neighbour a too-short group should join: the more similar of the
// two, the only one it fits into, or -1 when neither has room.
func absorbTarget(atoms []spanPlan, groups []atomGroup, scores []float64,
	index int, maxLen float64) int {

	previous, next := index-1, index+1
	if previous >= 0 && !fitsTogether(atoms, groups[previous], groups[index], maxLen) {
		previous = -1
	}
	if next >= len(groups) || !fitsTogether(atoms, groups[index], groups[next], maxLen) {
		next = -1
	}
	if previous < 0 || next < 0 {
		return max(previous, next)
	}
	if boundaryScore(scores, groups[index].Last) > boundaryScore(scores, groups[previous].Last) {
		return next
	}
	return previous
}

// joinGroups replaces two adjacent groups with the one that spans both.
func joinGroups(groups []atomGroup, index, target int) []atomGroup {
	left, right := min(index, target), max(index, target)
	joined := atomGroup{First: groups[left].First, Last: groups[right].Last}

	out := make([]atomGroup, 0, len(groups)-1)
	out = append(out, groups[:left]...)
	out = append(out, joined)
	return append(out, groups[right+1:]...)
}

// materialize turns groups of atoms back into clips. A group of one keeps the atom's own
// ref, so the vector it was compared with is already warm.
func materialize(url string, atoms []spanPlan, groups []atomGroup) []spanPlan {
	spans := make([]spanPlan, 0, len(groups))
	for _, group := range groups {
		start, end := atoms[group.First].Start, atoms[group.Last].End
		spans = append(spans, spanPlan{Ref: store.SpanRef(url, start, end), Start: start, End: end})
	}
	return spans
}

func groupLength(atoms []spanPlan, group atomGroup) float64 {
	return atoms[group.Last].End - atoms[group.First].Start
}

func fitsTogether(atoms []spanPlan, left, right atomGroup, maxLen float64) bool {
	return atoms[right.Last].End-atoms[left.First].Start <= maxLen
}

// boundaryScore is the similarity across the gap after atom `index`, or 0 where the model
// gave no answer — an unembeddable clip, a failed call, or no model at all. Zero reads as
// "not the same content", which leaves the boundary where detection put it.
func boundaryScore(scores []float64, index int) float64 {
	if index < 0 || index >= len(scores) {
		return 0
	}
	return scores[index]
}

// segmentPlan is what a run decided to cut. Atoms are the candidate clips scene mode
// compared to reach Spans; they are kept so the ones that were merged away can have
// their throwaway embeddings dropped afterwards.
type segmentPlan struct {
	Spans []spanPlan
	Atoms []spanPlan
	Note  string
}

// planSegments produces the clips to create. Scene mode degrades to fixed windows when
// detection cannot run and to unmerged scene cuts when no model can compare them, so the
// node always produces something and says in Note when it produced less than asked.
func planSegments(ctx context.Context, session *sessions.Session, job *jobs.Job,
	spec *sources.VideoSpec, settings SegmentParams) segmentPlan {

	if settings.Mode != SegmentScenes {
		return segmentPlan{Spans: planSpans(spec.URL, spec.Duration, settings.Window, settings.Stride)}
	}

	job.Update(map[string]any{"phase": "detecting scenes"})
	cuts, ok := sources.EnsureSceneCuts(spec, session.ID, settings.CutScore)
	if !ok {
		return segmentPlan{
			Spans: planSpans(spec.URL, spec.Duration, settings.Window, settings.Window),
			Note:  "no scene changes were detected, so clips are fixed windows",
		}
	}

	atoms := planAtoms(spec.URL, spec.Duration, cuts, settings.Window)
	scores, note := atomSimilarity(ctx, session, job, atoms, settings)
	spans := mergeAtoms(spec.URL, atoms, scores, settings.Merge, settings.MinLen, settings.Window)
	return segmentPlan{Spans: spans, Atoms: atoms, Note: note}
}

// atomSimilarity embeds the candidate clips and reports how alike each neighbouring pair
// is. Every unanswered pair scores zero, which merges nothing and leaves the detected
// cuts as the boundaries — so a missing or broken model plugin costs merging, not the run.
func atomSimilarity(ctx context.Context, session *sessions.Session, job *jobs.Job,
	atoms []spanPlan, settings SegmentParams) ([]float64, string) {

	if settings.Merge <= 0 || len(atoms) < 2 {
		return nil, ""
	}
	if !modelclient.Available() {
		return nil, "no model plugin, so similar neighbours were not merged"
	}
	// The work is one comparison per gap between clips, not one per clip.
	job.Update(map[string]any{"total": len(atoms) - 1, "done": 0, "phase": "comparing clips"})
	refs := make([]string, len(atoms))
	for index, atom := range atoms {
		refs[index] = atom.Ref
	}
	scores, err := similarityChain(ctx, session, job, refs)
	if err != nil {
		return nil, "clips could not be compared, so similar neighbours were not merged"
	}
	return scores, ""
}

// similarityBatch is how many clips one comparison call covers. It matches
// embedBatchSize because the call embeds what it compares, and one call per clip would
// re-pay the RPC and decode setup every time.
const similarityBatch = embedBatchSize

// similarityChain scores every adjacent pair in refs. Batches overlap by one clip so the
// pair that spans a batch boundary is still scored: a batch of n refs answers n-1 pairs,
// and the next batch restarts at the ref the last one ended on.
func similarityChain(ctx context.Context, session *sessions.Session, job *jobs.Job,
	refs []string) ([]float64, error) {

	scores := make([]float64, 0, len(refs)-1)
	for start := 0; start+1 < len(refs); start += similarityBatch - 1 {
		end := min(start+similarityBatch, len(refs))
		batch, err := modelclient.AdjacentSimilarity(ctx, refs[start:end], session.Project)
		if err != nil {
			return nil, err
		}
		// A short answer would silently shift every later boundary by one clip.
		if len(batch) != end-start-1 {
			return nil, fmt.Errorf("similarity returned %d scores for %d clips", len(batch), end-start)
		}
		scores = append(scores, batch...)
		job.Tick(len(batch))
		reportProgress(ctx, session, "segment:"+session.ID, "Comparing clips of",
			len(scores), len(refs)-1)
	}
	return scores, nil
}

// forgetUnused drops the vectors of candidate clips that were merged away. They were
// embedded only to be compared and are not entities, so leaving them would grow the
// project's vector cache with refs nothing will ever ask for again.
func forgetUnused(ctx context.Context, project string, plan segmentPlan) {
	if len(plan.Atoms) == 0 || !modelclient.Available() {
		return
	}
	kept := make(map[string]bool, len(plan.Spans))
	for _, span := range plan.Spans {
		kept[span.Ref] = true
	}
	var unused []string
	for _, atom := range plan.Atoms {
		if !kept[atom.Ref] {
			unused = append(unused, atom.Ref)
		}
	}
	if len(unused) > 0 {
		_, _ = modelclient.Forget(ctx, unused, project)
	}
}

// resegment reacts to a segment node whose settings changed since this session was cut.
// Every boundary moves, so the clips already in the session no longer line up with the
// ones about to be planned: the untouched ones are dropped to make room, while labeled
// and skipped clips stay exactly as they are — a threshold tweak must not undo human work.
func resegment(ctx context.Context, session *sessions.Session, st *store.Store,
	settings SegmentParams, planned []spanPlan) error {

	fingerprint := settings.fingerprint()
	if session.Segment == fingerprint {
		return nil
	}
	// An empty fingerprint means this session predates the stamp (or is being cut for the
	// first time); there is nothing to reconcile, only something to record.
	if session.Segment != "" {
		dropped, err := dropUnlabeled(ctx, session, st, planned)
		if err != nil {
			return err
		}
		if dropped > 0 {
			message := fmt.Sprintf("Re-segmenting %q — dropped %d unlabeled clips",
				session.Label, dropped)
			_ = notifications.Persist(ctx, "segment:"+session.ID, message, session.ID, "info")
		}
	}
	if err := sessions.Default.SetSegment(ctx, session.ID, fingerprint); err != nil {
		return err
	}
	session.Segment = fingerprint
	return nil
}

// dropUnlabeled deletes the session's untouched clips and forgets their vectors, which
// are keyed by a ref that is about to stop existing. Clips the new plan cuts at the same
// range are left in place: deleting one only to re-add it would throw away its poster and
// its embedding for nothing.
func dropUnlabeled(ctx context.Context, session *sessions.Session, st *store.Store,
	planned []spanPlan) (int, error) {

	pending, err := st.Pending(ctx)
	if err != nil {
		return 0, err
	}
	keep := make(map[string]bool, len(planned))
	for _, span := range planned {
		keep[span.Ref] = true
	}

	refs := make([]string, 0, len(pending))
	for _, image := range pending {
		if keep[image.Ref] {
			continue
		}
		if err := st.Delete(ctx, image.Idx); err != nil {
			return 0, err
		}
		refs = append(refs, image.Ref)
	}
	if len(refs) == 0 {
		return 0, nil
	}
	if modelclient.Available() {
		_, _ = modelclient.Forget(ctx, refs, session.Project)
	}
	// Deleting leaves gaps in idx; compaction renumbers what is left back into order.
	_, err = st.Compact(ctx)
	return len(refs), err
}

// Segment modes. Fixed lays windows out by arithmetic on the duration; scenes cuts where
// the video actually changes.
const (
	SegmentFixed  = "fixed"
	SegmentScenes = "scenes"
)

// SegmentParams is one segment node's configuration.
type SegmentParams struct {
	Mode     string
	Window   float64 // fixed: clip length; scenes: the longest a merged clip may grow
	Stride   float64 // fixed only
	MinLen   float64 // scenes only: shorter clips are folded into a neighbour
	CutScore float64 // scenes only: the scene score a cut has to beat
	Merge    float64 // scenes only: cosine at which neighbours are one clip, 0 = off
}

// fingerprint records the settings that place clip boundaries in this mode. It is a
// string so it compares exactly after a round-trip through the database, where a stored
// number can come back as any width. Settings the mode ignores are left out: changing
// the stride while in scene mode moves no boundary and must not read as a change.
func (p SegmentParams) fingerprint() string {
	if p.Mode == SegmentScenes {
		return fmt.Sprintf("scenes|window=%.3f|min=%.3f|cut=%.3f|merge=%.3f",
			p.Window, p.MinLen, p.CutScore, p.Merge)
	}
	return fmt.Sprintf("fixed|window=%.3f|stride=%.3f", p.Window, p.Stride)
}

// SegmentVideo generates temporal span entities over a video source. It records only the
// time ranges (ref = "<url>#t=<start>,<end>"); the embedding backbone decodes the frames
// itself. Each span is auto-embedded via the project's model plugin when one is up.
func SegmentVideo(session *sessions.Session, job *jobs.Job, settings SegmentParams) error {
	ctx := context.Background()
	spec := sources.SpecFrom(session.Video)
	if spec == nil {
		return nil
	}
	url, duration := spec.URL, spec.Duration
	if url == "" || duration <= 0 || settings.Window <= 0 {
		return nil
	}

	plan := planSegments(ctx, session, job, spec, settings)
	spans := plan.Spans
	st := store.Open(session.ID, classesFor(ctx, session.Project))

	// This node re-runs whenever its workflow fires (a session_opened trigger runs it
	// on every visit), so it must be idempotent: drop any copies an earlier run left
	// behind, then only append windows the session does not already hold.
	if removed, compactErr := st.Compact(ctx); compactErr != nil {
		return compactErr
	} else if removed > 0 {
		message := fmt.Sprintf("Removed %d duplicate clips from %q", removed, session.Label)
		_ = notifications.Persist(ctx, "segment:"+session.ID, message, session.ID, "info")
	}
	if err := resegment(ctx, session, st, settings, spans); err != nil {
		return err
	}
	forgetUnused(ctx, session.Project, plan)

	existing, err := st.Refs(ctx)
	if err != nil {
		return err
	}
	var pending []spanPlan
	for _, span := range spans {
		if !existing[span.Ref] {
			pending = append(pending, span)
		}
	}
	spans = pending
	if len(spans) == 0 {
		labeling.BackfillPool(ctx, session, st)
		return nil
	}

	progressKey := "segment:" + session.ID
	// The rows land first and in one statement, so the grid fills immediately and the
	// slow part (decoding) runs behind an already-populated session.
	idxs, err := appendSpanRows(ctx, st, spans)
	if err != nil {
		return err
	}
	hub.Default.Notify()

	cutPosters(spec, session, job, progressKey, spans)
	embedSpans(ctx, st, session, job, progressKey, spans, idxs)

	message := fmt.Sprintf("Segmented %q into %d clips", session.Label, len(spans))
	if plan.Note != "" {
		message += " — " + plan.Note
	}
	_ = notifications.Persist(ctx, progressKey, message, session.ID, "success")
	labeling.BackfillPool(ctx, session, st)
	hub.Default.Notify()
	return nil
}

// appendSpanRows inserts every planned window and returns the idx assigned to each.
func appendSpanRows(ctx context.Context, st *store.Store, spans []spanPlan) ([]int, error) {
	rows := make([]store.SpanInput, len(spans))
	for offset, span := range spans {
		rows[offset] = store.SpanInput{Ref: span.Ref, TStart: span.Start, TEnd: span.End}
	}
	return st.AppendSpans(ctx, rows)
}

// posterWorkers is how many span thumbnails are cut at once. Each is one ffmpeg seek
// that spends nearly all its time waiting on the source, so cutting them one after
// another left the run idle; sources.EnsurePoster caps the real ffmpeg concurrency.
const posterWorkers = 6

// cutPosters cuts every span's grid thumbnail up front, in parallel. Leaving them to
// the poster endpoint means one ffmpeg seek per cell the first time anyone scrolls.
// A poster that fails to cut is not fatal: the endpoint retries it on demand.
func cutPosters(spec *sources.VideoSpec, session *sessions.Session, job *jobs.Job,
	progressKey string, spans []spanPlan) {

	job.Update(map[string]any{"total": len(spans), "done": 0, "phase": "cutting posters"})
	ctx := context.Background()
	queue := make(chan spanPlan)
	var group sync.WaitGroup
	var cut atomic.Int64

	for range posterWorkers {
		group.Add(1)
		go func() {
			defer group.Done()
			for span := range queue {
				sources.EnsurePoster(spec, session.ID, span.Ref, span.Start, span.End)
				job.Tick(1)
				reportProgress(ctx, session, progressKey, "Cutting thumbnails for",
					int(cut.Add(1)), len(spans))
			}
		}()
	}
	for _, span := range spans {
		queue <- span
	}
	close(queue)
	group.Wait()
}

// embedBatchSize matches EmbedMissing. One ref per call made the model plugin re-pay
// its RPC and decode setup for every clip, and it embeds a batch on one pass.
const embedBatchSize = 16

// embedSpans embeds the new spans in batches. The batches run one after another on
// purpose: the model plugin serializes embeds per project behind a single backbone, so
// overlapping calls would only queue there while holding goroutines here.
func embedSpans(ctx context.Context, st *store.Store, session *sessions.Session,
	job *jobs.Job, progressKey string, spans []spanPlan, idxs []int) {

	if !modelclient.Available() || len(idxs) != len(spans) {
		return
	}
	job.Update(map[string]any{"total": len(spans), "done": 0, "phase": "embedding"})
	idxForRef := make(map[string]int, len(spans))
	for offset, span := range spans {
		idxForRef[span.Ref] = idxs[offset]
	}

	for start := 0; start < len(spans); start += embedBatchSize {
		end := min(start+embedBatchSize, len(spans))
		batch := spans[start:end]
		refs := make([]string, len(batch))
		for offset, span := range batch {
			refs[offset] = span.Ref
		}
		embedded, embedErr := modelclient.Embed(ctx, refs, session.Project)
		if embedErr == nil && len(embedded) > 0 {
			done := make([]int, 0, len(embedded))
			for _, ref := range embedded {
				if idx, ok := idxForRef[ref]; ok {
					done = append(done, idx)
				}
			}
			_ = st.MarkEmbedded(ctx, done)
		}
		job.Tick(len(batch))
		reportProgress(ctx, session, progressKey, "Embedding clips of", end, len(spans))
	}
}

// progressEvery throttles the tray notification and the websocket broadcast. Both are
// a database write plus a fan-out, and firing them per span made a long segmentation
// spend more time announcing itself than decoding.
const progressEvery = 8

// reportProgress updates the session's single tray notification in place and nudges
// connected clients, on every progressEvery-th item and on the last one.
func reportProgress(ctx context.Context, session *sessions.Session, progressKey, verb string,
	done, total int) {

	if done%progressEvery != 0 && done != total {
		return
	}
	message := fmt.Sprintf("%s %q — %d/%d", verb, session.Label, done, total)
	_ = notifications.Persist(ctx, progressKey, message, session.ID, "info")
	hub.Default.Notify()
}

// --- dataset export / import ------------------------------------------------

// ExportDataset writes the default project's pool (images + labels) to a directory.
func ExportDataset(outDir string, job *jobs.Job) error {
	ctx := context.Background()
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	entries, err := modelclient.PoolDump(ctx, projects.DefaultProject)
	if err != nil {
		return err
	}
	job.Update(map[string]any{"total": len(entries), "phase": "exporting"})
	labels := map[string][]string{}
	for index, entry := range entries {
		filename := fmt.Sprintf("%06d.jpg", index)
		if err := fetchImage(entry.Ref, filepath.Join(outDir, filename)); err == nil {
			labels[filename] = entry.Labels
		}
		job.Tick(1)
	}
	if err := writeJSONFile(filepath.Join(outDir, "labels.json"), labels); err != nil {
		return err
	}
	return writeJSONFile(filepath.Join(outDir, "dataset.json"), map[string]any{
		"count": len(labels), "exported": time.Now().Unix(),
	})
}

// ImportDataset folds an exported dataset back into the default project's pool.
func ImportDataset(inDir string, job *jobs.Job) error {
	ctx := context.Background()
	raw, err := os.ReadFile(filepath.Join(inDir, "labels.json"))
	if err != nil {
		return err
	}
	var labels map[string][]string
	if err := json.Unmarshal(raw, &labels); err != nil {
		return err
	}
	classes := classesFor(ctx, projects.DefaultProject)
	job.Update(map[string]any{"total": len(labels), "phase": "importing"})
	var batch []modelclient.LabeledExample
	flush := func() {
		if len(batch) > 0 {
			_ = modelclient.Train(ctx, batch, classes, projects.DefaultProject)
			batch = batch[:0]
		}
	}
	for filename, fileLabels := range labels {
		batch = append(batch, modelclient.LabeledExample{
			Ref: filepath.Join(inDir, filename), Labels: fileLabels,
		})
		if len(batch) >= 32 {
			flush()
		}
		job.Tick(1)
	}
	flush()
	return nil
}

// --- helpers ---------------------------------------------------------------

func fetchImage(ref, outPath string) error {
	if sources.IsRemote(ref) {
		request, err := http.NewRequest(http.MethodGet, ref, nil)
		if err != nil {
			return err
		}
		for key, value := range fetchHeaders {
			request.Header.Set(key, value)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		return writeStream(outPath, response.Body)
	}
	source, err := os.Open(ref)
	if err != nil {
		return err
	}
	defer source.Close()
	return writeStream(outPath, source)
}

func writeStream(outPath string, reader io.Reader) error {
	file, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(file, reader)
	return err
}

func writeJSONFile(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
