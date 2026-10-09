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
Turns Mission Control from watching agents into building and steering them. The specs are in [specs/ui/](specs/ui/README.md); Steps 4.1a and 4.1b are built, the rest are specs. Endpoints marked "proposed" in the specs still need to be added to Aether_Engine, the portal Worker or Miserly.io. Mission Control gains a **Studio** rail item, and **Settings** becomes **Connections**.

- [ ] Step 4.1: 2D Visual Node Canvas ([spec 01](specs/ui/01-node-canvas.md))
  - [x] Step 4.1a: Studio canvas, read-only (COMPLETED 2026-10-03) - new **Studio** rail item (`#studio`, `public/js/engine/studio-canvas.js`) draws the engine's task trees (task -> steps) and MCP server nodes from Aether_Engine `GET /api/canvas/graph` (new), polled every 10s while visible. Bridge edges (step -> MCP server) carry an engine-computed 0-1 confidence; the **Abstract <-> Logic** slider (0-100%, saved per browser) hides bridges below the chosen minimum. Clicking or pressing Enter on a bridge opens the **Edge Inspector**: Elarion's step rationale and reply excerpt, confidence metrics (score, depth, per-signal weights) and bridge metadata. `--flow-mcp/a2a/action` tokens added for both themes. Verified: 418/418 tests (9 new), typecheck clean, real engine graph rendered in happy-dom (2 tasks, 8 steps, 6 servers, 8 bridges)
  - [x] Step 4.1b: Agent-Generated Workflow Console (COMPLETED 2026-10-03) - Studio opens on a **Workflow console** tab (`public/js/engine/workflow-console.js`, rules and layout in `workflow-model.js`); the 4.1a canvas moves to an **Engine activity** tab. **Studio Command Bar**: a goal generates a workflow on Aether_Engine (`POST /api/workflows`: trigger, agents, A2A hand-offs, MCP tool bindings, actions behind human approvals; model JSON validated by the engine, built-in planner in sandbox mode or when the reply is unusable) that auto-arranges on the canvas; with a workflow open, a prompt mutates it (`POST /api/workflows/:id/mutate`, e.g. "add an agent to review the code before deployment") and new nodes/cables are flagged. **Human override**: drag nodes by the header (8px grid, arrow keys too), drag from an output port to an input port or press Enter on a port for "Connect to...", Delete removes a selected cable or node, the inspector edits name/role/instructions; refused drops shake and say why (same port rules as the engine). Every edit is saved to the engine against its version (`POST /api/workflows/:id/graph`; a 409 reloads the newer version). **Runs**: Run starts the workflow through the task loop (breaker-guarded, in Run history); the console polls `GET /api/workflows/:id/events` every 500ms and sends a pulse per flow event along its cable (spec easing, 6px dot with a 14px halo, max 3 per cable plus a +N badge, landing badges), updates node status pills, thickens cables under reduced motion, freezes on HALTED with a banner. Approval checkpoints stop the run (nothing auto-approves) and actions are proposed, never executed. Not yet: `team` and `browser` nodes, zoom/pan (the canvas scrolls), the 350ms touch long-press, and the `ws /api/runs/:runId/events` stream (polling stands in; the engine's WebSocket upgrade only serves voice today). Verified: 442/442 tests (20 new) and 7 offline engine checks, typecheck clean, live against the engine in sandbox mode (generate, mutate, wire, saved move, run to the approval checkpoint with pulses)
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


## Phase 5: Autonomous Delivery & Operator Console (COMPLETED 2026-10-05)
Elarion turns a blueprint into finished deliverables, and Mission Control shows the work and asks for every decision.
- [x] Step 5.1: Elarion project runs (COMPLETED 2026-10-05) - Deploy & Execute hands the blueprint to the engine (`POST /api/projects/run`): Elarion analyzes the scope, inspects linked GitHub repos (read-only) and matching repo skills, plans a DAG of 3-10 steps (validated: unique ids, known dependencies, no cycles; falls back to the blueprint phases) and runs it on the task loop with the breaker before every step. Engine `1b2f081`, portal `7a3c918`
- [x] Step 5.2: Deliverables back to Mission Control and Space (COMPLETED 2026-10-05) - every final file is written as a ````file:<path> block, saved under `outputs/projects/<task>/`, listed (downloadable) in Outcomes & Deliverables with Elarion's plan, and carried in the Outcome card's report in Space. Portal `7a3c918`
- [x] Step 5.3: Sandboxed /s/ previews with approval (COMPLETED 2026-10-05) - "Deliver a live website" on the Ready to run? card (pre-ticked when the blueprint talks about a website) adds a self-contained, responsive `preview/index.html`; it is drafted at `/s/<slug>` (D1 `sites`, migration 0018) and goes public only on Approve & publish. Pages are served under a CSP sandbox without same-origin, so they cannot use the portal session. Portal `7a3c918`, `6f7f730`; engine `67c6e0d`
- [x] Step 5.4: Self-healing goal checks (COMPLETED 2026-10-05) - every run ends with a goal check that compares each goal with the files and rewrites, in full, anything missing, broken or short of a goal. Provider failures carry the real reason (HTTP status and message); a failed Gemini turn is retried once, then Claude stands in. Engine `67c6e0d`, `61685de`
- [x] Step 5.5: Dual-Agent Console (COMPLETED 2026-10-05) - Operator → Claude ⇄ Gemini: side-by-side feeds (stacked on phones) that chat per purpose (Claude plans, Gemini runs fast steps), show the model that answered and why another stood in, collect background steps per provider, and move code between them with Paste to Gemini / Paste to Claude. Portal `aa7f01d`, `40b7e07`; engine `38917ba`
- [x] Step 5.6: Numbered choice chips and decision popups (COMPLETED 2026-10-05) - numbered options in an agent's question become one-tap chips in the Elarion dock and both agent panes; the decision center opens numbered popups (1-9 keys, Esc for ones that can wait) when Elarion waits on a choice, and when a run finishes, fails or is halted; a "Do this next" banner on every view names the one next action. Portal `aa7f01d`, `071450f`, `16de512`
- [x] Step 5.7: Universal skill ingestion (COMPLETED 2026-10-05) - "+ Skill", `add repo <link>`, `add skill <link or text>` or `learn <...>`: Elarion reads a GitHub repo, any public page (redirects checked hop by hop, no local or private addresses) or pasted text and drafts a structured SKILL.md (When to use, Core instructions, API rules, Examples, Pitfalls, plus a runnable apply step) for Save / Edit first / Discard; saved to `Aether_Engine/skills/<name>/`, and matching skills feed later project runs. First skill saved: `claude-skills-format-and-awesome-list`. Engine `aa0d1b9`, portal `16de512`, `40b7e07`
- [x] Step 5.8: Finger on the pulse (COMPLETED 2026-10-05) - Live activity opens with what the running step was asked, how long it has been working and what the last step actually wrote; timeline entries expand to instructions or output; Studio → Engine activity nodes open a Node Inspector (instructions, full reply, model, tokens, timing, exact failure). Polls no longer scroll the page. Portal `071450f`, `8546ad9`
- [x] Step 5.9: Roadmap dashboard (COMPLETED 2026-10-05) - Mission Control → Roadmap reads this file's phases and goals, recent Claude Code sessions (metadata only, key-like strings masked) and the memory index through the engine. Portal `aa7f01d`, engine `38917ba`
- [x] Step 5.10: Engine stays up (COMPLETED 2026-10-05) - the "Aether Engine" scheduled task (at logon, no admin) runs `scripts/aether-up.ps1`, which keeps the engine, its quick tunnel and the portal's ENGINE_PUBLIC_URL secret current, outside any terminal session. Verified: paid Gemini key, 3 of 3 step calls answered by gemini-3.8-flash with no fallback

- [x] Step 5.11: Missing secret sauce and the finish-line guarantee (COMPLETED 2026-10-05) - project runs read up to 3 linked tutorial pages and detect what they leave out (hand-waving, unstated auth, database schema and hooks, environment setup and secrets, state wiring, error handling, deployment); a gap-fill step runs first and writes that glue, never inventing secrets (named in .env.example, read from the environment, clear error when missing). The finish-line step polishes for production, and its guard rewrites any file that still holds a TODO or placeholder (up to 2 passes). Test: `test/secret-sauce-gapfill.test.ts` runs an incomplete tutorial through the real task loop and executes the result. Engine `3060a2c`, portal `f690ae7`
- [x] Step 5.12: Deep route and real repo code (COMPLETED 2026-10-05) - gap fill, the finish line and build repairs run on Claude (a step can pick its own model route); linked repos are read beyond the README (package.json, wrangler config, .env.example, schema, entry file; optional GITHUB_TOKEN). Engine `bcca733`; the watchdog task also fires every 5 minutes so it cannot quietly stop (`52f2a0e`)

### Phase 5 next steps
- [ ] Named tunnel with a fixed address: move one GoDaddy domain's DNS to Cloudflare, create a named tunnel (engine.<domain>) and install cloudflared as a Windows service (needs an administrator prompt); the secret is then set once.
- [ ] First real website project end to end: blueprint → run → goal check → /s/ preview → Approve & publish.
- [ ] Provider keys only in Cloudflare (Miserly passthrough), so none live on the PC.

## Phase 6: Sandboxed Build, Staging & Launch (BUILT 2026-10-05, sandbox installed)
Deliverables are proven to build before anyone sees them, staged on a free URL, scored, and launched where the operator chooses.
- [x] Step 6.1: Sandboxed build and test pass (BUILT 2026-10-05) - a `build` step at the end of every project run sends the deliverables to a WSL Ubuntu sandbox (`scripts/sandbox-setup.ps1`: "sandbox" user without sudo, Windows drives not mounted, Windows interop off, no keys inside, WSL capped at 2 GB / 2 CPUs) where `sandbox/runner.js` runs `npm install`, `npm run build` and `npm test` (time-limited) in a throwaway folder. Failures go back to Elarion on the Claude route, which rewrites the files; up to 3 rounds. Command execution exists only here: the public task API's schema does not accept build steps, and guest agents cannot run them
- [x] Step 6.2: Automatic staging (BUILT 2026-10-05) - a passing build's output is deployed to Cloudflare Pages (`aether-<project>-<id>.pages.dev`, branch `staging`) with the operator's wrangler login; only files are uploaded, nothing generated runs on the PC. The staged root and up to 8 of its links are checked. `SANDBOX_STAGING=off` turns staging off
- [x] Step 6.3: Viability gate and launch choice (BUILT 2026-10-05) - a 0-100 score from the build, tests, leftover placeholders, settings still to set and whether the staged pages answer (viable at 70+ with a passing build). Viable runs open Mission Control's numbered popup "Where would you like to launch this live?": [1. Keep on Free Staging] [2. Attach Custom Domain on Cloudflare (Free)] [3. Deploy to Recommended Host] (Vercel, Netlify, Supabase; `AFFILIATE_<HOST>_URL` in the engine .env swaps in a referral link, and the popup says when a link is an affiliate link). Outcomes shows the build, score and staging link
- [x] Step 6.4: Tests (BUILT 2026-10-05) - engine `test/sandbox.test.ts` (build planning, the real runner: pass, failure, path escape, timeout kill; repair loop; Pages deploy; route checks; viability; task-loop wiring); portal launch-popup and build-badge tests

- [x] Step 6.5: Create / Templates tab (BUILT 2026-10-05) - Mission Control -> Create lists ready-made templates (SaaS cost auditor, landing page + waitlist, AI chat assistant, team dashboard, API + webhook worker, or start from scratch). Picking one asks a 4-question brief first (target domain, sign-in type, database, anything else); the answers compile into a blueprint (database in `interviewResponses.database`, the whole brief as an `aether:brief` source Elarion reads when planning) that opens under Projects with Deploy & Execute focused
- [x] Step 6.6: Inter-agent copy bar (BUILT 2026-10-05) - Operator -> Claude ⇄ Gemini gets [Manual Copy] / [Auto-Send] (Auto-Send passes each reply to the other agent, at most 6 hand-offs in a row), pre-send prefix and post-send suffix text areas (saved per browser), and Question Chips for decision gates: numbered options or a closing yes/no question become chips, and Auto-Send waits for the pick

### Phase 6 next steps
- [x] Install the sandbox (2026-10-05): Ubuntu (WSL 2), sandbox user, Node 22 and the runner are in place, and no Windows drive is mounted. The setup script's isolation check now tests for a mount (`mountpoint`), not the empty /mnt/c and /mnt/d mount-point folders, and still stops setup if a drive is reachable
- [x] First sandbox case study (2026-10-05): Miserly.io built in the sandbox (npm ci, typecheck, wrangler dry-run build, 9/9 tests) and staged at https://staging.aether-miserly-io.pages.dev. Viability 58/100 (below 70, so no launch popup): the placeholder check counts `REPLACE_ME` sample values in .dev.vars.example, a README "..." and a "Retrieving…" loading line, and four secrets are still to set
- [x] Staging fix (2026-10-05): wrangler 4.140+ turns `pages project create` next to a Workers config into a Worker deploy; the engine now creates with `--force` from an empty folder
- [ ] First full project run through the sandbox: blueprint, build, repair, staging on pages.dev, launch choice.
- [x] Viability scanner rules (2026-10-05): sample values in .env.example / .dev.vars.example, a "..." in Markdown and prose like "Retrieving your API key…" no longer count as placeholders. Miserly.io re-scored in the sandbox: 58 → 88 ("Ready to launch", 9/9 tests, staged `/` answers 200); the remaining points are its four secrets still to set
- [ ] Paste referral links as AFFILIATE_VERCEL_URL / AFFILIATE_NETLIFY_URL / AFFILIATE_SUPABASE_URL in the engine .env when the affiliate accounts exist.

## Phase 7: Memory Anchors, Design Audit & Model Policy (2026-10-07)
Numbered 7-9 here because Phases 1-6 above are already taken; they are the "Phase 1-3" of the 2026-10-07 plan.
- [x] Global model policy: `"model": "sonnet"` in `~/.claude/settings.json` for standard work; Opus only for heavy multi-step orchestration, via a single-session flag or an inline `/model` switch
- [x] `AGENT_CORE.md` (owner profile plus the 10-persona roster: Elarion, Forge, Ledger, Prism, Echo, Vanguard, Pixel, Director, Sculptor, Courier), `registry/connectors.json` (miserly, portal, huggingface, design_audit, engine) and `CLAUDE.md` (read AGENT_CORE.md on startup, check the registry first, zero-context-loss handoffs). Human names supplied so far: Prism = Elena Rostova, Echo = Siddharth Patel, Vanguard = Maya Lin, Director = Jordan Blake, Sculptor = Nate Rodriguez, Courier = Claire Moreau; the rest are TBD in `AGENT_CORE.md`, as is the owner profile beyond name and role
- [x] `design-audit` skill (moved 2026-10-07 to the central vault `proprietary/skills/TS_Skills/design-audit`; third-party skills such as `scroll-craft` are read-only under `proprietary/skills/community/`): Playwright capture runner (`node capture.mjs`), views in `views.json`, signs in through the local dev operator
- [x] Prism run on the portal at desktop 1440x900 and mobile 375x812 (10 views each, 20 PNGs), exported to `screenshots-designer-export.zip`
- [ ] Hand the zip to the US designer and head developer

## Phase 8: Miserly.io Revenue Engine & Enterprise Governance (planned)
- [ ] AI Cost Suite and dynamic rate sync: live pricing fetch for Claude, ElevenLabs, Vapi and Stripe Invoicing APIs
- [ ] White-labeled Good/Better/Best proposal generator with 60%-80% agency margin locks
- [ ] Hugging Face open-weights provider (`Aether_Engine/providers/huggingface/index.ts`): serverless and dedicated Inference Endpoints, local Transformers.js execution
- [ ] Dedicated GPU cost calculator: hourly node hosting (Nvidia A10G, A100, H100) vs. commercial API token spend
- [ ] Rolling Baseline Tracker: 7-day average token and dollar velocity per task type in Cloudflare D1
- [ ] Model Misallocation and Context Bloat alerts: Opus on routine file edits, context windows over 100k un-cleared tokens
- [ ] Multi-User Attribution Telemetry: Culprit Index of token burn rate, model mix and context hygiene per developer or department
- [ ] Executive PDF audits: transmittal reports through Courier (Claire Moreau) on token efficiency and wastage

## Phase 9: Programmatic Growth & Media Pipelines (planned)
- [ ] Programmatic SEO (Echo, Siddharth Patel): edge SEO routing, schema markup, high-ranking landers
- [ ] Paid acquisition and outbound funnels (Vanguard, Maya Lin): multi-channel ad copy, outbound email sequences, affiliate tracking
- [ ] Video content engine (Director, Jordan Blake): CapCut template batch rendering and ElevenLabs audio for Miserly.io and Witt Bits campaigns
- [ ] Physical fabrication and CAD (Sculptor, Nate Rodriguez): parametric FreeCAD scripts and OrcaSlicer profile automation for 3D printed products

## Phase 10: Idea to Delivery (2026-10-08)
One flow from an idea or a saved link to a delivered project, with Elarion guiding each step like a chief of operations. Handoff and resume notes: `HANDOFF.md`.
- [x] Unified New project dialog: guided intake (target, region, deliverables), page score and Elarion's questions, roadmap templates, one review, `/share` lands in it (2026-10-08)
- [x] Mission Control always dark like Space; Elarion tray above the composer, told what is on screen (Studio workflow, project phases) (2026-10-08)
- [x] D1 retrieval layer: records + FTS5, auto-indexing triggers, conversations stored per project, `search_records` / `get_record` tools (2026-10-08)
- [x] Space controls: 64px rail, toolbar of View / Time / Filter / Display / More trays, zoom-to-fit (2026-10-08)
- [x] Studio: pan and zoom, version history with click-to-restore, a map for every project, hints and hover focus, connector toolbox (Telegram, Web request), test-fire per action (2026-10-08)
- [x] Project journey: plan, map, connections, test, launch, deliver, with Elarion's next question (Projects card, Overview banner, `project_status` tool) (2026-10-08)
- [ ] Run connector actions for real inside workflow runs, only after an approval node (Telegram, Web request first)
- [ ] Test-fire a whole workflow: simulate each step with no sends, optional real model, result shown per node
- [ ] Google connection (OAuth, tokens kept in the portal): Gmail drafts and send from the user's own account (approval by default, daily cap, unsubscribe line), Sheets/Drive, Calendar
- [ ] Google Places lead finder (API key, no scraping) into a Sheet, with an email draft per lead
- [ ] Video channel pipeline: script, voice (ElevenLabs), render, YouTube upload
- [ ] Website generation through to a published site on a custom domain
- [ ] Shareable example workflow: idea to website, videos, leads and outreach, runnable end to end by someone else
- [ ] Sharing with other people: accounts, plans and billing (reuse the AuditPulse ledger and Stripe webhook design), onboarding
- [ ] Elarion as proactive COO: Telegram nudges when a project stalls, weekly status
- [ ] Connectors beyond Google: Slack, Notion, GitHub; auto-connect what a project already has set up

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
