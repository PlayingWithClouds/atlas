package api

import (
	"net/http"
	"strconv"

	"atlas/backend/internal/sheet"
)

// handleSessionSheet renders a window of the session's posters into one JPEG grid.
func handleSessionSheet(w http.ResponseWriter, r *http.Request) {
	session, _, ok := requireSession(w, r)
	if !ok {
		return
	}
	picture, index, err := sheet.Render(r.Context(), session,
		intQuery(r, "from", 0), intQuery(r, "n", sheet.DefaultTiles))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(index.Tiles) == 0 {
		writeError(w, http.StatusNotFound, "no entities to show")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	_ = sheet.Encode(w, picture)
}

func intQuery(r *http.Request, key string, fallback int) int {
	value, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return fallback
	}
	return value
}
