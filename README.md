# atlas

A generic, plugin-based data-labeling platform with **active learning**. Point it at a
source (a directory of images, an veil gallery, or a video), label a few, and a classifier
head trained on frozen embeddings starts recommending labels — surfacing the most *uncertain*
image next so each label teaches the model the most.

The core is small and ML-free: a **Go** backend that orchestrates work, persists everything
in **SurrealDB**, and delegates all ML and data access to independent **plugins** over a
JSON-RPC bus.

## Architecture

```
web (SvelteKit)  ──HTTP/WS──►  backend (Go)  ──JSON-RPC──►  plugins
                                    │
                                SurrealDB   (projects, sessions, images, jobs, settings)
```

- **`web/`** — SvelteKit 5 frontend (Tailwind v4, design tokens in `src/lib/design/app.css`). Typed API layer
  (`src/lib/api/*`), keyboard-first labeling, live updates over a WebSocket.
- **`backend/`** — Go (stdlib `net/http`). Zero ML. Orchestrates the label loop, sessions,
  the background job queue, and the plugin registry; **all state lives in SurrealDB**
  (`internal/db`). A restart reloads straight from the DB; jobs left running by a crash are
  swept to `interrupted` on boot.
- **`sdk/`** — the plugin SDKs. A plugin is a JSON-RPC 2.0 HTTP service exposing `POST /rpc`
  plus a `capabilities()` handshake. `sdk/ts` (Bun), `sdk/python` (FastAPI), and `sdk/go`
  are wire-compatible peers.
- **`plugins/`**
  - `veil/` (TypeScript) — the veil media server as a `source` (galleries, scenes, random).
  - `fs/` (Go) — a local directory as a `source`.
  - `model/` (Python) — the ML brain: embedding backbone (JoyTag/DINOv2), a per-project
    training pool + classifier head, and `embed`/`predict`/`rank`/`duplicates`/`insights`/
    `pool_dump` methods. Vectors never leave this process.

Env vars: `ATLAS_WORKSPACE` (the project directory everything derives from — see Run),
`ATLAS_SURREAL_URL` (default `ws://127.0.0.1:8020/rpc`), `ATLAS_CONFIG` (overrides the
workspace's `atlas.json`), `ATLAS_DEVICE` (`cpu`/`cuda` for the model plugin), `VEIL_URL`
(default `:8080`), `MODEL_BACKBONE` (default `joytag`).

## How it works

```
JoyTag / DINOv2 (frozen)  ->  embedding per image (cached in the model plugin)
                                   |
you label (multi-label, number keys / search)
                                   |
a GPU linear head refits after every label (in the model plugin, off the request path)
                                   |
unlabeled images ranked by uncertainty  ->  most-informative shown next
                                   |
confident predictions pre-fill the tags  ->  you accept / correct
```

Labels, pool, and progress persist in SurrealDB + the model plugin's pool; reopening the same
source resumes.

## Run

Requires: Go 1.22+, Bun, Python 3.10+, SurrealDB, and `ffmpeg` (for video sources).

```sh
task setup                          # model-plugin venv + TS deps + web deps
go run ./backend init ~/atlas/nsfw  # create a workspace (--from atlas.config.json to migrate)
export ATLAS_WORKSPACE=~/atlas/nsfw
task dev                            # SurrealDB + Go backend + veil/fs/model plugins + web
```

A workspace is one project's home: its config, database, vector pools, datasets and the
code the assistant writes all live under that directory, so two projects never share
state. Every process reads `ATLAS_WORKSPACE`, so exporting it once is enough.

```
<workspace>/
  atlas.json    config: title, taxonomy, plugins, workflows
  db/           SurrealDB files
  cache/        model plugins' vector pools
  code/         the assistant's working directory
  dataset/      dataset export/import
  exports/      labeled data and vectors written out for the assistant to read
  agent/        assistant conversation state
```

With `ATLAS_WORKSPACE` unset, atlas runs where it always did: `./atlas.config.json`,
`.data/atlas.db` and `~/.cache/atlas`.

Or run the pieces individually — see `task --list` (`task surreal`, `task backend`,
`task plugin:veil|fs|model`, `task web`). The frontend is at http://localhost:5173.

First model-plugin run downloads the JoyTag weights (~366 MB) to `~/.cache/atlas/joytag`.
CUDA is used automatically if available.

## Labeling shortcuts

- **1–9** — toggle class · **Enter / Space** — save + next · **S** — skip · **C** — copy last
  selection

Green border / percentage = model suggestion, pre-filled once the head has warmed up
(needs ~4+ labeled images). **Model tag** predicts a whole collection into the review queue.

## Configuration

The config file — `<workspace>/atlas.json`, or `atlas.config.json` in legacy mode — holds
the app title, annotation primitives, the label taxonomy
(`labels.groups`), the plugin registry, and saved workflows. Projects each carry their own
schema; the default project seeds from this file. Plugins are hot-swappable — the UI disables
any action whose capability has no healthy provider.

### The assistant

The pane runs on one of two backends, set by `assistant.backend`:

```jsonc
"assistant": {
  "enabled": true,
  "backend": "claude",
  "claude": {
    "model": "opus",                 // omit for the CLI's default
    "mcp_url": "http://127.0.0.1:8123/api/mcp",
    "max_budget_usd": 2,             // per turn; omit for no ceiling
    "timeout_seconds": 900,
    "tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    "allowed_tools": ["mcp__atlas__*", "Read", "Glob", "Grep", "Write", "Edit", "Bash"]
  }
}
```

- **`ollama`** — a bounded tool loop inside atlas against a local model (`url`, `model`,
  `vision_model`, `max_tool_calls`). Everything stays on the machine.
- **`claude`** — hands the turn to the `claude` CLI, which is already an agent. It reads
  atlas over the MCP server at `mcp_url`, and writes and runs code in `<workspace>/code`,
  which is how it does anything the tools do not cover: a custom query, a metric, bounding
  boxes. It needs a workspace, and it runs with real shell access inside one — the limits
  are the working directory, the single `--add-dir`, and `allowed_tools`. Trim that list to
  narrow it; permissions are never skipped. The machine's own Claude Code settings, hooks
  and memory are excluded, so the assistant answers as atlas's, not as yours.
