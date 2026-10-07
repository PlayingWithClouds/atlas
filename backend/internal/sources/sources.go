// Package sources resolves a session source (directory/gallery/video/random) into an ordered
// ref list via a source plugin, and derives the stable session id. State lives in SurrealDB;
// the only on-disk artifact is a video's extracted frames directory.
package sources

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"atlas/backend/internal/frames"
	"atlas/backend/internal/registry"
)

var CacheRoot = filepath.Join(os.Getenv("HOME"), ".cache", "atlas")

// FramesRoot is where extracted video frames live, one dir per session.
func FramesRoot() string { return filepath.Join(CacheRoot, "frames") }

// IsRemote reports whether a ref is an http(s) URL rather than a local path.
func IsRemote(ref string) bool {
	return strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://")
}

// VideoSpec is a streaming session's playback + extraction spec, stored on the
// session row as a plain map. Headers are CDN-required and must accompany every
// upstream request; Playback records whether the source answers byte ranges
// ("direct") or has to be cut clip by clip server-side ("clip").
type VideoSpec struct {
	URL       string
	Headers   map[string]string
	Interval  float64
	Duration  float64
	FramesDir string
	Playback  string
}

const (
	PlaybackDirect = "direct"
	PlaybackClip   = "clip"
)

// SpecFrom reads a session's stored video map, or nil when there is none.
func SpecFrom(raw map[string]any) *VideoSpec {
	if raw == nil {
		return nil
	}
	spec := &VideoSpec{
		Headers:  stringMap(raw["headers"]),
		Interval: floatOf(raw["interval"], 0),
		Duration: floatOf(raw["duration"], 0),
		Playback: PlaybackDirect,
	}
	spec.URL, _ = raw["url"].(string)
	spec.FramesDir, _ = raw["frames_dir"].(string)
	if value, ok := raw["playback"].(string); ok && value == PlaybackClip {
		spec.Playback = PlaybackClip
	}
	return spec
}

// ToMap serializes the spec back into the session row's shape.
func (v *VideoSpec) ToMap() map[string]any {
	return map[string]any{
		"url": v.URL, "headers": v.Headers, "interval": v.Interval,
		"duration": v.Duration, "frames_dir": v.FramesDir, "playback": v.Playback,
	}
}

func stringMap(value any) map[string]string {
	out := map[string]string{}
	raw, ok := value.(map[string]any)
	if !ok {
		return out
	}
	for key, val := range raw {
		if str, ok := val.(string); ok {
			out[key] = str
		}
	}
	return out
}

// floatOf reads a number out of a decoded Surreal value. A whole number round-trips
// as an integer of whatever width the CBOR decoder picked, so every width is accepted
// — a missed one would silently read as zero and disable duration clamping.
func floatOf(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int32:
		return float64(typed)
	case int64:
		return float64(typed)
	case uint:
		return float64(typed)
	case uint32:
		return float64(typed)
	case uint64:
		return float64(typed)
	case string:
		parsed, err := strconv.ParseFloat(typed, 64)
		if err != nil {
			return fallback
		}
		return parsed
	}
	return fallback
}

// Posters are stills cut from the middle of a clip so a grid cell shows the clip
// without playing it. They are pure cache: named by session, entity and exact range,
// so a trimmed span simply asks for a new one.
func PostersRoot() string { return filepath.Join(CacheRoot, "posters") }

// PosterPath names a poster after its span ref, which already encodes the source and
// the exact range. Keying on the entity's idx instead would orphan every poster the
// moment a compaction renumbered the session.
func PosterPath(sid, ref string) string {
	sum := sha1.Sum([]byte(ref))
	return filepath.Join(PostersRoot(), sid, hex.EncodeToString(sum[:])[:16]+".jpg")
}

// posterSlots bounds concurrent decodes: segmentation and a scrolling grid would
// otherwise start one ffmpeg per clip. A seek waits on the source far more than it
// works, so the cap is set above the core count on purpose.
var posterSlots = make(chan struct{}, 6)

// EnsurePoster returns the cached poster for a span, cutting it first if needed.
func EnsurePoster(spec *VideoSpec, sid, ref string, tStart, tEnd float64) (string, bool) {
	if spec == nil || spec.URL == "" {
		return "", false
	}
	path := PosterPath(sid, ref)
	if _, err := os.Stat(path); err == nil {
		return path, true
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", false
	}

	posterSlots <- struct{}{}
	defer func() { <-posterSlots }()
	midpoint := tStart + (tEnd-tStart)/2
	if !frames.SeekFrame(spec.URL, path, midpoint, spec.Headers) {
		return "", false
	}
	return path, true
}

// Cut clips are the playable counterpart of posters: a grid cell that streams ranges
// of a whole feature-length video buffers far past its own span and holds a browser
// connection while doing it, so a four-second cell plays a four-second file instead.
func ClipsRoot() string { return filepath.Join(CacheRoot, "clips") }

// ClipPath names a cut after its span ref, exactly as PosterPath does, so a trimmed
// span asks for its own cut and a compaction never orphans one.
func ClipPath(sid, ref string) string {
	sum := sha1.Sum([]byte(ref))
	return filepath.Join(ClipsRoot(), sid, hex.EncodeToString(sum[:])[:16]+".mp4")
}

// clipSlots bounds concurrent cuts. Encoding is far heavier than a poster decode, and
// a grid scrolled quickly would otherwise start one ffmpeg per cell.
var clipSlots = make(chan struct{}, 2)

// EnsureClip returns the cached cut for a span, encoding it first if needed.
func EnsureClip(spec *VideoSpec, sid, ref string, tStart, tEnd float64) (string, bool) {
	if spec == nil || spec.URL == "" {
		return "", false
	}
	path := ClipPath(sid, ref)
	if _, err := os.Stat(path); err == nil {
		return path, true
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", false
	}

	clipSlots <- struct{}{}
	defer func() { <-clipSlots }()
	// Another request may have cut it while this one waited for a slot.
	if _, err := os.Stat(path); err == nil {
		return path, true
	}
	if !frames.CutClip(spec.URL, path, tStart, tEnd, spec.Headers) {
		return "", false
	}
	return path, true
}

// Scene cuts are the timestamps where a video's picture changes enough to read as a shot
// boundary. Detecting them decodes the entire file, and the segment node re-runs on every
// session_opened, so the list is cached and only re-detected when the settings it was
// produced with no longer apply.
func ScenesRoot() string { return filepath.Join(CacheRoot, "scenes") }

// SceneCutsPath keys on the session rather than the URL: a stream's URL is re-resolved
// whenever it expires, so a URL-keyed entry would miss the cache after every refresh.
func SceneCutsPath(sid string) string {
	return filepath.Join(ScenesRoot(), sid+".json")
}

// sceneCutFile records what the cuts were detected from, so a changed threshold or a
// re-resolved source of a different length re-detects instead of reusing stale cuts.
type sceneCutFile struct {
	Threshold float64   `json:"threshold"`
	Duration  float64   `json:"duration"`
	Cuts      []float64 `json:"cuts"`
}

// sceneSlots bounds concurrent detections to one. A poster seek waits on the source and
// benefits from overlapping; a detection pass is a full decode, so running several would
// only split the same CPU between them.
var sceneSlots = make(chan struct{}, 1)

// EnsureSceneCuts returns a video's cut list, detecting it first when it is missing or
// was produced with a different threshold.
func EnsureSceneCuts(spec *VideoSpec, sid string, threshold float64) ([]float64, bool) {
	if spec == nil || spec.URL == "" || threshold <= 0 {
		return nil, false
	}
	path := SceneCutsPath(sid)
	if cuts, ok := readSceneCuts(path, threshold, spec.Duration); ok {
		return cuts, true
	}

	sceneSlots <- struct{}{}
	defer func() { <-sceneSlots }()
	// Another run may have detected the same source while this one waited for the slot.
	if cuts, ok := readSceneCuts(path, threshold, spec.Duration); ok {
		return cuts, true
	}

	cuts, ok := frames.SceneCuts(spec.URL, spec.Headers, threshold, spec.Duration)
	// A dead source and a genuinely cut-free video are indistinguishable here, and
	// caching either would freeze a failed pass in place for the session's lifetime.
	if !ok || len(cuts) == 0 {
		return nil, false
	}
	writeSceneCuts(path, sceneCutFile{Threshold: threshold, Duration: spec.Duration, Cuts: cuts})
	return cuts, true
}

func readSceneCuts(path string, threshold, duration float64) ([]float64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var cached sceneCutFile
	if err := json.Unmarshal(raw, &cached); err != nil {
		return nil, false
	}
	if cached.Threshold != threshold || cached.Duration != duration || len(cached.Cuts) == 0 {
		return nil, false
	}
	return cached.Cuts, true
}

func writeSceneCuts(path string, cached sceneCutFile) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(cached)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, raw, 0o644)
}

// Resolved is the outcome of resolving a source.
type Resolved struct {
	Items     []string
	Label     string
	Video     map[string]any // nil unless streaming video
	FramesDir string
}

// Input describes a session-create request's source fields.
type Input struct {
	Source          string
	Project         string
	Directory       string
	GalleryID       string
	SceneID         string
	Path            string // local media file (localvideo)
	IntervalSeconds int
	Images          []string
	Count           int
}

var pluginKind = map[string]string{
	"directory": "directory", "gallery": "gallery", "video": "scene",
	"localvideo": "videofile", "random": "random",
}
var stateKind = map[string]string{
	"directory": "directory", "gallery": "gallery", "video": "video",
	"localvideo": "video", "random": "random",
}

type resolveResponse struct {
	Label  string   `json:"label"`
	Items  []string `json:"items"`
	Stream *struct {
		URL      string            `json:"url"`
		Headers  map[string]string `json:"headers"`
		Interval int               `json:"interval"`
	} `json:"stream"`
}

// Resolve turns an Input into a Resolved source (+ its ref and session id) via a plugin.
func Resolve(ctx context.Context, in Input) (*Resolved, string, string, error) {
	kind := pluginKind[in.Source]
	if kind == "" {
		return nil, "", "", fmt.Errorf("unknown source %s", in.Source)
	}
	plugin := registry.Default.SourceFor(kind)
	if plugin == nil {
		return nil, "", "", fmt.Errorf("no source plugin for kind: %s", kind)
	}

	params := map[string]any{"kind": kind}
	var ref string
	switch in.Source {
	case "directory":
		if in.Directory == "" {
			return nil, "", "", fmt.Errorf("directory required")
		}
		params["path"] = in.Directory
		ref = in.Directory
	case "gallery":
		if in.GalleryID == "" {
			return nil, "", "", fmt.Errorf("galleryId required")
		}
		params["id"] = in.GalleryID
		ref = in.GalleryID
	case "video":
		if in.SceneID == "" {
			return nil, "", "", fmt.Errorf("sceneId required")
		}
		params["id"] = in.SceneID
		params["interval"] = in.IntervalSeconds
		ref = in.SceneID
	case "localvideo":
		if in.Path == "" {
			return nil, "", "", fmt.Errorf("path required")
		}
		params["path"] = in.Path
		ref = in.Path
	case "random":
		params["images"] = in.Images
		params["count"] = in.Count
		ref = randomToken()
	}

	sid := SessionID(SessionKey(in.Project, stateKind[in.Source], ref))

	raw, err := registry.Default.Call(ctx, plugin.ID, "source.resolve", params, 120*time.Second)
	if err != nil {
		return nil, "", "", err
	}
	var response resolveResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, "", "", err
	}

	resolved := &Resolved{Items: response.Items, Label: response.Label}
	if resolved.Label == "" {
		resolved.Label = in.Source
	}
	if in.Source == "random" {
		ref = "random"
	}

	if response.Stream != nil {
		framesDir := filepath.Join(FramesRoot(), sid)
		// Frame files themselves are the artifact; annotations live in Surreal.
		resolved.FramesDir = framesDir
		// (Resume of already-extracted frames is handled by the caller from the DB.)
		interval := response.Stream.Interval
		if interval == 0 {
			interval = in.IntervalSeconds
		}
		headers := response.Stream.Headers
		if headers == nil {
			headers = map[string]string{}
		}
		duration, _ := frames.ProbeDuration(response.Stream.URL, headers)
		resolved.Video = map[string]any{
			"url": response.Stream.URL, "headers": headers,
			"interval": interval, "duration": duration, "frames_dir": framesDir,
		}
	}
	return resolved, ref, sid, nil
}

// refreshGuard serializes stream re-resolution per key, so a grid of clips hitting
// an expired URL at once produces one upstream resolve instead of a dozen.
var refreshGuard = struct {
	mutex    sync.Mutex
	inFlight map[string]*sync.Mutex
}{inFlight: map[string]*sync.Mutex{}}

func refreshLock(key string) *sync.Mutex {
	refreshGuard.mutex.Lock()
	defer refreshGuard.mutex.Unlock()
	lock, ok := refreshGuard.inFlight[key]
	if !ok {
		lock = &sync.Mutex{}
		refreshGuard.inFlight[key] = lock
	}
	return lock
}

// RefreshStream re-resolves a scene's playable URL and CDN headers through its
// source plugin. Unlike Resolve it skips the ffprobe: the duration is already
// known, and this runs on the playback path where 30s of probing is not an option.
func RefreshStream(ctx context.Context, key, sceneID string) (string, map[string]string, error) {
	lock := refreshLock(key)
	lock.Lock()
	defer lock.Unlock()

	plugin := registry.Default.SourceFor("scene")
	if plugin == nil {
		return "", nil, fmt.Errorf("no source plugin for kind: scene")
	}
	raw, err := registry.Default.Call(ctx, plugin.ID,
		"source.resolve", map[string]any{"kind": "scene", "id": sceneID}, 60*time.Second)
	if err != nil {
		return "", nil, err
	}
	var response resolveResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", nil, err
	}
	if response.Stream == nil || response.Stream.URL == "" {
		return "", nil, fmt.Errorf("scene %s has no playable stream", sceneID)
	}
	headers := response.Stream.Headers
	if headers == nil {
		headers = map[string]string{}
	}
	return response.Stream.URL, headers, nil
}

// SessionKey builds the stable state key for a source (drives the session id).
func SessionKey(project, kind, ref string) string {
	var base string
	if kind == "directory" {
		abs, err := filepath.Abs(ref)
		if err != nil {
			abs = ref
		}
		base = abs
	} else {
		base = kind + "-" + slug(ref)
	}
	if project == "nsfw-tags" {
		return base
	}
	return "project/" + project + "/" + base
}

// SessionIDFor returns the session id for a non-random source without resolving it (used to
// detect a resume before making a plugin call).
func SessionIDFor(project, source, ref string) string {
	return SessionID(SessionKey(project, stateKind[source], ref))
}

// SessionID is the 12-char id derived from a session key.
func SessionID(key string) string {
	sum := sha1.Sum([]byte(key))
	return hex.EncodeToString(sum[:])[:12]
}

func slug(ref string) string {
	return strings.NewReplacer(":", "_", "/", "_").Replace(ref)
}

func randomToken() string {
	buffer := make([]byte, 4)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}
