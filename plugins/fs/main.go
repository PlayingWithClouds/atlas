// Filesystem data-source plugin (Go).
//
// Serves local media as a `source`:
//   - directory: a folder of images; resolve() scans it and each image is an entity.
//   - videofile: one video file; resolve() returns it as a stream, so the session is a
//     video and a segment node cuts it into clips. Browsing lists the videos under a
//     folder (the search box carries the folder path).
//
// Refs are local file paths the core reads directly (same machine).
//
// Run:  go run ./plugins/fs   (or: task plugin:fs)
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	pluginsdk "atlas/pluginsdk"
)

const defaultPort = 9102
const stateDirName = ".atlas"

var imageExtensions = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".webp": true,
	".bmp":  true,
}

var videoExtensions = map[string]bool{
	".mp4":  true,
	".mkv":  true,
	".webm": true,
	".mov":  true,
	".avi":  true,
	".m4v":  true,
	".wmv":  true,
	".flv":  true,
	".ts":   true,
	".mpg":  true,
	".mpeg": true,
}

func scanImages(directory string) []string {
	return scanFiles(directory, imageExtensions)
}

func scanVideos(directory string) []string {
	return scanFiles(directory, videoExtensions)
}

func scanFiles(directory string, extensions map[string]bool) []string {
	found := []string{}
	filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil // Unreadable entries are skipped, matching the TS plugin.
		}
		if entry.IsDir() {
			if entry.Name() == stateDirName {
				return filepath.SkipDir
			}
			return nil
		}
		if extensions[strings.ToLower(filepath.Ext(entry.Name()))] {
			found = append(found, path)
		}
		return nil
	})
	sort.Strings(found)
	return found
}

// probeDuration reads a local file's duration in seconds, or 0 when ffprobe can't.
// Listing a folder probes each video, which is cheap for local files.
func probeDuration(path string) float64 {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "ffprobe", "-v", "error",
		"-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path).Output()
	if err != nil {
		return 0
	}
	seconds, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil {
		return 0
	}
	return seconds
}

func kindsHandler(pluginsdk.Params) (any, error) {
	return map[string]any{
		"kinds": []map[string]any{
			{
				"id":         "directory",
				"label":      "Directory",
				"itemNoun":   "folder",
				"browsable":  false,
				"thumbnails": false,
				"layout":     "form",
				"input":      "path",
				"hint":       "Absolute path to a folder of images",
			},
			{
				"id":         "videofile",
				"label":      "Local video",
				"itemNoun":   "video",
				"browsable":  true,
				"thumbnails": false,
				"layout":     "grid",
				"input":      "path",
				"hint":       "Absolute path to a folder of videos (or set FS_VIDEO_ROOT)",
			},
		},
	}, nil
}

// listHandler browses videos under a folder. The search box carries the folder path, so
// a browsable kind works without a separate picker; FS_VIDEO_ROOT is the default when it
// is empty. A plain word filters by filename instead of switching folders.
func listHandler(params pluginsdk.Params) (any, error) {
	kind, _ := params["kind"].(string)
	if kind != "videofile" {
		return nil, fmt.Errorf("unknown kind: %s", kind)
	}
	search, _ := params["search"].(string)
	search = strings.TrimSpace(search)

	root := os.Getenv("FS_VIDEO_ROOT")
	filter := ""
	if search != "" {
		if info, err := os.Stat(search); err == nil && info.IsDir() {
			root = search
		} else {
			filter = strings.ToLower(search)
		}
	}
	if root == "" {
		return map[string]any{"items": []any{}}, nil
	}

	paths := scanVideos(root)
	if filter != "" {
		matched := paths[:0]
		for _, path := range paths {
			if strings.Contains(strings.ToLower(filepath.Base(path)), filter) {
				matched = append(matched, path)
			}
		}
		paths = matched
	}

	offset := intParam(params, "offset", 0)
	limit := intParam(params, "limit", 40)
	paths = pageOf(paths, offset, limit)

	items := make([]map[string]any, 0, len(paths))
	for _, path := range paths {
		items = append(items, map[string]any{
			"id":       path,
			"title":    filepath.Base(path),
			"duration": probeDuration(path),
			"meta":     map[string]any{"dir": filepath.Dir(path)},
		})
	}
	return map[string]any{"items": items}, nil
}

func pageOf(paths []string, offset, limit int) []string {
	if offset < 0 || offset >= len(paths) {
		return nil
	}
	end := len(paths)
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	return paths[offset:end]
}

func intParam(params pluginsdk.Params, key string, fallback int) int {
	switch value := params[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	}
	return fallback
}

func resolveHandler(params pluginsdk.Params) (any, error) {
	kind, _ := params["kind"].(string)
	path, _ := params["path"].(string)
	if path == "" {
		return nil, errors.New("path required")
	}
	switch kind {
	case "directory":
		return resolveDirectory(path)
	case "videofile":
		return resolveVideoFile(path)
	}
	return nil, fmt.Errorf("unknown kind: %s", kind)
}

func resolveDirectory(path string) (any, error) {
	directory, err := filepath.Abs(path)
	if err != nil {
		return nil, errors.New("directory not found")
	}
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return nil, errors.New("directory not found")
	}

	images := scanImages(directory)
	// A folder of videos is a common mistake here — say where those belong.
	if len(images) == 0 && len(scanVideos(directory)) > 0 {
		return nil, errors.New("folder holds videos, not images — open them under Local video")
	}
	return map[string]any{"label": filepath.Base(directory), "items": images}, nil
}

// resolveVideoFile returns the file as a stream, which makes the session a video one:
// the core probes its duration and a segment node cuts it into clip entities. A folder
// is rejected here — one session is one video.
func resolveVideoFile(path string) (any, error) {
	file, err := filepath.Abs(path)
	if err != nil {
		return nil, errors.New("video not found")
	}
	info, err := os.Stat(file)
	if err != nil {
		return nil, errors.New("video not found")
	}
	if info.IsDir() {
		return nil, errors.New("pick a video file, not a folder")
	}
	if !videoExtensions[strings.ToLower(filepath.Ext(file))] {
		return nil, fmt.Errorf("not a video file: %s", filepath.Base(file))
	}
	return map[string]any{
		"label":  filepath.Base(file),
		"items":  []string{},
		"stream": map[string]any{"url": file, "headers": map[string]string{}, "interval": 20},
	}, nil
}

func port() int {
	value := os.Getenv("FS_PLUGIN_PORT")
	if value == "" {
		return defaultPort
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return defaultPort
	}
	return parsed
}

func main() {
	plugin := pluginsdk.New("fs")
	plugin.Declare("source", map[string]any{"kinds": []string{"directory", "videofile"}, "browsable": true})
	plugin.Method("source.kinds", kindsHandler)
	plugin.Method("source.list", listHandler)
	plugin.Method("source.resolve", resolveHandler)
	log.Fatal(plugin.Serve(port()))
}
