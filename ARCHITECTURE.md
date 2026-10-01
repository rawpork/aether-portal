# Architecture

Aether Portal is a single Cloudflare Worker ([src/index.js](src/index.js)) backed by one D1 database. It has no build step and no framework; the 3D UI is an inline HTML template served by the same Worker.

## Components

| Piece | Where | Notes |
| --- | --- | --- |
| Worker entry | `src/index.js` → `fetch()` | Path/method router, five endpoints |
| Database | D1 `aether_context_db`, binding `DB` | Configured in [wrangler.jsonc](wrangler.jsonc) (worker name `lingering-water-de49`) |
| Link metadata | [src/metadata.js](src/metadata.js) | YouTube oEmbed, otherwise OpenGraph / `<title>` from the first 256 KB of HTML; 4 s timeout |
| AI | Gemini 3.8 Flash, falling back to 3.7 Flash then 3.5 Flash-Lite on 503/429 (`generateContent`, `GEMINI_MODELS`) | Title/category cleanup and the daily miner; `thinkingLevel: "low"`, 2048 (cleanup) / 16384 (miner) max output tokens |
| UI | Inline HTML in `fetch()` | [3d-force-graph](https://github.com/vasturiano/3d-force-graph) 1.80.0 and three.js 0.180.0, pinned and self-hosted in `public/vendor/` |
| Spatial view modules | [public/js/spatial/](public/js/spatial/) | Browser ES modules served as static assets (design tokens, grouping engine); plan in [SPATIAL_ARCHITECTURE.md](SPATIAL_ARCHITECTURE.md) |
| Tests | [test/](test/) | Two vitest projects run by `npm test`: `worker` (`@cloudflare/vitest-plugin`) and `spatial` (plain Node, `test/spatial/`) |

## Endpoints

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `POST /` | `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` (fails closed) | Telegram webhook: saves a text message as a node, replies with confirmation |
| `GET /api/graph` | none | Returns `{ nodes, links }` for the whole graph |
| `POST /api/recluster?cursor=N` | `Authorization: Bearer <ADMIN_TOKEN>` | Re-classifies one batch (10 rows) with Gemini; client pages via `nextCursor` until `done` |
| `POST /api/backfill-metadata?cursor=N` | `Authorization: Bearer <ADMIN_TOKEN>` | Fetches title/description for up to 10 links with no `description`; same paging as recluster |
| `POST /api/remine?cursor=N` | `Authorization: Bearer <ADMIN_TOKEN>` | One-off backfill: mines tags and concept groups for 20 nodes per call (categories untouched) and saves `#hashtags` already in their notes |
| `GET`/`POST /api/groups`, `PATCH`/`DELETE /api/groups/:id` | session | List, create, rename and delete the user's groups; `PATCH /api/node/:id` with `group_id` or `new_group` moves a node |
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

`node_groups`, `saved_nodes.group_id` / `group_source` and `node_tags` (`0013_groups_tags.sql`) hold the hybrid groups and tags described in [SPATIAL_ARCHITECTURE.md](SPATIAL_ARCHITECTURE.md): the miner suggests `ai` groups and weighted `miner` tags, users create `user` groups and `#hashtag` tags, and a user's group choice is never overridden by the miner. `/api/graph` returns each node's group and tags plus the user's `groups`, and adds **concept** links between nodes sharing a strong miner tag.

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
6. **Mine (daily cron, batched AI)** — `mineConnections()` sends up to 40 unanalyzed nodes plus the 60 most recently analyzed ones to Gemini in one prompt; it re-tags categories (not videos), inserts `node_edges`, replaces each node's miner tags, assigns concept groups (reusing the user's group names where they fit, never over a user choice), and marks the batch processed. On Gemini failure nothing is marked, so it retries the next day.
   *Planned (Phase 7, [SPATIAL_ARCHITECTURE.md](SPATIAL_ARCHITECTURE.md) section 8):* a synthesis pass after mining scores cross-group patterns locally and, for the best ones, makes one more Gemini call that proposes up to 2 **Outcome Nodes** per user per day: cited, step-by-step action plans (Input A + Input B → Outcome C) the user can accept, dismiss or send to Finish Line.
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

## Aether_Engine IPC client (Phase 3)
- `src/services/engineApi.ts` - typed client for the local Aether_Engine server (default `http://localhost:3333`; override with localStorage `aether.engine.baseUrl` or `createEngineApi({ baseUrl })`). It is browser code: the deployed Worker cannot reach the operator's localhost.
- Helpers: `getEngineHealth`, `tripBreaker`, `resetBreaker`, `getAgentState`, `sendMasterBrainChat`, `executeSubAgentTask`, `getTaskStatus`, `compileBlueprint` (shared default client), or `createEngineApi({ baseUrl, getToken, fetch, timeoutMs })` for a custom instance.
- Auth: every `/api/*` call sends `Authorization: Bearer <jwt>` from `getToken` or localStorage `aether.engine.jwt` (`setStoredEngineToken`). With no token the header is omitted, which only works against an engine started with `REQUIRE_AUTH=false`. The engine expects a Supabase HS256 JWT, not the portal's Google session.
- Errors: non-2xx responses throw `EngineApiError` (`status`, `body`, `isHalted` for 423, `isUnauthorized`, `isUnreachable` for status 0 = offline/CORS/timeout). `executeSubAgentTask` resolves a 423 as a `HALTED` outcome carrying `interrupted_step_index` and partial results.
- Timeouts: 5s health, 15s default, 310s chat, none for task runs (pass an `AbortSignal`).
- Build: `npm run build:client` (esbuild) bundles it to `public/js/engine-api.bundle.js` (ESM, generated, git-ignored). `wrangler.jsonc` `build.command` runs it before every `wrangler deploy`/`dev`, and `npm test` runs it first (`pretest`). `npm run typecheck` checks `src/services` and `test/services`. Tests: `test/services/engineApi.spec.ts` (vitest project `services`, mocked fetch).
- State events (`src/services/engineEvents.ts`, re-exported by the client): `onEngineState(listener)` / `engineEvents` publish `{ agentId, state, reason, source }` whenever a client reads state, trips, resets, gets a 423 from any route, or a voice stream is halted, so UI updates without waiting for a poll.
- Voice: `api.openVoiceStream({ sessionId, agentId?, format?, sampleRate? }, { onFrame, onClose })` (`src/services/voiceStream.ts`) opens `ws(s)://<engine>/api/voice/stream` with subprotocols `["aether-voice", "bearer.<jwt>"]`. Returns `{ ready, isOpen, sendAudio, endUtterance, sendText, cancel, close }`; `ready` resolves with the engine's `ready` frame (`stt`/`tts` flags) or rejects with `VoiceStreamError` (`halted` true for close 4423). Typed server frames: `ready`, `transcript`, `response`, `audio`, `error`.

## Engine breaker bar (Phase 3, Step 3.2)
- `#engine-bar` slot in `#topbar` (src/index.js), filled by `public/js/engine/breaker-bar.js` (module script, auto-mounts; `mountBreakerBar(container, { api, agentId, pollIntervalMs, getToken, setToken })` for tests).
- Badge for agent `master-brain`: polls `getAgentState` every 5s (30s while the engine is offline; paused while the tab is hidden, re-polled when it returns) and listens to client state events. States: CONNECTING, ACTIVE (green), HALTED (pulsing red fill, static under reduced motion), ENGINE OFFLINE, TOKEN NEEDED (401, click opens the token modal), ENGINE ERROR. Click retries.
- TRIP BREAKER (red) opens a confirmation alertdialog with Cancel focused; confirming calls `tripBreaker('master-brain', 'Operator manual trip from Portal UI')`. Failures stay in the dialog. Disabled only while the agent is already HALTED, never because a poll failed.
- RESET AGENT (teal) shows only while HALTED and calls `resetBreaker('master-brain')`; a 409 (already reset elsewhere) re-reads the state.
- Key button opens the engine token modal: shows the stored JWT (preview, subject, expiry), saves a pasted JWT or clears it via `setStoredEngineToken`, then re-polls.
- Phones (600px and below): badge collapses to its dot except when HALTED; the trip button reads TRIP.
- Tests: `test/engine/breaker-bar.spec.js` (vitest project `engine-ui`, happy-dom, real bundle, simulated engine responses).
- Browser note: the production page is HTTPS and the engine is `http://localhost:3333`. Chrome and Firefox allow that as a local network request (Chrome may ask for local network access permission); Safari blocks it, so use Chrome/Firefox or `wrangler dev` for the breaker bar.

## Master Brain dock & Elaron voice (Phase 3, Step 3.3)
- `#brain-dock-toggle` slot in `#topbar` (🧠 Master Brain), filled by `public/js/engine/brain-dock.js`, which appends the `#brain-dock` panel to `<body>`: right-hand panel on wide screens, 72vh bottom sheet at 600px and below. `mountBrainDock(slot, options)` takes injectable `api`, `storage`, `Recognition`, `synth`, `Utterance`, `MediaRecorder`, `getUserMedia` and `playAudio` for tests.
- One engine session per browser (`aether.engine.sessionId` in localStorage, "New" starts another). Typed turns go to `POST /api/master-brain/chat`, voice turns to the WebSocket with the same `session_id`, so the engine keeps one conversation for both. The transcript itself is not stored; it starts empty on reload.
- Voice input: the mic first calls `getAgentState` (a browser WebSocket can't report why a handshake failed), then opens the stream (kept open until the dock closes or the session changes). If the engine's `ready` frame has `stt: true`, MediaRecorder streams webm-opus chunks every 250ms and the second mic tap sends `end_utterance`. Otherwise the browser's SpeechRecognition transcribes (Chrome and Edge send the audio to their own speech service) and the text goes as a `text` frame. With neither, the mic explains that voice isn't available.
- Voice output (🔊 toggle, `aether.brain.speakReplies`): engine `audio` frames (webm-opus or pcm16) when `ready.tts`, else the browser's speechSynthesis. Typed replies are never spoken.
- Elaron avatar (`.elaron[data-mode]`): idle, connecting, listening, thinking, speaking, halted (red), offline (grey). Ring and core animate per mode; no glow; static under reduced motion.
- Breaker: a 423 from chat, an `AGENT_HALTED` frame or close 4423 puts the dock in halted mode (input and mic locked, system message) and broadcasts HALTED to the breaker badge. A reset seen through any client (the bar's reset or its 5s poll) unlocks it.
- Tests: `test/services/voiceStream.spec.ts` (fake WebSocket) and `test/engine/brain-dock.spec.js` (happy-dom, real bundle, simulated engine and voice socket).
