// Package registry connects to configured plugin services and routes by capability.
//
// Plugins are independent long-lived JSON-RPC/HTTP services listed in the startup config.
// At boot the registry calls capabilities() on each and indexes capability → [plugin].
// A plugin that is unreachable is marked unhealthy and its capabilities disappear from the
// index (the UI disables the matching actions) until the next probe succeeds.
package registry

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"atlas/backend/internal/config"
	"atlas/backend/internal/rpc"
)

// Plugin is a connected plugin service and its advertised capabilities.
type Plugin struct {
	ID           string           `json:"id"`
	URL          string           `json:"url"`
	Config       map[string]any   `json:"-"`
	Capabilities []map[string]any `json:"capabilities"`
	Healthy      bool             `json:"healthy"`
	Err          string           `json:"error"`
}

// Has reports whether the plugin advertises the named capability.
func (p *Plugin) Has(capability string) bool {
	for _, cap := range p.Capabilities {
		if name, _ := cap["name"].(string); name == capability {
			return true
		}
	}
	return false
}

func (p *Plugin) toDict() map[string]any {
	var errValue any
	if p.Err != "" {
		errValue = p.Err
	}
	return map[string]any{
		"id":           p.ID,
		"url":          p.URL,
		"healthy":      p.Healthy,
		"capabilities": p.Capabilities,
		"error":        errValue,
	}
}

// Registry is the plugin table.
type Registry struct {
	mu      sync.Mutex
	plugins map[string]*Plugin
}

// Default is the process-wide registry.
var Default = &Registry{plugins: map[string]*Plugin{}}

// Load rebuilds the plugin table from config, then probes each once.
func (r *Registry) Load(plugins []config.PluginConfig) {
	r.mu.Lock()
	r.plugins = map[string]*Plugin{}
	for _, entry := range plugins {
		if entry.ID == "" || entry.URL == "" {
			continue
		}
		r.plugins[entry.ID] = &Plugin{ID: entry.ID, URL: entry.URL, Config: entry.Config}
	}
	list := make([]*Plugin, 0, len(r.plugins))
	for _, plugin := range r.plugins {
		list = append(list, plugin)
	}
	r.mu.Unlock()

	for _, plugin := range list {
		r.probe(plugin)
	}
}

type capabilitiesResult struct {
	Plugin       string           `json:"plugin"`
	Capabilities []map[string]any `json:"capabilities"`
}

func (r *Registry) probe(plugin *Plugin) {
	raw, err := rpc.Call(context.Background(), plugin.URL, "capabilities", nil, 5*time.Second)
	if err != nil {
		plugin.Capabilities = []map[string]any{} // never marshal null; the UI maps over this
		plugin.Healthy = false
		plugin.Err = err.Error()
		return
	}
	var result capabilitiesResult
	if jsonErr := json.Unmarshal(raw, &result); jsonErr == nil && result.Capabilities != nil {
		plugin.Capabilities = result.Capabilities
	} else {
		// A plugin may reply with a bare capabilities array.
		var bare []map[string]any
		_ = json.Unmarshal(raw, &bare)
		plugin.Capabilities = bare
	}
	plugin.Healthy = true
	plugin.Err = ""
}

// Get returns a plugin by id.
func (r *Registry) Get(id string) *Plugin {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.plugins[id]
}

// Providers returns healthy plugins advertising a capability.
func (r *Registry) Providers(capability string) []*Plugin {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*Plugin
	for _, plugin := range r.plugins {
		if plugin.Healthy && plugin.Has(capability) {
			out = append(out, plugin)
		}
	}
	return out
}

// Provider returns the first healthy provider of a capability (for singletons).
func (r *Registry) Provider(capability string) *Plugin {
	providers := r.Providers(capability)
	if len(providers) == 0 {
		return nil
	}
	return providers[0]
}

// SourceFor returns the source plugin advertising a given source kind.
func (r *Registry) SourceFor(kind string) *Plugin {
	for _, plugin := range r.Providers("source") {
		for _, cap := range plugin.Capabilities {
			if name, _ := cap["name"].(string); name != "source" {
				continue
			}
			if kinds, ok := cap["kinds"].([]any); ok {
				for _, k := range kinds {
					if str, _ := k.(string); str == kind {
						return plugin
					}
				}
			}
		}
	}
	return nil
}

// Call dispatches a method to a plugin by id, marking it unhealthy on transport error.
func (r *Registry) Call(ctx context.Context, id, method string, params map[string]any, timeout time.Duration) (json.RawMessage, error) {
	plugin := r.Get(id)
	if plugin == nil {
		return nil, &rpc.Error{Message: "unknown plugin: " + id}
	}
	raw, err := rpc.Call(ctx, plugin.URL, method, params, timeout)
	if err != nil {
		if _, ok := err.(*rpc.Error); ok {
			return nil, err // plugin-level error; the plugin is up
		}
		plugin.Healthy = false
		plugin.Err = err.Error()
		return nil, err
	}
	return raw, nil
}

// Status returns a serializable snapshot of every plugin.
func (r *Registry) Status() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]map[string]any, 0, len(r.plugins))
	for _, plugin := range r.plugins {
		out = append(out, plugin.toDict())
	}
	return out
}
