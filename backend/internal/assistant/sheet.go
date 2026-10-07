package assistant

import (
	"bytes"
	"encoding/base64"
	"image"

	"atlas/backend/internal/sheet"
)

// encodeSheet renders a contact sheet for the vision model: JPEG, base64, inline.
func encodeSheet(picture image.Image) (string, error) {
	var encoded bytes.Buffer
	if err := sheet.Encode(&encoded, picture); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(encoded.Bytes()), nil
}
