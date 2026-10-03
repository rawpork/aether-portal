# Aether Portal — Pipeline & Memory Update (MU)

## Phase 3: Aether_Engine Integration (COMPLETED 2026-10-01)
Wires the portal to the local Aether_Engine IPC server (`http://localhost:3333`, Phase 2 complete 2026-10-01).
- [x] Step 3.1: Engine IPC Gateway Client Service (`http://localhost:3333`) (COMPLETED 2026-10-01) - typed client `src/services/engineApi.ts` for all Phase 2 engine routes; bearer JWT auto-attached from localStorage `aether.engine.jwt` (no header = engine `REQUIRE_AUTH=false` bypass); 423 task halts resolve as `HALTED` outcomes, other failures throw `EngineApiError`. Verified: `tsc --noEmit` clean, 8 unit tests, 18/18 live checks against the engine on port 3333 (JWT + bypass)
- [x] Step 3.2: Emergency Circuit Breaker Panic Button & Agent State Status Bar (COMPLETED 2026-10-01) - `#engine-bar` in the top bar (`public/js/engine/breaker-bar.js`): `master-brain` state badge polled every 5s (green ACTIVE, pulsing red HALTED, plus offline/token-needed states; instant HALTED on any 423 via client state events), TRIP BREAKER with confirmation dialog, RESET AGENT when halted, engine token modal. `npm run build:client` bundles the client to `public/js/engine-api.bundle.js` (also run by wrangler before deploy/dev). Verified: build + typecheck clean, 14 UI tests (simulated 200/423/401/409/offline), 279/279 suite, 9/9 live checks against the engine on 3333
- [x] Step 3.3: Master Brain Interactive Chat & Elaron Voice Dock (`ws://localhost:3333/api/voice/stream`) (COMPLETED 2026-10-01) - "Master Brain" dock from the top bar (`public/js/engine/brain-dock.js`): typed chat over `/api/master-brain/chat` and voice over the WebSocket (`src/services/voiceStream.ts`, bearer subprotocol auth) in one shared engine session; Elaron avatar orb shows idle/listening/thinking/speaking/halted/offline. Mic streams webm-opus when the engine has STT, else uses browser speech recognition (engine STT is Step 2.4a); replies play engine TTS or browser speech. HALTED (423, AGENT_HALTED, close 4423) locks the dock and updates the breaker badge; reset unlocks it. Verified: typecheck + build clean, 20 new tests (299/299 suite), 9/9 live checks against the engine on 3333 incl. a mid-session breaker trip
- [x] Step 3.3b: Mission Control workspace (`/mission-control`) (COMPLETED 2026-10-01) - engine controls moved out of the global header into a dedicated page: breaker (state badge + TRIP BREAKER + RESET AGENT) top-right, Agent Task Loop Monitor (live progress via new engine `GET /api/tasks`, step timelines, completed vs active totals, project status), Elaron chat & voice dock embedded. Engine auth is automatic: the Worker mints a 1h engine JWT for the portal session (`ENGINE_JWT_SECRET`, `.dev.vars` locally), falling back to a stored token or the engine's `REQUIRE_AUTH=false` bypass. Verified: build + typecheck clean, 320/320 tests, 17/17 live checks (wrangler dev + engine)
- [x] Step 3.4b: Engine Connection Wizard (COMPLETED 2026-10-02) - Connection tab in Mission Control: Local Engine (Private & Local Compute) vs Dedicated Cloud Engine (Always-On SaaS) with copyable step-by-step setup; on the computer running a local engine it detects the Cloudflare quick tunnel (new engine `GET /api/public-url`) and shows a QR pairing code (`/mission-control?engine=<url>`, confirm-before-pair); cloud URL input with Test and Save & connect; bare hosts sanitized to https. Verified: 384/384 tests, live tunnel detection, QR decoded by an independent reader
- [x] Step 3.4a: Mission Control on phones (COMPLETED 2026-10-01) - header clears the iPhone status bar (safe-area insets), hidden controls stay hidden (RESET AGENT only while HALTED), Elaron gets its own tab on narrow screens, Engine URL setting for reaching the engine from another device (https / tunnel; mixed-content guard), token panel names the real failure (HTTP status), outcome blueprints from the portal open in Mission Control (`?outcome=<id>`, `aether.blueprint/1` converted to an engine spec)
- [x] Step 3.4: Blueprint Ingestion & Artifact Compilation Dashboard (COMPLETED 2026-10-01) - Blueprints tab in Mission Control: paste / upload / drop spec JSON, local validation mirroring `compile_request` (line/column JSON errors), compile via `compileBlueprint()`; artifact dashboard from `GET /api/artifacts` + `/api/artifacts/:id` (new engine route) with route matrix, generated scaffold, sources and raw JSON. Tier gating from `users.tier`: every tier drafts, validates, compiles and previews; "Deploy & Execute Blueprint" carries a PRO badge and upgrade prompt for Free, and for Pro runs each phase as a task-loop step on master-brain (breaker-guarded, live in the monitor). Verified: build + typecheck clean, 345/345 tests, 16/16 live checks (wrangler dev + engine)


## Phase 4: Agent Workflow Studio (UI specs, 2026-10-03)
Turns Mission Control from watching agents into building and steering them. The specs are in [specs/ui/](specs/ui/README.md); nothing in this phase is built yet. Endpoints marked "proposed" in the specs still need to be added to Aether_Engine, the portal Worker or Miserly.io. Mission Control gains a **Studio** rail item, and **Settings** becomes **Connections**.

- [ ] Step 4.1: 2D Visual Node Canvas ([spec 01](specs/ui/01-node-canvas.md))
  - Workflow Canvas in Studio. The node kinds are trigger, agent, team, MCP server, action, browser and human checkpoint.
  - Drag-and-drop cables from port to port (long-press 350ms on touch, keyboard "Connect to..."). Incompatible drops are refused with a reason.
  - The port pair decides the cable kind: **Green = MCP Read** (`--flow-mcp`, solid), **Blue = A2A Debate** (`--flow-a2a`, double rail, bidirectional), **Orange = Action** (`--flow-action`, arrow plus bolt).
  - Live runs animate a glowing pulse along each cable per engine flow event (proposed `ws /api/runs/:runId/events`): a 6px dot with a halo of 14px radius and 45% opacity at most, and at most 3 pulses per cable.
  - Under reduced motion nothing travels; the cable thickens briefly instead. Pulses freeze on HALTED.
  - DESIGN.md gains "Cable pulse glow" as its third and last glow exception.
- [ ] Step 4.2: Case Clearance Spacing ([spec 02](specs/ui/02-case-clearance.md))
  - New tokens `--case-clear: 24px` (nominal 1/4 inch at CSS 96px/in) and `--case-clear-min: 20px`.
  - Corner-anchored controls move a diagonal 24px in on both axes. Each axis uses `max(24px, env(safe-area-inset-*))`.
  - The edge thumb wheel's pivot moves from the corner to (24px, 24px), so its hub and rings clear phone-case lips.
  - Edge bars keep their interactive content at least 20px from the edge. No horizontal drag may start in the left 20px (iOS Back swipe). 44pt hit areas are unchanged.
- [ ] Step 4.3: Dual-Agent Team Cards ([spec 03](specs/ui/03-team-cards.md))
  - Workforce cards for a Lead + Partner pair joined by an A2A Debate cable, with team-wide Pause and breaker.
  - Mode selector: **HITL** (default: every Action waits for Approve / Edit / Deny on the card or in Telegram, and never auto-approves), **Auto** (acts within the budget cap and breaker), **Planning** (Action cables locked; the team produces a plan to approve).
  - Mid-run switching rules, and the engine enforces the mode server-side. Debate rounds, partner stance and tie-break are settings.
- [ ] Step 4.4: Pre-Run Workflow Budget Inspector ([spec 04](specs/ui/04-budget-inspector.md))
  - A sheet that opens from Run.
  - Per-node estimates come from Miserly.io's free `/api/interrogate` dry run (through a proposed portal proxy, `POST /api/budget/estimate`) and the `/api/manifest` prices, so the ceiling equals what Miserly's SafetyLedger reserves.
  - Interactive donut breakdown by node, tier or cable kind (at most 6 slices, tap to highlight the node on the canvas), with a table and CSV fallback.
  - Monthly run projection slider (1 to 1,000 runs, log steps) against the plan or trial cap. Savings % uses Miserly's definition (vs. the premium baseline).
  - Guardrails disable Run or Auto when a cap would be exceeded. Each run stores its estimate for an estimated-vs-actual comparison.
- [ ] Step 4.5: Embedded Live Browser Streaming ([spec 05](specs/ui/05-live-browser.md))
  - The engine runs Playwright Chromium in an isolated context per session and streams CDP `Page.startScreencast` JPEG frames over the proposed `ws /api/browser/:sessionId/stream`, acking each frame for backpressure.
  - The portal draws only the newest frame to a 16:9 canvas, with a read-only URL bar, status, fps and latency.
  - HITL "Take control" forwards input through `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`.
  - Domain allowlist per workflow; nothing recorded unless the run opts in; password and card fields are blurred before frames leave the engine.
- [ ] Step 4.6: Pre-Populated Recipe Canvases & Custom Recipe Vault ([spec 06](specs/ui/06-recipes.md))
  - The Studio opens on a recipe gallery with miniature canvas previews.
  - Starter recipes (Research to Brief, SOP Builder, Content Pipeline, Ad Variants, Website Scaffold, Vendor Quote Run, Telegram Triage) match the Blueprint Cluster templates the synthesis engine uses.
  - A per-user Vault in D1 (proposed migration 0016) with version history.
  - Export and import as `aether.recipe/1` JSON or a link. Export refuses anything that looks like a credential, and imports always open in HITL.
- [ ] Step 4.7: User Connections Hub & Advanced Developer Mode ([spec 07](specs/ui/07-connections-hub.md))
  - **Telegram:** connect the user's own bot token (verified with `getMe`, webhook with a secret token, chat bound by `/start`) for messages, triggers and HITL approvals.
  - **BYOK:** Anthropic / Gemini / OpenAI-compatible keys with default, per-role and per-node model overrides. BYOK traffic bypasses Miserly until Miserly gains a passthrough-key feature.
  - **MCP connectors:** Streamable HTTP or SSE, with bearer or OAuth 2.1. Tool Read/Action defaults come from `readOnlyHint` and decide the cable colour.
  - Secrets are AES-GCM encrypted in D1 (proposed migration 0017, `CONNECTIONS_KEY` secret) and never returned to the browser.
  - Engine URL and pairing, engine tokens, the Miserly client key, Free Sandbox Mode and diagnostics move behind an **Advanced Developer Mode** toggle. It is a visibility preference, not access control, and a "Fix" row surfaces any problem hiding there.

### Phase 4 open decisions
- [ ] Cable colours: green and orange were chosen distinct from Mission Control's violet accent and from the portal's teal and Outcome Gold. Confirm on a real device in both themes.
- [ ] BYOK through Miserly: add a passthrough-key mode to Miserly.io (keeps budgets, telemetry and `x-miserly-savings`), or accept direct-to-provider BYOK.
- [ ] Engine contracts (runs WebSocket, teams, approvals, browser sessions): agree them with Aether_Engine before UI work starts on Steps 4.1, 4.3 and 4.5.


## ?? Active Architecture & System State
- **Production URL:** https://lingering-water-de49.klo377.workers.dev
- **Environment:** Cloudflare Workers + D1 (aether_context_db) + static assets (public/) + Gemini 3.x API, optional Anthropic API (Claude Sonnet share tier)
- **Active Model Fallback Chain:** gemini-3.8-flash -> gemini-3.7-flash -> gemini-3.5-flash-lite
- **Background Automation:** Daily CRON (0 0 * * * at midnight UTC) running src/miner.js
- **Live Version:** 3021e7f0-8cbe-49b0-a64f-a3900450598d (commit 5a86f9c, deployed 2026-09-25)

## Shipped
- [x] **Focus Card Carousel View** - Fifth view in the view switch: filtered nodes as a centered card deck with a scaled/faded depth stack, touch and mouse swiping (left = next, right = previous), arrow keys and prev/next buttons. Selecting a node in the 2D/3D map can open the deck focused on that node. Commit 15a9833, live on Cloudflare Workers as version 15b98cf5.
- [x] **Flat Node-Based Editor Mode (2D Canvas Toggle)** - Toggle button to flatten the Z-axis, align nodes into organized 2D rows/grids (like N8N / ComfyUI / node editors), and lock camera orbit to 2D pan/zoom. Shipped as the 2D Canvas toggle: nodes pinned to z = 0, categories on a 4-column grid, rotation off and left-drag pans.
- [x] **1-Hop Neighborhood Focus Walker** - Clicking a node dims everything except its direct 1st-degree connections. Shipped: selecting a node keeps it and its direct neighbours at full opacity and dims the rest.
- [x] **Orphan Node Toggle** - Hide unlinked singletons to clean up floating noise. Shipped as "Hide Unlinked" in the Filters popover.
- [x] **Camera Centroid Fly-To** - Tapping a category in the legend smoothly glides the camera directly to that cluster's central anchor. Shipped: tapping a category in the legend highlights it and flies the camera to its cluster centre (the same fly-to as tapping a cluster label on the canvas); tapping it again clears the highlight without moving the camera.
- [x] **YouTube Transcript Pipeline (`/api/transcript`)** - POST fetches a YouTube node's captions into raw_transcript and saves a Gemini synopsis (Gemini watches the video when there are no captions); GET returns the stored values. Migration 0011, endpoint commit 69aa68e. The node card Transcript section (synopsis, Get Transcript / Refresh, Read Transcript) shipped in commit 899f1e3, live as version b9fc0089.
- [x] **Web Content Fetcher (`/api/web-fetch`)** - POST fetches a link's page with a desktop User-Agent, strips scripts/styles/nav/header/footer and returns readable Markdown-style text, saved to saved_nodes.content when a nodeId is given. Link cards get Fetch / Read Web Content; the daily miner uses the first 200 characters. Migration 0012, commit 5a86f9c, live as version 3021e7f0.
- [x] **PWA Share Sheet (`/share`)** - manifest share_target opens a share sheet with link preview, Gemini Flash / Gemini Pro / Claude Sonnet tiers, Summarize / Event / Branch / Action Task presets and / commands. Ingest saves to the inbox instantly; the preset runs in the background and its result is saved on the node. Commit 5a86f9c, live as version 3021e7f0. Claude tier needs ANTHROPIC_API_KEY; Android only.
- [x] **Google 1-Tap Sign-in** - One Tap plus OAuth 2.0 PKCE (/api/auth/google, /api/auth/callback), minimal scopes, new free-tier accounts for allowlisted emails only, Apple-style signed-out screen. Commit 5a86f9c, deployed in version 3021e7f0 but inactive until the Google client secrets are set.

## ?? Active Feature Pipeline (Next Steps)

### Immediate Next Steps (Setup & Verification):
- [ ] **Configure Google sign-in** - Create the Google Cloud OAuth web client (origin + /api/auth/callback redirect URI), set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_ALLOWED_EMAILS, and link the owner account email.
- [ ] **Enable the Claude Sonnet tier** - Set the ANTHROPIC_API_KEY secret.
- [ ] **Live test the share sheet and presets** - Install the PWA on Android, share a link with each preset and tier, and confirm the results appear on the node card.
