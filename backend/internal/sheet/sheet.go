// Package sheet renders a session at a glance: its entities' posters tiled into one
// image. It exists for readers that can only look at one picture at a time — a vision
// model asked "what is in this session" would otherwise need one request per clip.
package sheet

import (
	"context"
	"image"
	"image/jpeg"
	_ "image/png" // posters are JPEG; a directory source can hand us PNG stills
	"io"
	"os"

	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

const (
	tileWidth  = 240
	tileHeight = 135 // 16:9, the shape nearly every source arrives in
	Columns    = 6
	MaxTiles   = 48
	// DefaultTiles is a compromise: enough of a session to characterize it, few enough
	// that each cell survives being scaled down for a model to look at.
	DefaultTiles = 24
)

// Tile names one cell so a caller can map what it sees back onto entities.
type Tile struct {
	Position int     `json:"position"`
	Idx      int     `json:"idx"`
	Ref      string  `json:"ref"`
	Status   string  `json:"status"`
	TStart   float64 `json:"t_start,omitempty"`
	TEnd     float64 `json:"t_end,omitempty"`
}

// Index describes a rendered sheet: its layout, and which entity each cell holds. An
// image only helps a reader that can say which clip it means.
type Index struct {
	Columns int    `json:"columns"`
	Total   int    `json:"total"`
	From    int    `json:"from"`
	Tiles   []Tile `json:"tiles"`
}

// Render tiles a window of a session's entities into one image, with the index that
// explains it.
func Render(ctx context.Context, session *sessions.Session, from, count int) (image.Image, Index, error) {
	st := store.Open(session.ID, nil)
	images, err := st.All(ctx)
	if err != nil {
		return nil, Index{}, err
	}
	selected := window(images, from, count)
	index := Index{Columns: Columns, Total: len(images), From: max(from, 0), Tiles: make([]Tile, 0, len(selected))}
	for position, entity := range selected {
		tile := Tile{Position: position, Idx: entity.Idx, Ref: entity.Ref, Status: entity.Status}
		if entity.TStart != nil && entity.TEnd != nil {
			tile.TStart, tile.TEnd = *entity.TStart, *entity.TEnd
		}
		index.Tiles = append(index.Tiles, tile)
	}
	return draw(sources.SpecFrom(session.Video), session.ID, selected), index, nil
}

// Encode writes a rendered sheet as JPEG.
func Encode(writer io.Writer, picture image.Image) error {
	return jpeg.Encode(writer, picture, &jpeg.Options{Quality: 80})
}

// window picks the entities to show, clamped to the sheet's size.
func window(images []store.Image, from, count int) []store.Image {
	if from < 0 {
		from = 0
	}
	if from >= len(images) {
		return nil
	}
	if count <= 0 {
		count = DefaultTiles
	}
	if count > MaxTiles {
		count = MaxTiles
	}
	return images[from:min(from+count, len(images))]
}

// draw tiles each entity's poster into a grid. A missing poster leaves its cell dark
// rather than shifting everything after it, so cell positions stay meaningful.
func draw(spec *sources.VideoSpec, sid string, images []store.Image) image.Image {
	rows := (len(images) + Columns - 1) / Columns
	columns := min(len(images), Columns)
	sheet := image.NewRGBA(image.Rect(0, 0, columns*tileWidth, rows*tileHeight))

	for position, entity := range images {
		poster := posterFor(spec, sid, entity)
		if poster == nil {
			continue
		}
		x := (position % Columns) * tileWidth
		y := (position / Columns) * tileHeight
		drawScaled(sheet, image.Rect(x, y, x+tileWidth, y+tileHeight), poster)
	}
	return sheet
}

func posterFor(spec *sources.VideoSpec, sid string, entity store.Image) image.Image {
	path := entity.Ref
	if entity.TStart != nil && entity.TEnd != nil {
		cached, ok := sources.EnsurePoster(spec, sid, entity.Ref, *entity.TStart, *entity.TEnd)
		if !ok {
			return nil
		}
		path = cached
	}
	return decodeFile(path)
}

// drawScaled copies src into cell, sampling nearest-neighbour. Posters are already
// small and a contact sheet is looked at rather than zoomed into, so a resampling
// filter — and the dependency it would cost — buys nothing here.
func drawScaled(dst *image.RGBA, cell image.Rectangle, src image.Image) {
	bounds := src.Bounds()
	if bounds.Dx() == 0 || bounds.Dy() == 0 {
		return
	}
	for y := cell.Min.Y; y < cell.Max.Y; y++ {
		sourceY := bounds.Min.Y + (y-cell.Min.Y)*bounds.Dy()/cell.Dy()
		for x := cell.Min.X; x < cell.Max.X; x++ {
			sourceX := bounds.Min.X + (x-cell.Min.X)*bounds.Dx()/cell.Dx()
			dst.Set(x, y, src.At(sourceX, sourceY))
		}
	}
}

func decodeFile(path string) image.Image {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	decoded, _, err := image.Decode(file)
	if err != nil {
		return nil
	}
	return decoded
}
