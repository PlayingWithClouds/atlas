// Package frames extracts video frames by seeking directly to each timestamp (-ss before
// -i for fast keyframe seek over HTTP Range), so frames stream from t=0. Port of frames.py.
package frames

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ListFrames returns extracted frame files in order.
func ListFrames(dir string) []string {
	matches, err := filepath.Glob(filepath.Join(dir, "frame_*.jpg"))
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	return matches
}

// HeaderArgs builds ffmpeg/ffprobe -headers arguments from a header map.
func HeaderArgs(headers map[string]string) []string {
	if len(headers) == 0 {
		return nil
	}
	var builder strings.Builder
	for key, value := range headers {
		builder.WriteString(key)
		builder.WriteString(": ")
		builder.WriteString(value)
		builder.WriteString("\r\n")
	}
	return []string{"-headers", builder.String()}
}

// A CDN can accept the connection and then stop sending, which leaves ffmpeg waiting
// on a socket that never closes. Without a bound one dead stream parks a segmentation
// run forever, so every invocation carries a deadline.
const (
	probeTimeout = 30 * time.Second
	seekTimeout  = 60 * time.Second
	cutTimeout   = 180 * time.Second
	// Scene detection decodes the whole file rather than seeking into it, so its
	// deadline scales with the runtime instead of being a flat number.
	sceneFloorTimeout = 5 * time.Minute
)

// ProbeDuration returns the media duration in seconds, or (0, false) if unknown.
func ProbeDuration(url string, headers map[string]string) (float64, bool) {
	args := []string{"-v", "error"}
	args = append(args, HeaderArgs(headers)...)
	args = append(args, "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", url)

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "ffprobe", args...).Output()
	if err != nil {
		return 0, false
	}
	duration, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil {
		return 0, false
	}
	return duration, true
}

// CutClip writes one span to a self-contained MP4. Stream copy would snap the cut to
// the nearest keyframe, so the clip that plays would not be the range that gets
// labeled — re-encode instead, at a fast preset and without audio (playback is muted).
// The cut goes to a temp file first so a killed ffmpeg never leaves a partial clip
// behind for the cache to serve.
func CutClip(url, outPath string, start, end float64, headers map[string]string) bool {
	temp := outPath + ".partial"
	args := []string{"-y", "-nostdin", "-loglevel", "error"}
	args = append(args, HeaderArgs(headers)...)
	args = append(args,
		"-ss", strconv.FormatFloat(start, 'f', 3, 64),
		"-i", url,
		"-t", strconv.FormatFloat(end-start, 'f', 3, 64),
		"-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
		"-movflags", "+faststart", "-f", "mp4", temp)

	ctx, cancel := context.WithTimeout(context.Background(), cutTimeout)
	defer cancel()
	if err := exec.CommandContext(ctx, "ffmpeg", args...).Run(); err != nil {
		_ = os.Remove(temp)
		return false
	}
	info, err := os.Stat(temp)
	if err != nil || info.Size() == 0 {
		_ = os.Remove(temp)
		return false
	}
	if err := os.Rename(temp, outPath); err != nil {
		_ = os.Remove(temp)
		return false
	}
	return true
}

// SceneCuts returns the timestamps where the picture changes enough to read as a shot
// boundary, in seconds from the start. Unlike every other call here it decodes the whole
// file, so callers are expected to cache the result rather than ask twice.
func SceneCuts(url string, headers map[string]string, threshold, duration float64) ([]float64, bool) {
	if url == "" || threshold <= 0 {
		return nil, false
	}
	args := []string{"-nostdin", "-loglevel", "error"}
	args = append(args, HeaderArgs(headers)...)
	args = append(args, "-i", url, "-filter:v", sceneFilter(threshold),
		"-an", "-sn", "-f", "null", "-")

	ctx, cancel := context.WithTimeout(context.Background(), sceneTimeout(duration))
	defer cancel()
	output, err := exec.CommandContext(ctx, "ffmpeg", args...).Output()
	if err != nil {
		return nil, false
	}
	return ParseSceneCuts(string(output)), true
}

// sceneFilter scores each frame against the one before it and prints the timestamp of
// every frame that crosses the threshold. The downscale comes first on purpose: the
// score only has to notice that the picture changed, and running it on 160px frames is
// what makes decoding a whole feature-length video affordable.
func sceneFilter(threshold float64) string {
	return fmt.Sprintf("scale=w=160:h=-2,select='gt(scene,%.3f)',metadata=print:file=-", threshold)
}

// sceneTimeout budgets a detection pass. A downscaled decode runs far faster than
// realtime, so half the runtime is generous, with a floor so short videos still get a
// workable deadline over a slow connection.
func sceneTimeout(duration float64) time.Duration {
	budget := time.Duration(duration/2) * time.Second
	if budget < sceneFloorTimeout {
		return sceneFloorTimeout
	}
	return budget
}

// ParseSceneCuts reads cut timestamps out of the metadata filter's print output, which
// pairs a frame line with the score that selected it:
//
//	frame:12 pts:98304 pts_time:2.048
//	lavfi.scene_score=0.412000
func ParseSceneCuts(output string) []float64 {
	var cuts []float64
	for _, line := range strings.Split(output, "\n") {
		seconds, ok := ptsTime(line)
		if !ok {
			continue
		}
		cuts = append(cuts, seconds)
	}
	return cuts
}

func ptsTime(line string) (float64, bool) {
	marker := strings.Index(line, "pts_time:")
	if marker < 0 {
		return 0, false
	}
	field := line[marker+len("pts_time:"):]
	if end := strings.IndexAny(field, " \t"); end >= 0 {
		field = field[:end]
	}
	seconds, err := strconv.ParseFloat(strings.TrimSpace(field), 64)
	if err != nil {
		return 0, false
	}
	return seconds, true
}

// SeekFrame writes a single JPEG at the given timestamp. Returns true on success.
func SeekFrame(url, outPath string, seconds float64, headers map[string]string) bool {
	args := []string{"-y", "-nostdin", "-loglevel", "error"}
	args = append(args, HeaderArgs(headers)...)
	args = append(args,
		"-ss", strconv.FormatFloat(seconds, 'f', 3, 64),
		"-i", url, "-frames:v", "1", "-q:v", "3", outPath)

	ctx, cancel := context.WithTimeout(context.Background(), seekTimeout)
	defer cancel()
	if err := exec.CommandContext(ctx, "ffmpeg", args...).Run(); err != nil {
		return false
	}
	info, err := os.Stat(outPath)
	return err == nil && info.Size() > 0
}
