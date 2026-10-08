# atlas

A general, plugin-based data-labeling tool with **active learning**. Open a source, label a
few items, and a classifier head trained on frozen embeddings starts suggesting labels and
surfaces the most *uncertain* item next, so each label teaches the model the most.

The core knows nothing about any particular kind of data. Sources, media kinds, annotation
types, encoders, workflow nodes, exporters, the assistant and every labeling screen are
plugins built on [`@neoworks/extension-system`](../../neoworks/extension-system): each one
registers what it contributes with an inverse, so plugins load, unload and reconfigure
without a restart.

## Architecture

```
packages/web (Svelte 5)  ──HTTP/WS──►  packages/server (Bun)  ──stdio JSON-RPC──►  Python workers
        │                                     │
  web plugin entries                  server plugin entries, SQLite (<workspace>/atlas.db)
```

- **`packages/contracts`** — shared types plus the service contracts (server) and UI
  registries (web) every plugin builds against.
- **`packages/server`** — the host: workspace config, SQLite, HTTP router, live WebSocket,
  job queue, notifications, plugin loader, and the domain services (projects, sessions and
  items, labeling, workflows, tools). It also starts Python workers for plugins.
- **`packages/web`** — Vite + Svelte 5 SPA. The shell renders whatever plugins register:
  pages, nav, labelers, media cells, source pickers, settings panes, insight views.
- **`packages/python`** — `atlas_ml`, the generic ML worker: vector pools per
  (encoder, project), pluggable heads and uncertainty strategies, insights. No encoder code.
- **`plugins/`** — everything concrete:

| Plugin | Provides |
|---|---|
| `source-fs` | directory and video-file sources |
| `media-image`, `media-video` | serving, thumbnails, grid cells; video clips, scenes, segment/trim/extract-frames nodes |
| `primitive-tag`, `primitive-region` | tag and rect/polygon/keypoint annotations with their labelers |
| `encoder-siglip`, `encoder-joytag`, `encoder-dinov2` | embedding models (Python) |
| `core-nodes`, `model-nodes` | generic workflow nodes, triggers and assistant tools |
| `tagger-joytag` | optional JoyTag tag node; class mapping comes from config |
| `exporter-folder` | dataset export/import for any project |
| `assistant`, `assistant-ollama`, `assistant-claude`, `mcp` | assistant page, backends, MCP endpoint |

The veil media server ships its own source plugin in the veil repo
(`packages/atlas-source`).

## Run

Requires Bun, Python 3.10+ (a venv is created per workspace on first use; `uv` is used when
available) and `ffmpeg` for video.

```sh
bun install
bun run init                     # creates .atlas-workspace/ (or $ATLAS_WORKSPACE)
# list plugins in .atlas-workspace/atlas.json, e.g.
#   { "package": "@atlas/plugin-source-fs", "path": "/abs/path/to/plugins/source-fs" }
bun run dev                      # process-compose: server on :8123 + web on :5173
```

`task --list` shows the same commands individually (`task server`, `task web`). Every
project must pick its model provider explicitly; there is no default encoder or project.

```
<workspace>/
  atlas.json   title, enabled plugins with their config, workflows, plugin settings
  atlas.db     SQLite
  cache/       per-plugin caches, Python venv, vector pools (<encoder>/<project>/)
  exports/     dataset exports
```

## Development

```sh
bun run test     # server, plugin and web tests
bun run check    # tsc for every package, svelte-check for web + plugin web code
```

Python tests: `python -m pytest packages/python/tests` with an interpreter that has numpy,
torch, pillow and requests. Set `ATLAS_PYTHON` to reuse an existing interpreter instead of
the workspace venv.

## Migrating from the old Go/SurrealDB version

Start SurrealDB on the old data, then:

```sh
bun packages/server/src/main.ts migrate --from-surreal ws://127.0.0.1:8020/rpc \
  --old-config .atlas-workspace/legacy/atlas.config.json \
  --old-cache ~/.cache/atlas --dry-run <targetWorkspace>
```

Drop `--dry-run` to write. Old data is only read. The old config and class icons were moved
out of the repo into `.atlas-workspace/legacy/` (also in git history before the switch-over).
