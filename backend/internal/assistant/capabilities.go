package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"atlas/backend/internal/config"
)

// What a model can do is a property of the build, not of the family: the same Gemma 4
// packaged by two people can differ on whether thinking is exposed, because ollama reads
// that off the GGUF's template metadata. So it is asked, not assumed.
var capabilityCache = struct {
	sync.Mutex
	byModel map[string][]string
}{byModel: map[string][]string{}}

const capabilityTimeout = 20 * time.Second

// Thinks reports whether a model returns its reasoning separately. Sending `think` to a
// model without the capability makes ollama reject the whole request, so this gates it.
func Thinks(ctx context.Context, settings config.Assistant, model string) bool {
	for _, capability := range capabilitiesOf(ctx, settings, model) {
		if capability == "thinking" {
			return true
		}
	}
	return false
}

// capabilitiesOf asks ollama what a model supports, once per model per process. A failed
// probe caches nothing, so a model pulled while atlas is running is picked up on the
// next turn rather than being written off until a restart.
func capabilitiesOf(ctx context.Context, settings config.Assistant, model string) []string {
	capabilityCache.Lock()
	cached, known := capabilityCache.byModel[model]
	capabilityCache.Unlock()
	if known {
		return cached
	}

	capabilities, err := probeCapabilities(ctx, settings, model)
	if err != nil {
		return nil
	}
	capabilityCache.Lock()
	capabilityCache.byModel[model] = capabilities
	capabilityCache.Unlock()
	return capabilities
}

func probeCapabilities(ctx context.Context, settings config.Assistant, model string) ([]string, error) {
	body, err := json.Marshal(map[string]string{"model": model})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, capabilityTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, settings.URL+"/api/show", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	var decoded struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	return decoded.Capabilities, nil
}
