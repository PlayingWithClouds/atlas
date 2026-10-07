// Media playback for temporal spans. A clip is a time range over its session's video,
// so the browser needs the video itself — but the stream URL only works with the CDN
// headers the source plugin resolved, which a <video> element cannot send. Both handlers
// here exist to put those headers back on: /video proxies byte ranges of the whole file,
// /clip/{id} remuxes one span with ffmpeg for sources that don't answer ranges (HLS).
package api

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

// Media responses are long-lived streams, so the client carries no overall timeout —
// cancellation comes from the request context when the browser aborts a range.
var mediaClient = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
	},
	CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		// Go drops headers across hosts; the CDN headers are required on every hop.
		for key, values := range via[0].Header {
			request.Header[key] = values
		}
		return nil
	},
}

// Headers forwarded upstream from the browser: everything range/validator related,
// so seeking and revalidation keep working through the proxy.
var passThroughRequestHeaders = []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"}

// Headers copied back to the browser. Content-Length and Content-Range must survive
// intact or seeking breaks.
var passThroughResponseHeaders = []string{
	"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified",
}

func handleSessionVideo(w http.ResponseWriter, r *http.Request) {
	session, _, ok := requireSession(w, r)
	if !ok {
		return
	}
	spec := sources.SpecFrom(session.Video)
	if spec == nil || spec.URL == "" {
		writeError(w, http.StatusNotFound, "session has no video source")
		return
	}
	if !sources.IsRemote(spec.URL) {
		serveLocalVideo(w, r, spec.URL)
		return
	}
	if isHLS(spec.URL) {
		writeError(w, http.StatusUnsupportedMediaType, "HLS source — play clips via /clip/{image_id}")
		return
	}

	status, err := proxyUpstream(w, r, session, spec, spec.URL)
	if err == nil && !isStaleUpstream(status) {
		return
	}
	// A stored stream URL goes stale two ways: the signature expires (an auth or
	// not-found status) or the host it pointed at is gone (a transport error).
	// Both are fixed by re-resolving the scene once.
	refreshed, refreshErr := refreshSessionStream(r, session, spec)
	if refreshErr != nil {
		writeError(w, http.StatusBadGateway, "stream unavailable: "+refreshErr.Error())
		return
	}
	retried, retryErr := proxyUpstream(w, r, session, spec, refreshed)
	if retryErr != nil {
		writeError(w, http.StatusBadGateway, retryErr.Error())
		return
	}
	if isStaleUpstream(retried) {
		writeError(w, http.StatusBadGateway, "stream rejected the request: HTTP "+strconv.Itoa(retried))
	}
}

// minSpanSeconds is the shortest clip the UI may trim to, enforced on both the
// trim endpoint and the server-side cut so they can never disagree.
const minSpanSeconds = 0.25

// maxRangeBytes bounds one video response. A player asks for "bytes=N-" — the whole
// rest of the file — but only buffers a few seconds before it stops reading, leaving
// the connection parked mid-body with megabytes queued behind it. A grid cell per
// hover parks another, and at six sockets per host the browser has none left for
// posters. Answering a bounded slice instead lets every response finish immediately;
// the player asks for the next slice when it needs one.
const maxRangeBytes = 4 << 20

// serveLocalVideo serves a video file from disk with open-ended ranges bounded.
// ServeFile reads the Range header off the request, so clamping it there is enough.
func serveLocalVideo(w http.ResponseWriter, r *http.Request, path string) {
	info, err := os.Stat(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "video file is gone: "+err.Error())
		return
	}
	if bounded, ok := boundedRange(r.Header.Get("Range"), info.Size()); ok {
		r.Header.Set("Range", bounded)
	}
	// The file does not change under a session, so a re-hover should not refetch it.
	w.Header().Set("Cache-Control", "private, max-age=300")
	// ServeFile handles the (now bounded) Range, If-Range, ETag and Last-Modified.
	http.ServeFile(w, r, path)
}

// boundedRange rewrites an open-ended "bytes=N-" into a slice of at most
// maxRangeBytes. Total size may be unknown (0) when proxying, in which case the end
// is not clamped to the file. Anything that is not a single open-ended range — an
// already bounded range, a suffix range, a multi-range — is left alone.
func boundedRange(header string, totalSize int64) (string, bool) {
	const prefix = "bytes="
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	spec := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	if !strings.HasSuffix(spec, "-") || strings.Contains(spec, ",") {
		return "", false
	}
	start, err := strconv.ParseInt(strings.TrimSuffix(spec, "-"), 10, 64)
	if err != nil || start < 0 {
		return "", false
	}
	if totalSize > 0 && start >= totalSize {
		// Out of range: let the real 416 come from ServeFile or upstream.
		return "", false
	}
	end := start + maxRangeBytes - 1
	if totalSize > 0 && end >= totalSize-1 {
		// The rest of the file already fits in one slice; nothing to bound.
		return "", false
	}
	return prefix + strconv.FormatInt(start, 10) + "-" + strconv.FormatInt(end, 10), true
}

// proxyUpstream streams one upstream response through to the client. It returns the
// upstream status without writing anything when that status means "retry after a
// refresh", so the caller can re-resolve the URL and try again.
func proxyUpstream(w http.ResponseWriter, r *http.Request, session *sessions.Session,
	spec *sources.VideoSpec, url string) (int, error) {

	request, err := http.NewRequestWithContext(r.Context(), r.Method, url, nil)
	if err != nil {
		return 0, err
	}
	for key, value := range spec.Headers {
		request.Header.Set(key, value)
	}
	for _, key := range passThroughRequestHeaders {
		if value := r.Header.Get(key); value != "" {
			request.Header.Set(key, value)
		}
	}
	// Bound the slice asked of the CDN for the same reason as the local path: an
	// open-ended range keeps a socket parked once the player stops reading.
	if bounded, ok := boundedRange(r.Header.Get("Range"), 0); ok {
		request.Header.Set("Range", bounded)
	}
	// A transfer encoding layer would break the byte-range arithmetic.
	request.Header.Set("Accept-Encoding", "identity")

	response, err := mediaClient.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if isStaleUpstream(response.StatusCode) {
		return response.StatusCode, nil
	}

	recordPlaybackMode(r, session, spec, response)
	for _, key := range passThroughResponseHeaders {
		if value := response.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	// Unlike still images, many cells request overlapping ranges of the same file;
	// the browser cache is what keeps that affordable.
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(response.StatusCode)
	if r.Method == http.MethodHead {
		return response.StatusCode, nil
	}
	if _, copyErr := io.Copy(w, response.Body); copyErr != nil && !isClientGone(copyErr) {
		return response.StatusCode, nil
	}
	return response.StatusCode, nil
}

// recordPlaybackMode downgrades the session to clip playback when the source ignores
// byte ranges — the UI then stops asking for the whole file and plays cut clips.
func recordPlaybackMode(r *http.Request, session *sessions.Session,
	spec *sources.VideoSpec, response *http.Response) {

	if spec.Playback == sources.PlaybackClip {
		return
	}
	rangeRequested := r.Header.Get("Range") != ""
	ignoresRanges := rangeRequested && response.StatusCode == http.StatusOK
	if !ignoresRanges && !strings.EqualFold(response.Header.Get("Accept-Ranges"), "none") {
		return
	}
	spec.Playback = sources.PlaybackClip
	_ = sessions.Default.SetVideo(r.Context(), session.ID, spec.ToMap())
}

// refreshSessionStream re-resolves the scene's stream URL and persists it. The image
// refs are deliberately left alone: they encode the old URL and the vector pool is
// keyed by them, so rewriting refs would orphan every embedding.
func refreshSessionStream(r *http.Request, session *sessions.Session, spec *sources.VideoSpec) (string, error) {
	url, headers, err := sources.RefreshStream(r.Context(), session.ID, session.Ref)
	if err != nil {
		return "", err
	}
	spec.URL = url
	spec.Headers = headers
	if err := sessions.Default.SetVideo(r.Context(), session.ID, spec.ToMap()); err != nil {
		return "", err
	}
	return url, nil
}

// handleSessionClip cuts one span server-side. Used when the source can't be byte-range
// played (HLS, or a CDN that ignores Range), and for previewing a trim before saving it:
// start/end override the stored range.
func handleSessionClip(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	spec := sources.SpecFrom(session.Video)
	if spec == nil || spec.URL == "" {
		writeError(w, http.StatusNotFound, "session has no video source")
		return
	}
	idx, err := strconv.Atoi(r.PathValue("image_id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad image id")
		return
	}
	image, _ := st.GetImage(r.Context(), idx)
	if image == nil {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	start, end, ok := clipRange(r, image, spec.Duration)
	if !ok {
		writeError(w, http.StatusBadRequest, "not a temporal span")
		return
	}

	// The cut is named after the span at this exact range, so a trim preview asks for
	// its own file instead of replaying the stored one.
	ref := image.Ref
	if base, _, _, isFragment := store.SplitSpanRef(image.Ref); isFragment {
		ref = store.SpanRef(base, start, end)
	}
	path, ok := sources.EnsureClip(spec, session.ID, ref, start, end)
	if !ok {
		writeError(w, http.StatusBadGateway, "could not cut this clip")
		return
	}
	// Immutable: the path already encodes the range, so a trimmed span asks for a new
	// one. Serving a file rather than an ffmpeg pipe also restores Range support, so a
	// player can seek inside the clip instead of refetching it.
	w.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	http.ServeFile(w, r, path)
}

// handleSessionPoster serves a still from the middle of a span, so a grid cell that is
// not playing still shows the clip rather than a placeholder. Frames are cached on disk
// under the span's range, so scrolling back is free and a trim invalidates naturally.
func handleSessionPoster(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	spec := sources.SpecFrom(session.Video)
	if spec == nil || spec.URL == "" {
		writeError(w, http.StatusNotFound, "session has no video source")
		return
	}
	idx, err := strconv.Atoi(r.PathValue("image_id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad image id")
		return
	}
	image, _ := st.GetImage(r.Context(), idx)
	if image == nil {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	start, end, isSpan := clipRange(r, image, spec.Duration)
	if !isSpan {
		writeError(w, http.StatusBadRequest, "not a temporal span")
		return
	}

	// The poster is named after the span at this exact range, so a trim preview asks
	// for its own frame instead of reusing the stored one.
	ref := image.Ref
	if base, _, _, isFragment := store.SplitSpanRef(image.Ref); isFragment {
		ref = store.SpanRef(base, start, end)
	}
	// Segmentation pre-cuts these, so this usually just serves a file.
	path, ok := sources.EnsurePoster(spec, session.ID, ref, start, end)
	if !ok {
		writeError(w, http.StatusBadGateway, "could not decode a frame for this clip")
		return
	}
	// Immutable: the path already encodes the range, so a trimmed span asks for a new one.
	w.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	http.ServeFile(w, r, path)
}

// clipRange resolves the range to cut: the span's stored one, overridden by start/end
// query params while a trim is being dragged. Both are clamped to the video.
func clipRange(r *http.Request, image *store.Image, duration float64) (float64, float64, bool) {
	if image.TStart == nil || image.TEnd == nil {
		return 0, 0, false
	}
	start, end := *image.TStart, *image.TEnd
	if value := queryFloat(r, "start"); value > 0 {
		start = value
	}
	if value := queryFloat(r, "end"); value > 0 {
		end = value
	}
	if start < 0 {
		start = 0
	}
	if duration > 0 && end > duration {
		end = duration
	}
	if end-start < minSpanSeconds {
		end = start + minSpanSeconds
	}
	return start, end, true
}

func isHLS(url string) bool {
	path := url
	if cut := strings.IndexAny(url, "?#"); cut >= 0 {
		path = url[:cut]
	}
	return strings.HasSuffix(strings.ToLower(path), ".m3u8")
}

func isStaleUpstream(status int) bool {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusGone:
		return true
	}
	return false
}

// isClientGone reports whether a copy failed because the browser hung up — routine
// when a <video> aborts a range request mid-flight.
func isClientGone(err error) bool {
	return errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, http.ErrBodyNotAllowed)
}
