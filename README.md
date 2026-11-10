# atlas

A labeling frontend. Atlas stores media items and the labels people give them, and serves the
labeling screen. It does not train models, cut videos or rank work: external **adapters** push
assets, items and suggestions in over HTTP and read the annotations out (by webhook or by polling
a change feed).

```
 adapters ──push assets, items, suggestions──►  atlas (store + UI)  ──webhook / feed──► adapters
                                                     ▲
                                                 labeler
```

The data model, the HTTP API, webhooks and the rules atlas enforces are specified in
[docs/schema.md](docs/schema.md). Types are in `packages/contracts/src/schema.ts`, the pure
rules (taxonomy, annotation validation) in `packages/contracts/src/validate.ts`.

## Layout

- **`packages/contracts`**: shared types and rules (`schema.ts`, `validate.ts`), the workspace
  config (`index.ts`), the host services a server plugin may inject (`server.ts`) and the UI
  registries a web plugin builds against (`web.ts`).
- **`packages/server`**: the Bun host, built on
  [`@neoworks/extension-system`](../../neoworks/extension-system).
  - `src/store/`: the labeling store in SQLite (projects and taxonomy, assets, items,
    annotations, suggestions, change feed), its HTTP routes, live events and webhook delivery.
  - `src/services/`: workspace config, database, HTTP (with token auth), live WebSocket
    (`/api/live`), notifications and the plugin loader.
- **`packages/web`**: Vite + Svelte 5 labeling app. It renders what web plugins register.
- **`plugins/`**: extensions loaded from the workspace's `atlas.json`. Today these are the web-side
  media players `media-image` and `media-video`.

## Run

Requires [Bun](https://bun.sh).

```sh
bun install
bun run init        # creates .atlas-workspace/ (or $ATLAS_WORKSPACE) with a starter atlas.json
bun run dev         # process-compose: server on :8123 + web on :5173
```

`task --list` shows the same commands individually (`task server`, `task web`). The server alone:

```sh
bun packages/server/src/main.ts <workspaceDir> [--port 8123]
```

Then push data, for example:

```sh
curl -X POST localhost:8123/api/projects -H 'content-type: application/json' \
  -d '{"id":"scenes","name":"Scenes","taxonomy":{"groups":[{"id":"position","label":"Position","kind":"single","labels":[{"id":"doggy","name":"Doggy"}]}]}}'
curl -X POST localhost:8123/api/projects/scenes/assets -H 'content-type: application/json' \
  -d '[{"id":"v1","kind":"video","url":"http://localhost:9000/v1.mp4","duration":60}]'
curl -X POST localhost:8123/api/projects/scenes/items -H 'content-type: application/json' \
  -d '[{"id":"v1#t=0,10","assetId":"v1","span":{"start":0,"end":10}}]'
```

## Workspace

```
<workspace>/
  atlas.json   title, plugins, webhooks, tokens, plugin settings
  store.db     SQLite: everything atlas stores
  cache/       per-plugin caches
```

`atlas.json`:

```json
{
  "title": "atlas",
  "plugins": [{ "package": "@atlas/plugin-media-video", "path": "/abs/path/to/plugins/media-video" }],
  "webhooks": [{ "url": "http://127.0.0.1:9000/atlas", "project": "scenes", "events": ["annotation", "taxonomy"] }],
  "tokens": [{ "name": "trainer", "token": "change-me" }],
  "settings": {}
}
```

- Requests from this machine are trusted. Once `tokens` is non-empty, other machines must send
  `Authorization: Bearer <token>` (the live WebSocket also accepts `?token=`).
- Webhook deliveries are retried with backoff for about five minutes; adapters that were down
  catch up from `GET /api/projects/:project/annotations?since=<cursor>`.
- Old files still start: unknown fields such as `workflows` are ignored, and plugin entries whose
  package no longer exists are skipped with a warning.

## Development

```sh
bun run test     # contracts, server, plugin and web tests
bun run check    # tsc for contracts, server and plugins; svelte-check for web + plugin web code
```
