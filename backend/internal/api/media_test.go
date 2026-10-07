package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

// A CDN that only answers when the resolved headers are present, and honours ranges.
func fakeUpstream(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Referer") != "https://cdn.example.com/" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Accept-Ranges", "bytes")
		if r.Header.Get("Range") == "bytes=0-3" {
			w.Header().Set("Content-Range", "bytes 0-3/"+strconv.Itoa(len(body)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write([]byte(body[:4]))
			return
		}
		_, _ = w.Write([]byte(body))
	}))
}

func TestProxyUpstreamForwardsHeadersAndRanges(t *testing.T) {
	upstream := fakeUpstream(t, "0123456789")
	defer upstream.Close()

	spec := &sources.VideoSpec{
		URL:      upstream.URL,
		Headers:  map[string]string{"Referer": "https://cdn.example.com/"},
		Playback: sources.PlaybackDirect,
	}
	session := &sessions.Session{ID: "test"}

	request := httptest.NewRequest(http.MethodGet, "/api/sessions/test/video", nil)
	request.Header.Set("Range", "bytes=0-3")
	recorder := httptest.NewRecorder()

	status, err := proxyUpstream(recorder, request, session, spec, spec.URL)
	if err != nil {
		t.Fatalf("proxyUpstream: %v", err)
	}
	if status != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206 (the CDN headers must reach upstream)", status)
	}
	if body := recorder.Body.String(); body != "0123" {
		t.Errorf("body = %q, want the requested range %q", body, "0123")
	}
	if got := recorder.Header().Get("Content-Range"); got == "" {
		t.Error("Content-Range was not copied back; seeking would break")
	}
	if got := recorder.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes", got)
	}
}

func TestProxyUpstreamReportsStaleWithoutWriting(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer upstream.Close()

	spec := &sources.VideoSpec{URL: upstream.URL, Playback: sources.PlaybackDirect}
	request := httptest.NewRequest(http.MethodGet, "/api/sessions/test/video", nil)
	recorder := httptest.NewRecorder()

	status, err := proxyUpstream(recorder, request, &sessions.Session{ID: "test"}, spec, spec.URL)
	if err != nil {
		t.Fatalf("proxyUpstream: %v", err)
	}
	if !isStaleUpstream(status) {
		t.Fatalf("status = %d, want a stale status so the caller re-resolves", status)
	}
	// Nothing may be written yet: the caller still has to retry after refreshing.
	if recorder.Body.Len() != 0 {
		t.Error("body was written before the refresh retry")
	}
}

func TestClipRangeUsesQueryOverrideAndClamps(t *testing.T) {
	start, end := 10.0, 14.0
	span := &store.Image{Idx: 1, TStart: &start, TEnd: &end}

	request := httptest.NewRequest(http.MethodGet, "/api/sessions/test/clip/1", nil)
	gotStart, gotEnd, ok := clipRange(request, span, 3600)
	if !ok || gotStart != 10 || gotEnd != 14 {
		t.Fatalf("stored range = (%v, %v, %v), want (10, 14, true)", gotStart, gotEnd, ok)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/sessions/test/clip/1?start=11.5&end=99999", nil)
	gotStart, gotEnd, _ = clipRange(request, span, 3600)
	if gotStart != 11.5 || gotEnd != 3600 {
		t.Errorf("override = (%v, %v), want (11.5, 3600) clamped to the duration", gotStart, gotEnd)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/sessions/test/clip/1?start=20&end=20.01", nil)
	gotStart, gotEnd, _ = clipRange(request, span, 3600)
	if gotEnd-gotStart != minSpanSeconds {
		t.Errorf("degenerate range = (%v, %v), want widened to %v", gotStart, gotEnd, minSpanSeconds)
	}

	plain := &store.Image{Idx: 2}
	if _, _, ok := clipRange(request, plain, 3600); ok {
		t.Error("a plain image was accepted as a span")
	}
}

func TestBoundedRangeOnlyClampsOpenEndedRanges(t *testing.T) {
	const total = 100 << 20
	cases := []struct {
		header string
		total  int64
		want   string
	}{
		// The case that starves the connection pool: bound it.
		{"bytes=0-", total, "bytes=0-" + strconv.Itoa(maxRangeBytes-1)},
		{"bytes=1000-", total, "bytes=1000-" + strconv.Itoa(1000+maxRangeBytes-1)},
		// Unknown total (proxying): still bounded.
		{"bytes=0-", 0, "bytes=0-" + strconv.Itoa(maxRangeBytes-1)},
		// Already bounded, a suffix range, a multi-range, or no range: untouched.
		{"bytes=0-1023", total, ""},
		{"bytes=-1024", total, ""},
		{"bytes=0-,2048-", total, ""},
		{"", total, ""},
		// The remainder already fits in one slice, so bounding would add a round trip.
		{"bytes=0-", maxRangeBytes, ""},
		// Past the end: let the real 416 come from ServeFile or upstream.
		{"bytes=" + strconv.Itoa(total) + "-", total, ""},
	}
	for _, testCase := range cases {
		got, ok := boundedRange(testCase.header, testCase.total)
		if testCase.want == "" {
			if ok {
				t.Errorf("boundedRange(%q, %d) = %q, want it left alone", testCase.header, testCase.total, got)
			}
			continue
		}
		if !ok || got != testCase.want {
			t.Errorf("boundedRange(%q, %d) = %q (ok=%v), want %q", testCase.header, testCase.total, got, ok, testCase.want)
		}
	}
}

func TestServeLocalVideoBoundsOpenEndedRange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(path, make([]byte, maxRangeBytes*3), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/sessions/test/video", nil)
	request.Header.Set("Range", "bytes=0-")
	recorder := httptest.NewRecorder()
	serveLocalVideo(recorder, request, path)

	if recorder.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", recorder.Code)
	}
	if recorder.Body.Len() != maxRangeBytes {
		t.Errorf("body = %d bytes, want %d — an unbounded body parks the connection",
			recorder.Body.Len(), maxRangeBytes)
	}
	if got := recorder.Header().Get("Content-Range"); got != "bytes 0-"+strconv.Itoa(maxRangeBytes-1)+"/"+strconv.Itoa(maxRangeBytes*3) {
		t.Errorf("Content-Range = %q, want the bounded slice of the full size", got)
	}
	if got := recorder.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes so the player keeps seeking", got)
	}
}

func TestIsHLS(t *testing.T) {
	hls := []string{"https://cdn.example.com/a.m3u8", "https://cdn.example.com/a.M3U8?token=1"}
	for _, url := range hls {
		if !isHLS(url) {
			t.Errorf("isHLS(%q) = false, want true", url)
		}
	}
	if isHLS("https://cdn.example.com/a.mp4?list=b.m3u8") {
		t.Error("a query parameter must not make a URL count as HLS")
	}
}
