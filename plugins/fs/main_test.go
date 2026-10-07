package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanImagesFiltersSortsAndSkipsStateDir(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "b.jpg"))
	touch(t, filepath.Join(root, "a.PNG"))
	touch(t, filepath.Join(root, "notes.txt"))
	touch(t, filepath.Join(root, "sub", "c.webp"))
	touch(t, filepath.Join(root, ".atlas", "cached.jpg"))

	want := []string{
		filepath.Join(root, "a.PNG"),
		filepath.Join(root, "b.jpg"),
		filepath.Join(root, "sub", "c.webp"),
	}
	got := scanImages(root)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scanImages = %v, want %v", got, want)
	}
}

func TestResolveDirectoryPointsVideoFoldersAtTheRightKind(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "scene.mp4"))

	_, err := resolveHandler(map[string]any{"kind": "directory", "path": root})
	if err == nil {
		t.Fatal("expected a folder of videos to be rejected by the directory kind")
	}
	if !strings.Contains(err.Error(), "Local video") {
		t.Fatalf("error = %q, want it to point at the Local video kind", err)
	}
}

func TestResolveVideoFileReturnsAStream(t *testing.T) {
	root := t.TempDir()
	video := filepath.Join(root, "scene.mp4")
	touch(t, video)

	result, err := resolveHandler(map[string]any{"kind": "videofile", "path": video})
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["label"] != "scene.mp4" {
		t.Fatalf("label = %v", payload["label"])
	}
	stream, ok := payload["stream"].(map[string]any)
	if !ok {
		t.Fatal("no stream block — the session would not be a video one")
	}
	if stream["url"] != video {
		t.Fatalf("stream url = %v, want %v", stream["url"], video)
	}

	// A folder, or a non-video file, is not a clip source.
	if _, err := resolveHandler(map[string]any{"kind": "videofile", "path": root}); err == nil {
		t.Error("expected a folder to be rejected")
	}
	touch(t, filepath.Join(root, "notes.txt"))
	if _, err := resolveHandler(map[string]any{"kind": "videofile", "path": filepath.Join(root, "notes.txt")}); err == nil {
		t.Error("expected a non-video file to be rejected")
	}
}

func TestListHandlerBrowsesFolderAndFilters(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "alpha.mp4"))
	touch(t, filepath.Join(root, "beta.mkv"))
	touch(t, filepath.Join(root, "notes.txt"))

	listed := func(search string) []string {
		result, err := listHandler(map[string]any{"kind": "videofile", "search": search})
		if err != nil {
			t.Fatal(err)
		}
		items := result.(map[string]any)["items"].([]map[string]any)
		titles := make([]string, 0, len(items))
		for _, item := range items {
			titles = append(titles, item["title"].(string))
		}
		return titles
	}

	// The search box carries the folder path.
	if got := listed(root); !reflect.DeepEqual(got, []string{"alpha.mp4", "beta.mkv"}) {
		t.Fatalf("browse = %v", got)
	}
	// A plain word filters within the configured root instead.
	t.Setenv("FS_VIDEO_ROOT", root)
	if got := listed("beta"); !reflect.DeepEqual(got, []string{"beta.mkv"}) {
		t.Fatalf("filter = %v", got)
	}
}

func TestPageOf(t *testing.T) {
	paths := []string{"a", "b", "c", "d"}
	if got := pageOf(paths, 0, 2); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Errorf("first page = %v", got)
	}
	if got := pageOf(paths, 2, 10); !reflect.DeepEqual(got, []string{"c", "d"}) {
		t.Errorf("limit past the end = %v", got)
	}
	if got := pageOf(paths, 9, 2); got != nil {
		t.Errorf("offset past the end = %v, want nil", got)
	}
}

func TestResolveRejectsBadInput(t *testing.T) {
	if _, err := resolveHandler(map[string]any{"kind": "gallery", "path": "/tmp"}); err == nil {
		t.Fatal("expected unknown kind error")
	}
	if _, err := resolveHandler(map[string]any{"kind": "directory"}); err == nil {
		t.Fatal("expected path required error")
	}
	if _, err := resolveHandler(map[string]any{"kind": "directory", "path": "/nonexistent-atlas-test"}); err == nil {
		t.Fatal("expected directory not found error")
	}
}

func TestResolveReturnsLabelAndItems(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "x.jpg"))

	result, err := resolveHandler(map[string]any{"kind": "directory", "path": root})
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["label"] != filepath.Base(root) {
		t.Fatalf("label = %v", payload["label"])
	}
	items := payload["items"].([]string)
	if len(items) != 1 || items[0] != filepath.Join(root, "x.jpg") {
		t.Fatalf("items = %v", items)
	}
}
