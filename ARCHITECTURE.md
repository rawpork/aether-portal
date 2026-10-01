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
| `PRO_UPGRADE_URL` | Optional. An https link shown as "Upgrade to Pro" in Mission Control's Deploy & Execute prompt; without it the prompt says to ask the workspace admin |
| `ENGINE_JWT_SECRET` | Optional. Minting engine tokens for Mission Control (`/api/engine/token`); must equal the Aether_Engine's `SUPABASE_JWT_SECRET`. Use `.dev.vars` for local dev |

## Design constraints

- **Fail-safe AI** — every Gemini call returns `null` on error and the caller keeps the local classification.
- **Bounded work per request** — recluster batch size keeps each request within Workers subrequest and D1 limits.
- **Validate before write** — Gemini output is JSON-parsed, title trimmed to 200 chars, category passed through `normalizeCategory()`.
- **Template-literal UI** — the client script lives inside a JS template literal; avoid backslashes and `${ }` in it.

## Aether_Engine IPC client (Phase 3)
- `src/services/engineApi.ts` - typed client for the local Aether_Engine server (default `http://localhost:3333`; override with localStorage `aether.engine.baseUrl` or `createEngineApi({ baseUrl })`). It is browser code: the deployed Worker cannot reach the operator's localhost.
- Helpers: `getEngineHealth`, `tripBreaker`, `resetBreaker`, `getAgentState`, `sendMasterBrainChat`, `executeSubAgentTask`, `getTaskStatus`, `listTasks`, `listArtifacts`, `compileBlueprint`, `openVoiceStream` (shared default client), or `createEngineApi({ baseUrl, getToken, fetch, timeoutMs })` for a custom instance.
- Auth: every `/api/*` call sends `Authorization: Bearer <jwt>` from `getToken` or localStorage `aether.engine.jwt` (`setStoredEngineToken`). With no token the header is omitted, which only works against an engine started with `REQUIRE_AUTH=false`. The engine expects an HS256 JWT signed with its `SUPABASE_JWT_SECRET`; on Mission Control the Worker mints one for the portal session (see below).
- Errors: non-2xx responses throw `EngineApiError` (`status`, `body`, `isHalted` for 423, `isUnauthorized`, `isUnreachable` for status 0 = offline/CORS/timeout). `executeSubAgentTask` resolves a 423 as a `HALTED` outcome carrying `interrupted_step_index` and partial results.
- Timeouts: 5s health, 15s default, 310s chat, none for task runs (pass an `AbortSignal`).
- Build: `npm run build:client` (esbuild) bundles it to `public/js/engine-api.bundle.js` (ESM, generated, git-ignored). `wrangler.jsonc` `build.command` runs it before every `wrangler deploy`/`dev`, and `npm test` runs it first (`pretest`). `npm run typecheck` checks `src/services` and `test/services`. Tests: `test/services/engineApi.spec.ts` (vitest project `services`, mocked fetch).
- State events (`src/services/engineEvents.ts`, re-exported by the client): `onEngineState(listener)` / `engineEvents` publish `{ agentId, state, reason, source }` whenever a client reads state, trips, resets, gets a 423 from any route, or a voice stream is halted, so UI updates without waiting for a poll.
- Voice: `api.openVoiceStream({ sessionId, agentId?, format?, sampleRate? }, { onFrame, onClose })` (`src/services/voiceStream.ts`) opens `ws(s)://<engine>/api/voice/stream` with subprotocols `["aether-voice", "bearer.<jwt>"]`. Returns `{ ready, isOpen, sendAudio, endUtterance, sendText, cancel, close }`; `ready` resolves with the engine's `ready` frame (`stt`/`tts` flags) or rejects with `VoiceStreamError` (`halted` true for close 4423). Typed server frames: `ready`, `transcript`, `response`, `audio`, `error`.

## Mission Control (`/mission-control`)
All Aether_Engine interaction lives on this one page; the main portal header only links to it (🛰 Mission Control tab, `#mission-control-tab`) and carries no engine controls or key inputs.
- Route: `GET /mission-control` (src/index.js) serves `renderMissionControlPage` (`src/mission-control-page.js`, markup and styles only), passing the signed-in user's `users.tier` and `PRO_UPGRADE_URL` (https only) as `<meta name="aether-tier">` / `<meta name="aether-upgrade-url">`. Signed-out visitors are redirected to `/?next=/mission-control`. The page loads one module, `public/js/engine/mission-control.js`, which resolves the engine token first and then mounts the components below.
- Layout: header with Portal / Mission Control tabs and the breaker in the top-right corner; the main column has workspace tabs (Task Loop Monitor | Blueprints; `#blueprints` opens the second, arrow keys switch) with the engine connection panel at its foot; the Elaron dock is in the right column. Below 900px it is one column with the dock underneath.
- Engine auth (`public/js/engine/connection.js`), no pasted key needed:
  1. `GET /api/engine/token` (signed-in portal session) mints a 1-hour HS256 JWT `{ sub: "portal:<user id>", role: "authenticated", iss: "aether-portal" }` signed with the Worker secret `ENGINE_JWT_SECRET` (`src/engine-token.js`). It must equal the engine's `SUPABASE_JWT_SECRET`. Local dev: put it in `.dev.vars`; production: `wrangler secret put ENGINE_JWT_SECRET`. The page stores it as `aether.engine.jwt` and re-mints 5 minutes before expiry. Without the secret the endpoint returns 404.
  2. Otherwise a still-valid stored token is used; an expired one is dropped.
  3. Otherwise no header is sent, which works against an engine started with `REQUIRE_AUTH=false` (local bypass).
  The collapsed "Engine connection" panel shows which applies and offers a paste-a-token fallback only when the portal can't mint tokens. A 401 turns the breaker badge to TOKEN NEEDED; clicking it re-runs the bootstrap and opens the panel.
- Emergency breaker (`public/js/engine/breaker-bar.js`, `mountBreakerBar(container, { api, agentId, onAuthNeeded })`): `master-brain` badge polled every 5s (30s while offline, paused while hidden) plus instant updates from client state events. ACTIVE green, HALTED pulsing red (static under reduced motion), ENGINE OFFLINE, TOKEN NEEDED, ENGINE ERROR. TRIP BREAKER opens a confirmation alertdialog (Cancel focused) and calls `tripBreaker('master-brain', 'Operator manual trip from Portal UI')`; it is disabled only while already HALTED. RESET AGENT shows while HALTED; a 409 re-reads state. Phones: badge collapses to its dot unless HALTED; the button reads TRIP.
- Agent task loop monitor (`public/js/engine/task-monitor.js`): engine `GET /api/tasks` every 2s while any task is RUNNING, every 5s otherwise, and at once on a trip/reset/halt event. Totals (Active, Completed, Halted, Failed, Tokens used), then one row per task run (newest first): status chip, task and agent, progress bar (`role=progressbar`), "n/m steps", where it stands (running step, halted before step n with the reason, failed at step n with the error), tokens and timing. Selecting a row loads `GET /api/agents/:agentId/tasks/:taskId` into a step timeline (done, running, halted, failed, queued count), refreshed while it runs. Projects: the six newest compiled blueprints from `GET /api/artifacts` with their status, refreshed every 30s. Task runs are scoped to the token's subject, so the monitor shows runs started with the same identity.
- Elaron dock (`public/js/engine/brain-dock.js`, `mountBrainDock(container, options)`): always open in its panel. One engine session per browser (`aether.engine.sessionId`; "New" starts another). Typed turns go to `POST /api/master-brain/chat`, voice turns to `ws /api/voice/stream` with the same `session_id`, so the engine keeps one conversation. The mic first checks `getAgentState` (a browser WebSocket can't say why a handshake failed), then opens the stream, which closes on `pagehide`. Engine STT (`ready.stt`) gets webm-opus from MediaRecorder; otherwise browser SpeechRecognition (Chrome/Edge send audio to their speech service) sends the transcript as a `text` frame. Voice replies play engine TTS audio or browser speechSynthesis (🔊 toggle, `aether.brain.speakReplies`); typed replies are not spoken. The Elaron orb (`.elaron[data-mode]`) shows idle, connecting, listening, thinking, speaking, halted, offline (no glow, static under reduced motion). A 423, `AGENT_HALTED` frame or close 4423 locks the dock and broadcasts HALTED; a reset seen by any client unlocks it.
- Tests: `test/mission-control.spec.js` (Worker: routes, token minting, clean main header), `test/engine/*.spec.js` (happy-dom: breaker, connection, task monitor, Elaron dock, and the full page mounted from the real template), `test/services/*.spec.ts` (client and voice stream).
- Browser note: the production page is HTTPS and the engine is `http://localhost:3333`. Chrome and Firefox allow that as a local network request (Chrome may ask for local network access permission); Safari blocks it.

### Blueprints tab (Step 3.4)
- Ingestion (`public/js/engine/blueprints.js`, `mountBlueprintWorkspace(container, { api, tier, upgradeUrl, onUpgrade, onStarted, onExecuted })`): a JSON editor that takes a pasted spec, an uploaded `.json` file or a dropped one (256 KB max), with Insert example, Validate and Compile blueprint.
- Validation (`public/js/engine/blueprint-spec.js`) mirrors the engine contract `blueprint_schema.json#/definitions/compile_request` and reports `{ path, message }` like the engine: errors block compiling, warnings (unknown keys, non-http URLs, no project name) don't. JSON syntax errors are located by its own scanner (`findJsonErrorIndex`), so line and column are right in every browser. A bare list of links or plain URL strings are normalized (and noted); a compiled blueprint pasted by mistake is pointed out. The engine still validates every compile; its 400 `validation_errors` are shown the same way.
- Compile calls `compileBlueprint()` (`POST /api/blueprint/compile`) and opens the result.
- Artifact dashboard: `GET /api/artifacts` (newest first, with phase and source counts) on the left; the selected blueprint from `GET /api/artifacts/:blueprintId` on the right: facts (sources, phases, scaffold files, Miserly budget, database / hosting), the route matrix (phase, agent role, MCP tools, model route and budget cap, from `routeMatrix()`), generated artifacts (project scaffold), sources (http(s) URLs as `rel="noopener noreferrer"` links, anything else as text), unresolved connectors, raw JSON and Download JSON. Projects in the Task Loop Monitor open here.
- Tier gating: every tier can draft, validate, compile and preview. "Deploy & Execute Blueprint" is Pro (`users.tier = 'pro'`): for other tiers it carries a PRO badge and opens the upgrade prompt (with `PRO_UPGRADE_URL` as the Upgrade link when set). For Pro it asks for confirmation, then runs `blueprintToTaskSteps()` (one `prompt` step per phase, with the phase and blueprint as context) via `executeSubAgentTask('master-brain', 'deploy-<blueprint_id>', steps)`, so the breaker guards every phase and the monitor shows it live. The gate is in the portal UI; the engine itself has no tier concept. To make an account Pro: `npx wrangler d1 execute aether_context_db --remote --command "UPDATE users SET tier = 'pro' WHERE username = '<name>'"`.
- Tests: `test/engine/blueprint-spec.spec.js` (parsing, contract validation, error locator, route matrix, step mapping) and `test/engine/blueprints.spec.js` (ingestion, compile payload, engine 400s, artifact rendering, Free and Pro gating).
