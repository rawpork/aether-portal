# Architecture

Aether Portal is a single Cloudflare Worker ([src/index.js](src/index.js)) backed by one D1 database. It has no build step and no framework; the 3D UI is an inline HTML template served by the same Worker.

## Components

| Piece | Where | Notes |
| --- | --- | --- |
| Worker entry | `src/index.js` → `fetch()` | Path/method router, five endpoints |
| Database | D1 `aether_context_db`, binding `DB` | Configured in [wrangler.jsonc](wrangler.jsonc) (worker name `lingering-water-de49`) |
| Link metadata | [src/metadata.js](src/metadata.js) | YouTube oEmbed, otherwise OpenGraph / `<title>` from the first 256 KB of HTML; 4 s timeout |
| AI | Gemini 3.8 Flash, falling back to 3.7 Flash then 3.5 Flash-Lite on 503/429 (`generateContent`, `GEMINI_MODELS`) | Title/category cleanup and the daily miner; `thinkingLevel: "low"`, 2048 (cleanup) / 16384 (miner) max output tokens |
| UI | Inline HTML in `fetch()` | [3d-force-graph](https://github.com/vasturiano/3d-force-graph) 1.80.0 loaded from unpkg |
| Tests | [test/](test/) | `@cloudflare/vitest-plugin`, run with `npm test` |

## Endpoints

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `POST /` | `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` (fails closed) | Telegram webhook: saves a text message as a node, replies with confirmation |
| `GET /api/graph` | none | Returns `{ nodes, links }` for the whole graph |
| `POST /api/recluster?cursor=N` | `Authorization: Bearer <ADMIN_TOKEN>` | Re-classifies one batch (10 rows) with Gemini; client pages via `nextCursor` until `done` |
| `POST /api/backfill-metadata?cursor=N` | `Authorization: Bearer <ADMIN_TOKEN>` | Fetches title/description for up to 10 links with no `description`; same paging as recluster |
| `GET` anything else | none | Serves the 3D graph UI |
| cron `0 0 * * *` | n/a | `scheduled()` runs the connection miner (see Data flow) |

## Data model

Two tables, defined in [migrations/](migrations/). `saved_nodes`, defined in [migrations/](migrations/) (`0001_init.sql` plus later `ALTER TABLE` migrations). The columns the code relies on are:

| Column | Notes |
| --- | --- |
| `rowid` | Implicit SQLite rowid; used as the recluster cursor |
| `id` | `node_<uuid>` |
| `url` | The raw message text or URL |
| `title` | Fetched page/video title for links, else first 30 chars; may be rewritten by Gemini |
| `description` | Preview text for the node card: `og:description`, or "YouTube video by <author>"; NULL for notes |
| `category` | One of `VALID_CATEGORIES`: note, link, article, dev_task, monetization, ai_tool, marketing, route_plan, general, video |
| `updated_at` | Set when recluster rewrites a node |
| `ai_processed_at` | Set once Gemini has classified the node (recluster or the daily miner); both only pick up rows where it is NULL |
| `created_at` | D1 `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS` UTC); normalized to ISO in `/api/graph` |

`node_edges` (`0004_node_edges.sql`) holds relationship edges mined by Gemini: `source_id < target_id`, `relation` short phrase.

`buildGraphLinks()` computes the remaining links on every `/api/graph` request, then `mergeMinedEdges()` adds the stored edges as type **ai** (replacing a computed link for the same pair):
- **semantic** links from shared keywords (title + URL, stop words removed), capped at 5 per node;
- **category** links chaining consecutive nodes of the same category, so clusters hold together with O(n) edges.

## Data flow

1. **Capture** — Telegram sends a message to `POST /`.
2. **Classify (cheap, local)** — URL → `link` (or `video` via `VIDEO_URL_PATTERN`); text > 100 chars → `article`; else `note`.
   URLs also get their title/description fetched (`fetchLinkMetadata`, no AI); on failure the 30-char title is kept.
3. **Contextualize (conditional AI)** — only if the text is a placeholder like "look into this", the link saved in the previous 60 s is merged in and sent to Gemini once.
4. **Persist** — insert into `saved_nodes`, reply to the chat.
5. **Enrich (manual, batched AI)** — the UI's "Recluster Graph with AI" button walks `/api/recluster` in batches; each eligible node costs at most 1 context lookup + 1 Gemini call + 1 update.
6. **Mine (daily cron, batched AI)** — `mineConnections()` sends up to 40 unanalyzed nodes plus the 60 most recently analyzed ones to Gemini in one prompt; it re-tags categories (not videos), inserts `node_edges`, and marks the batch processed. On Gemini failure nothing is marked, so it retries the next day.
7. **View** — the UI fetches `/api/graph`, filters client-side (type, time, search), colors by a fixed category palette or rainbow hue, and shows a category legend (tap to highlight). A custom `cluster` force pulls each category toward its own anchor so categories form islands.

## Secrets / environment

Set with `wrangler secret put <NAME>`:

| Name | Used by |
| --- | --- |
| `TELEGRAM_TOKEN` | Sending replies via Bot API |
| `TELEGRAM_WEBHOOK_SECRET` | Authenticating the webhook (must match `secret_token` passed to `setWebhook`) |
| `GEMINI_API_KEY` | Gemini calls; if absent, ingestion still works and recluster returns 500 |
| `ADMIN_TOKEN` | Authorizing `/api/recluster`; the UI stores it in `localStorage` |

## Design constraints

- **Fail-safe AI** — every Gemini call returns `null` on error and the caller keeps the local classification.
- **Bounded work per request** — recluster batch size keeps each request within Workers subrequest and D1 limits.
- **Validate before write** — Gemini output is JSON-parsed, title trimmed to 200 chars, category passed through `normalizeCategory()`.
- **Template-literal UI** — the client script lives inside a JS template literal; avoid backslashes and `${ }` in it.
