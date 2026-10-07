package sources

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureClipServesTheCacheWithoutEncoding(t *testing.T) {
	original := CacheRoot
	CacheRoot = t.TempDir()
	defer func() { CacheRoot = original }()

	const sid = "test-session"
	ref := spanRef("/videos/feature.mp4", 1256, 1260)
	path := ClipPath(sid, ref)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("cached cut"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	// The URL is deliberately unplayable: a cache hit must not reach ffmpeg.
	spec := &VideoSpec{URL: "/videos/feature.mp4"}
	got, ok := EnsureClip(spec, sid, ref, 1256, 1260)
	if !ok || got != path {
		t.Fatalf("EnsureClip = (%q, %v), want the cached %q", got, ok, path)
	}
}

func TestClipPathIsKeyedByTheExactRange(t *testing.T) {
	original := CacheRoot
	CacheRoot = t.TempDir()
	defer func() { CacheRoot = original }()

	base := "/videos/feature.mp4"
	stored := ClipPath("s", spanRef(base, 10, 14))
	trimmed := ClipPath("s", spanRef(base, 10.5, 14))
	if stored == trimmed {
		t.Error("a trimmed span reuses the stored cut; the preview would play the wrong range")
	}
	if !strings.HasSuffix(stored, ".mp4") {
		t.Errorf("ClipPath = %q, want an .mp4 so ServeFile sends a video content type", stored)
	}
}

func TestEnsureClipRejectsASpecWithoutASource(t *testing.T) {
	if _, ok := EnsureClip(nil, "s", "ref", 0, 1); ok {
		t.Error("a nil spec was accepted")
	}
	if _, ok := EnsureClip(&VideoSpec{}, "s", "ref", 0, 1); ok {
		t.Error("a spec with no URL was accepted")
	}
}

// spanRef mirrors store.SpanRef; duplicated here so the cache test does not pull the
// store package in just to format a ref.
func spanRef(base string, tStart, tEnd float64) string {
	return fmt.Sprintf("%s#t=%.3f,%.3f", base, tStart, tEnd)
}
