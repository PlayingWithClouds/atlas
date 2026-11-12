# Atlas data schema

Atlas is a labeling frontend. It stores media items and the labels people give them, and
shows the labeling screen. It does not train models, cut videos or rank work.

Everything else is an **adapter**: any program that talks to atlas's HTTP API. Adapters
push media, items and suggestions in, and read annotations out. One adapter can do all of
it (e.g. a trainer), or each job can be its own script (a Veil importer, a scene cutter,
a model).

```
 adapters ──push assets, items, suggestions──►  atlas (store + UI)  ──webhook / feed──► adapters
                                                     ▲
                                                 labeler
```

Decisions behind this design:

- **Labels are per item**, and can optionally be narrowed to time ranges inside the item.
- **Adapters call atlas**, not the other way round. Atlas never needs to reach an adapter
  to work.
- **Labels go out two ways:** a webhook on every change, plus a feed of changes since a
  cursor that adapters use to catch up.
- **The taxonomy is part of the atlas project.** It is edited in atlas, and adapters
  fetch it.

## Taxonomy

What can be labeled in a project.

```ts
interface Taxonomy {
  version: number;            // bumped by atlas on every change
  groups: Group[];
}

interface Group {
  id: string;                 // "position"; stable, never reused
  label: string;              // shown in the UI
  kind: "single" | "multi";   // single: at most one label per item
  primary?: boolean;          // shown by default; other groups sit behind "more"
  when?: { group: string; label: string };   // only asked while that label is on (whole item or a range)
  labels: Label[];
}

interface Label {
  id: string;                 // "doggy"; stable, unique within its group
  name: string;               // shown in the UI
  description?: string;
  image?: string;             // example picture (URL)
  hotkey?: string;            // one key, unique within the group
  deprecated?: boolean;       // kept for old annotations, no longer offered
}
```

Rules:

- **Stable ids.** Group and label ids are never renamed or reused. A removed label
  becomes `deprecated` and stays in the taxonomy.
- **Conditions are one level deep.** A `when` points at a group that has no `when` itself.

## Media

Adapters push assets (whole media files) and items (the units people label).

```ts
interface Asset {
  id: string;                 // chosen by the adapter, e.g. "veil:video:3f2a…"
  kind: "video" | "image";
  url: string;                // fetched by the browser: http(s) file with Range support, or HLS (.m3u8)
  poster?: string;            // still image URL
  duration?: number;          // seconds, videos
  frameRate?: number;         // fps, videos; exact single-frame steps (measured while playing otherwise)
  thumbnails?: string;        // WebVTT thumbnail track for seek previews (cue text = image URL, may be
                              // a sprite tile "sprite.jpg#xywh=x,y,w,h"); grabbed from the video otherwise
  width?: number;
  height?: number;
  title?: string;
  meta?: Record<string, unknown>;   // adapter-owned, shown read-only
}

interface Item {
  id: string;                 // chosen by the adapter, e.g. "veil:video:3f2a…#t=120,185"
  assetId: string;
  span?: { start: number; end: number };   // seconds into the asset; whole asset if absent
  poster?: string;            // falls back to the asset's poster
  meta?: Record<string, unknown>;
}
```

Rules:

- **Ids are the adapter's.** Pushing the same id again updates the record, so adapters can
  re-run safely.
- **Spans stay inside the asset.** `0 ≤ start < end ≤ duration` when the duration is known.
- **The browser loads `url` directly.** The server behind it must allow atlas's origin
  (CORS).
- **Re-cutting doesn't touch labels.** An adapter may delete or replace items. Deleting an
  item that has an annotation keeps the annotation (status `orphaned` in the feed), so labels
  are never lost silently.

## Annotations

What a person decided about one item. There is one current annotation per item.

```ts
interface Annotation {
  itemId: string;
  status: "labeled" | "skipped";
  values: Record<string, string[]>;   // group id → label ids
  ranges?: Range[];                   // labels that hold for only part of the item
  reviewed: string[];                 // group ids the person looked at
  span?: { start: number; end: number };   // set when the person trimmed the item
  taxonomyVersion: number;
  updatedAt: string;                  // ISO 8601
}

interface Range {
  group: string;
  label: string;
  start: number;              // seconds, relative to the item's start
  end: number;
}
```

How to read an annotation:

- **Reviewed and empty means none.** A group in `reviewed` with no values means "none of
  these labels".
- **Not reviewed means unknown.** A group not in `reviewed` says nothing about the item, and
  trainers must not treat it as a negative.
- **Ranges narrow a label.** `values` holds labels that apply to the whole item. A label
  that applies only to part of it goes into `ranges` instead, and its group counts as
  reviewed.
- **Trimming is recorded, not applied.** `span` is the person's correction of the item's
  span. Atlas keeps the item as pushed; adapters decide whether to re-cut.

Atlas enforces these on save:

- every group and label id exists in the taxonomy;
- a single group has at most one label in `values`, and its ranges don't overlap;
- a group whose `when` isn't met has no values, no ranges, and is not in `reviewed`;
- ranges lie inside the item: `0 ≤ start < end ≤ item length`;
- a `skipped` annotation has empty `values`, `ranges` and `reviewed`.

## Suggestions

What an adapter thinks about an item. Atlas shows suggestions and orders work by them, but
never saves them as labels.

```ts
interface Suggestion {
  itemId: string;
  source: string;                                   // "probe-3"; latest push per (item, source) wins
  values?: Record<string, Record<string, number>>;  // group → label → probability 0..1
  ranges?: (Range & { score: number })[];
  priority?: number;                                // higher = show sooner
}
```

- **Prefill.** The labeling screen prefills from one chosen source per project. Suggestions
  are drawn as proposals the person accepts with one key, never as silent defaults.
- **Queue order.** Pending items are ordered by the highest `priority` across sources, then
  by push order. Items without a priority come last.
- **Live suggestions.** A project may set `liveSuggestions` to an adapter URL. When the
  person presses S on a video, the labeling screen asks
  `GET <url>?item=<item id>&at=<item seconds>` and expects
  `{ ranges: (Range & { score })[] }`: the labels on at that moment, each running from `at`
  to where the adapter predicts it ends. The URL must allow the browser (CORS). Without it,
  or when it does not answer, S uses the pushed suggestions' ranges.
- **Live scene.** While a scene is open, the labeling screen also POSTs to the same URL, on
  open and after every edit: `{ item, annotation: { values, ranges, reviewed } }`, holding only
  what the person labeled (never auto-added labels; `reviewed` only lists groups with a label).
  It expects a `Suggestion` for the whole scene (`values`, `ranges`), drawn instead of the pushed
  ones. Labels at or above the `autoAcceptThreshold` setting (default 0.9) are added to the draft
  on their own; ones the person removes are not added again.

## HTTP API

All bodies are JSON. Types are in `packages/contracts/src/schema.ts`, rules in
`packages/contracts/src/validate.ts`.

- **Batches.** Batch endpoints take up to 1000 records and answer
  `{ ok: number, errors: { id, message }[] }`. An error on one record does not stop the rest
  of the batch.
- **Ids in paths.** Item ids go into paths URL-encoded (`encodeURIComponent`).
- **Errors.** Invalid single writes answer `422 { errors: string[] }`.
- **Auth.** Requests from this machine are trusted. Other machines must send
  `Authorization: Bearer <token>` once `tokens` are configured in `atlas.json`.

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/api/projects` | | `ProjectSummary[]` |
| POST | `/api/projects` | `ProjectInput` | `Project` |
| GET | `/api/projects/:project` | | `Project` (with `taxonomy`) |
| PATCH | `/api/projects/:project` | `{ name?, prefillSource?, liveSuggestions? }` | `Project` |
| PUT | `/api/projects/:project/taxonomy` | `Taxonomy` | `Taxonomy` (new version) |
| POST | `/api/projects/:project/assets` | `Asset[]` | batch result |
| POST | `/api/projects/:project/items` | `Item[]` | batch result |
| POST | `/api/projects/:project/items/delete` | `{ ids: string[] }` | batch result |
| GET | `/api/projects/:project/items` | `?status=&cursor=&limit=` + filter | `{ items, cursor }` |
| GET | `/api/projects/:project/items/:item` | | `ItemDetail` |
| GET | `/api/projects/:project/queue/next` | `?after=<item id>` + filter | `QueueNext` |
| GET | `/api/projects/:project/model` | | `ModelOverview` |
| PUT | `/api/projects/:project/items/:item/annotation` | `AnnotationInput` | `Annotation` |
| DELETE | `/api/projects/:project/items/:item/annotation` | | `204` |
| POST | `/api/projects/:project/suggestions` | `Suggestion[]` | batch result |
| GET | `/api/projects/:project/annotations` | `?since=<cursor>&limit=` | `{ changes: Change[], cursor }` |
| GET | `/api/settings/:scope` | | settings object, `{}` when unset |
| PUT | `/api/settings/:scope` | JSON object | the same object |

**Filters** (`ItemFilterQuery`) narrow `GET /items` and `GET /queue/next`; the queue page keeps
them in its URL, and labeling carries them on, so "next" stays inside the filter.

- `q`: part of the asset title or the item id.
- `label=group.label`: labeled items with it (whole item or a range); other items whose model
  suggestion gives it at least 0.5 or has a range with it.
- `unsure=group` or `group.label`: the model's probability is between 0.25 and 0.75 (for a
  group: for any of its labels).
- `sort=order|queue|match`: push order (default, cursor = sequence), queue order, or by the
  model's probability (`label`: highest first; `unsure`: closest to 0.5 first). The last two page
  by offset. Each item carries the probability as `match`.

"The model" is the project's `prefillSource` when set, otherwise the source that most recently
pushed values. `GET /model` counts, per label, labeled items and pending items the model finds
likely (≥ 0.5) or is unsure about.

```ts
interface Project {
  id: string;
  name: string;
  taxonomy: Taxonomy;
  prefillSource?: string;     // suggestion source used to prefill the labeling screen
  liveSuggestions?: string;   // adapter URL asked for ranges at one moment (S), see below
}

interface Change {
  cursor: string;             // increases with every change; pass the last one as `since`
  itemId: string;
  kind: "saved" | "deleted" | "orphaned";
  annotation?: Annotation;    // absent for "deleted"
}
```

## Webhooks

Configured in `atlas.json`. Leaving out `project` sends events of every project:

```json
{ "webhooks": [{ "url": "http://127.0.0.1:9000/atlas", "project": "scenes", "events": ["annotation", "taxonomy"] }] }
```

Atlas posts one event per change, in order. It retries with backoff and gives up after a
few minutes, so an adapter that was down catches up from the feed instead:

```ts
type Event =
  | { type: "annotation"; projectId: string; change: Change }
  | { type: "taxonomy"; projectId: string; taxonomy: Taxonomy };
```

## Live updates

The web app receives `LiveEvent`s over the WebSocket at `/api/live`. They tell it that items,
suggestions, an annotation, a taxonomy or the project list changed, so the screens refresh
without reloading. A `settings` event (`{ scope }`) says shared settings changed.

Settings are kept in the workspace's `atlas.json` under `settings.<scope>` and shared by every
browser on the workspace; the web app uses scope `web` (key bindings, leader, seek and zoom
steps). PUT replaces the whole scope.

## Typical adapters

- **Veil importer**:
  1. Reads a Veil collection.
  2. Pushes one asset per video, using Veil's stream URL.
  3. Cuts scenes and pushes them as items.
- **Trainer**:
  1. Reads the feed (or listens to the webhook).
  2. Retrains.
  3. Pushes suggestions with `priority` = uncertainty.
- **Exporter**: reads items and the annotation feed, and writes a dataset.
