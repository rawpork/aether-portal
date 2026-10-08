# Project State

> **Handoff snapshot, updated 2026-10-07 (Phases 3-9 are tracked in [ROADMAP.md](ROADMAP.md); the 2026-10-01 swipe-scopes notes below are older).** Read this first when resuming. It covers what is live, how the codebase is configured, what was built, and exactly what comes next. Design detail lives in [SPATIAL_ARCHITECTURE.md](SPATIAL_ARCHITECTURE.md) (the "As built" notes in sections 3.6, 5.5, 6.6 and 8.7), and visual rules in [DESIGN.md](DESIGN.md).

## Next session (start here)

## Handoff 2026-10-07 (read this first): accessibility redesign shipped, Phase 2 (Realtime) planned

**Goal:** start Phase 2 (Realtime): WebSockets and Durable Object state sync. The plan is in [PHASE2_PLAN.md](PHASE2_PLAN.md); nothing in it is built.

**What's done**
- The accessibility and UX redesign (the 2026-10-07 design brief, milestones M1 to M9 and the S1 to S11 should-fix list) is merged to `main` and pushed. `main` and `origin/main` are at `636cf91`; the pre-redesign baseline is tag `v1.0.0` at `901f0d6`.
- Verified at `636cf91`: `npm test` 65 files / 695 tests pass, `npx tsc --noEmit` clean.
- Highlights: shared Space / Mission Control header switch with Alt+S / Alt+M and arrival announcements (`public/js/shell-surfaces.js`, `shell-keys.js`); one status pill with Stop all agents (`public/js/engine/status-pill.js`); readable names (`labels.js`); page-name H1 and one input per page; phone header budget; "Right now" strip and idle-state safeguards; banner follows the engine key state; 12px type floor, 44px targets, AA contrast and full-accent focus rings (guarded by `test/spatial/a11y-floor.spec.js`); focus traps and spoken mode changes (`public/js/a11y.js`); Projects list first, repeats folded; Roadmap links; 320px reflow checked for all nine Mission Control views.
- The current live sync is one-way Server-Sent Events (`src/graph-events.js`, one `GraphEvents` Durable Object per user); Mission Control polls everything.

**What's left**
- **Phase 2 (Realtime), R0 to R6** in [PHASE2_PLAN.md](PHASE2_PLAN.md), and the owner decisions in its section 6 (phase number, engine push A or B, resume window, ids or patches, shared rooms).
- Open accessibility items: Create page tag chips ("Cloudflare D1", "API keys") still lack a plain explanation; Space was not checked at 320px in a browser (CSS scan only); the wheel's + hub pad, the Space focus ring and the focus traps have not been looked at in a browser; the Operator console's live log is not de-duplicated; test with a real phone and a screen reader.
- Earlier open items still stand: hand `screenshots-designer-export.zip` to the designer and head developer; `DESIGN_BRIEF.md` (v2) records the design reasoning and the status of each recommendation.

**File paths**
- Plan: `PHASE2_PLAN.md`. Roadmap and phase numbering: `ROADMAP.md` (note: "Phase 2" is already used for the finished engine IPC gateway; `ROADMAP_MASTER.md` has another).
- Realtime today: `src/graph-events.js`, `src/engine-relay.js`, `src/engine-token.js`, `wrangler.jsonc` (Durable Object migration `v1`), `test/graph-events.spec.js`; the Space consumer is `EventSource('/api/events')` in `src/index.js`.
- Design: `DESIGN_BRIEF.md`, `DESIGN.md`, `DESIGN_SYSTEM.md`.

**Next action: R0, Message Format and Engine Contract.** Fix the topics, event types and envelope (PHASE2_PLAN.md sections 2.2 and 2.4), write `public/js/realtime-protocol.js` with validators and tests, and agree with the Aether_Engine side whether it pushes by outbound WebSocket or signed POST. No other realtime work should start before R0 is signed off.

**Working notes**
- The local D1 holds an import of the production data (134 cards, all under the dev operator `user_dev_operator`); the backup of the earlier local database is in `.wrangler/backups/`. Both are git-ignored.
- `npx wrangler dev --port 8787` does not pick up page-template changes (`src/*.js` templates): restart it. JavaScript under `public/` loads live.
- Local scratch files such as `find_missing_tool.py` and `fix_part4*.py` are untracked and not part of the project.

**Latest (2026-10-07):** the Mission Control / Aether_Engine work since 2026-10-01 is recorded phase by phase in [ROADMAP.md](ROADMAP.md), which is the source of truth; this file only points to it.
- **Where things stand:** Phase 3 (engine integration) and Phase 5 (autonomous delivery, dual-agent console, skill ingestion) are done; Phase 6 (sandboxed build, Pages staging, viability gate, Create / Templates tab) is built with the WSL sandbox installed; Phase 4 (Agent Workflow Studio) has 4.1a and 4.1b built and the rest as specs in `specs/ui/`; Phases 8 and 9 (Miserly governance and revenue engine, growth and media pipelines) are planned.
- **Today:** Phase 7 shipped. `AGENT_CORE.md` (owner profile and the 10-persona roster), `registry/connectors.json` (path index: look here before searching the disk) and `CLAUDE.md` (read AGENT_CORE on startup, registry first, zero-context-loss handoffs). Portal `520852f`. The `design-audit` skill (Prism, Playwright, desktop 1440x900 and mobile 375x812) is in `Aether_Engine/skills/design-audit`, engine `077c9d8`.
- **Open:** hand `screenshots-designer-export.zip` (in this folder, not committed) to the US designer and head developer; fill the TBD human names (Elarion, Forge, Ledger, Pixel) and the rest of the owner profile in `AGENT_CORE.md`; Phase 5 and 6 next steps (named tunnel, first real website project, first full sandbox run, affiliate links); Google sign-in and `ANTHROPIC_API_KEY` setup.
- **Running locally:** `npm run dev` (wrangler on http://localhost:8787, dev operator sign-in via `DEV_AUTH_BYPASS` in `.dev.vars`); the engine runs on :3333 and the "Aether Engine" watchdog task keeps it and its tunnel up.

**Earlier (2026-10-01):** `eac271b` "feat: swipe scopes and view-relative Home recentre" is **deployed and pushed**: live version `3d585480-2a9c-4974-bc96-d8c8e1737fa6`. Roll back with `npx wrangler rollback 2a2a1b0c-1e3a-4369-96e6-579fef9006a0` if needed.
- **Project folder moved** to `D:TitainSolutions_MDAI_ProjectsProprietaryAether_Portal` (from `C:UserskolsoDocuments_OnlineAI_MiscClaudeProjectsaether-portal`). Git history, the remote and the local D1 state came across; the npm package name stays `aether-portal` (npm names can't hold capitals).
- **Swipe scopes** (supersedes the group swipes below): a sideways swipe on the 3D view steps cards on the open wall, as the ◀ ▶ arrows do (`swipeCard` → `stepGallery`): a touch flick, a trackpad two-finger swipe, or a mouse drag in Atomic. With no wall up (Space, Cluster) a swipe on the view does nothing. Changing group is a swipe on the bottom-left overlays, the Categories legend (`#legend`) or the phone group tab (`#cluster-drawer .drawer-head`), via `bindGroupSwipe` → `swipeGroup` (touch events, 40 px, no click after a swipe). A sideways-scrolling chip row (phones, many categories) keeps its own scrolling; the pill below it still swipes.
- **Home / recentre** (supersedes `goHome` below): the Home pill and the Home / H key recentre the current view without leaving it (`recentreView`). List, Timeline, Board and Carousel scroll to the top-left (`resetCollectionScroll`, scrolled panes inside too); the 2D board drops its pan and zoom (`resetCameraView`). In 3D: Space looks at the origin (0, 0, 0) from the default angle (theta 0, phi π/2) at the macro distance; Cluster re-frames the framed group; Horizon turns back to the wall's middle card (`gallery.homeLook`); Atomic re-frames the open card. There is no one-tap way back to the launch view any more.
- **Checked:** 257 tests pass (none cover these gestures); the page script parses and the local and live pages load. **Not yet checked by hand** on a phone, a trackpad or a headset: do that first.

**Previous stop (2026-09-29):** the three commits below were deployed and pushed as version `2a2a1b0c-1e3a-4369-96e6-579fef9006a0`.

| Commit | What it adds |
| --- | --- |
| `741ac90` | **Mechanical UI and XR raycaster fix.** Wheel Simple / Advanced modes, the desktop wheel (mouse drag, one stop per scroll notch), and the headset lens barrel that replaces the flat wrist panel. XR fix: ray directions were built from the dolly-scaled controller matrix, so the picking ray drifted from the drawn laser whenever the world was scaled; they now read the matrix's -Z column. |
| `cfca6c0` | **Spatial refinements.** See below. |
| `a5f3722` | **Review fixes** from the first hands-on test. See below. |

**What the spatial refinements changed:**
- **Curved typography:** wheel labels run along their ring (SVG `textPath`), and the headset barrel's labels are bent onto their ring (`bendPoint` in `xr-barrel.js`). Also fixed: the wheel's knurl ticks grew longer one by one, because the loop variable shadowed the scale.
- **Group swipes (replaced 2026-10-01 by swipe scopes, above):** in Cluster, Horizon and Atomic, a sideways swipe flies in the next or previous group at the same stop, with no zoom out. This works as a touch flick, a trackpad swipe, or a mouse drag in Atomic. Groups are ordered around the vertical axis (`orderedGroupKeys`, `swipeGroup`).
  - Cards within a wall step with the ◀ ▶ arrows (now also shown on phones, above the group tab), the keyboard, a desktop drag along the wall, or a swipe on the card sheet.
  - Double-tapping empty space or turning the Scale ring still leaves the view.
- **Carousel:** touch swipes work again. A card's `lostpointercapture` bubbled to the stage and cancelled every touch drag. The deck is now the curved 180° Horizon arc: the viewer is at the arc's centre (CSS `perspective` = the radius), side cards turn in and run off the edges, and a tap on a side card turns the arc to it.
- **Playback priority:** on the Horizon wall, a tap on a video's thumbnail band (or a Play button in the group list) plays it inline over the card, with no zoom to Atomic (`playMedia(node, { wall: true })`).
- **Geometry:**
  - The pinned player's corners follow the card's (`--media-radius`, `CARD_RADIUS` share of its width), set on the iframe and video too.
  - Horizon and Cluster are framed much closer (`ARC_FILL` 0.8, `ARC_EDGE` 0.94, `ARC_MIN_FILL` 0.74, `CLUSTER_FIT_MARGIN` 0.85).
  - The wall framing on desktop keeps below the top bar and filter row (`getWallView`). Atomic fits the free area (`ATOMIC_FILL` 0.88 × 0.86) and is no longer forced 20% nearer than Horizon, which had put the card under the top bar.
  - The desktop wheel clears the List scrollbar (`--scrollbar-w`).
  - On phones, the Categories legend is a compact pill that opens to one sideways-scrolling row of chips, with an active-count badge.
- **Orbit pivot:** a tap on empty space after anything was selected (a card, a wall, a framed cluster, a highlight) unselects the group and moves the orbit's pivot back to the scene origin (0, 0, 0) (`recentreOrbit`). Turning off the last highlighted category does the same. A single tap in Horizon now does this instead of backing out to that group's Cluster view.

**Review fixes (after the first hands-on test):**
- **Home (replaced 2026-10-01 by the view-relative recentre, above):** a Home pill beside the wheel's Simple / Advanced switch (and the Home or H key) goes back to the launch view, the newest card's wall at Horizon, from any view (`goHome`). Free zoom in Space and Cluster now goes toward the pointer (`zoomToCursor`), so scrolling no longer flies past cards or away from them.
- **Horizon video:** a click anywhere on a playable card plays it in place; only a click on the picture used to. A second click on the playing card opens Atomic, and the video keeps playing.
- **Player look:** on a card, the player takes the thumbnail's place (`MEDIA_BAND`, 16:9, the thumbnail's small corners, no border), so the card's own frame stays round it. Before, a card-sized black box with its own border and large corners covered the card.
- **Headset:** each controller shows a matte handle with a teal ring, and tracked hands show a dot on each joint (`xr.js`); before, only the rays were drawn. The controls start **pinned in front at waist height** (22 cm below the eyes) on every entry, where they are seen at once; Unpin moves them to the left wrist. The Show ring's labels no longer overlap: labels were hidden by their wrapped angle, so a ring with more stops than fit round it drew far stops over near ones.
- Found in the first test: entering VR from the PC browser on the local dev server (localhost is a secure context) showed no hands and no controls.

**Checked:** 257 tests pass. Every item was checked in headless Edge at 1400 × 900 and on a 390 × 844 touch screen; the probe scripts are in the session scratchpad, not the repo. The probes read page state through a never-pausing conditional breakpoint, with no debug code in the app. Not checked on a physical phone, iPhone Safari (the `textPath` rendering) or a headset.

**Next steps, in order:**
1. **Review locally:** `npx wrangler dev --port 8799 --var SESSION_SECRET:local-test-secret`. Things to judge by hand:
   - whether swipes should switch groups rather than cards (decided 2026-10-01: the view steps cards, the Categories bar and group tab switch groups);
   - the closer Horizon framing;
   - the Carousel arc on a real phone.
2. **Deployed 2026-09-29** as `2a2a1b0c` and pushed. Reload any open tab or installed app once.
3. **Headset retest** (after the hand check of the 2026-10-01 swipes and Home). A Quest test of the live build (`2a2a1b0c`) was started on 2026-09-29 but no results were reported; ask how it went first. Check on the Quest, and in the PC browser over Link: the controller and hand models, the pinned controls on entry, the barrel (rings, hub, keys, grip-turning), the ray fix (card selection while the world is scaled), and the curved barrel labels.
4. **Carry-overs:**
   - zoom stops step 2 (headset stop placements, and Scale stops on the barrel) and step 3 (the phone vertical rail);
   - wire `relation` on hover;
   - inline video phase 3 (a `VideoTexture` in XR).

## 1. What is live

- **URL:** https://lingering-water-de49.klo377.workers.dev (Cloudflare Worker `lingering-water-de49`).
- **Latest code commit:** `eac271b` "feat: swipe scopes and view-relative Home recentre", pushed to `main`.
- **Live version:** `3d585480-2a9c-4974-bc96-d8c8e1737fa6` (deployed 2026-10-01, with `eac271b`). Before it: `2a2a1b0c-1e3a-4369-96e6-579fef9006a0` (2026-09-29, with `741ac90`, `cfca6c0` and `a5f3722`).
- **Zoom stops in progress:** step 1 (desktop and screens) is live. Step 2 is the headset: four placements, a scale glide between them, a ZOOM row on the dashboard, one stop per stick push, and launching into the arc at 1.3 m. Step 3 is phones: a vertical rail and a collapsed group tab at stop 3.
- **Remote D1:** migrations `0001` to `0015` applied (`0015_connection_depth.sql` on 2026-09-28; the 79 existing live edges became `logical`, and the owner's depth is `logical`). No migration is pending.
- **Roadmap status:** phases 1 to 7 of the spatial spec are shipped. Phase 6 (WebXR) has been tested only on a simulated Quest 3 (IWER), **not on a physical headset**.

### Commits this cycle (2026-09-27 to 2026-09-28), oldest first

| Commit | What |
| --- | --- |
| `76046f3` | The 180° gallery becomes the universal card focus. |
| `26f99e6` | **Phase 7: Agentic Synthesis and Outcome Nodes.** Migration 0014, `src/synthesis.js`, `/api/synthesize`, `/api/outcome/<id>/(regenerate\|blueprint)`, gold Outcome cards, `aether.blueprint/1` export. |
| `d7de546` | Manual "Synthesize Outcomes Now" skips the daily limit and flies to the newest Outcome. |
| `c87527e` | The layout is kept across reloads, the camera settles before the synthesis swoop, the page is `no-store` and the module URL is stamped per deploy (cache-busting), and the share sheet uses the portal's teal system. |
| `2d49953` | Gallery polish: edge sidebars, arrows, 3× "hero" texture for the focused card, looser focus fit, double-tap exit, Elarion Q&A thread. |
| `7c0dc8e` | Gallery arrows moved below the wall. |
| `bc44163` | Mobile: one bottom sheet with a peek height, and swipe navigation in the gallery. |
| `154fe56` | **Phase 5: 2D board morph** with drag-to-regroup. |
| `21c17b4` | Board layouts (Groups / Status / Map), node-editor wires, hold-to-drag, Undo toast, rename from the column header. |
| `657fae9` | **Phase 6: WebXR mixed reality.** |
| `fec3f1d`, `fb51385` | Docs: this handoff file and the Connection Depth spec. |
| `5286f31` | **Connection Depth slider** (migration 0015, labelled mining, depth rules, synthesis levels, slider). |
| `a8dd679` | Quest 2 fixes: XR renders past the post-processing composer (with MR-to-VR fallback), the graph is fitted to its container (aspect ratio), Carousel ignores laser jitter. |
| `9843dc9` | 2D board: cards drag freely between any columns (group columns regroup; type columns change the card's type). |
| `c9933b7` | Headset: AR/VR choice, grip-aligned rays (thumbstick press switches), physical label and proxy sizes; `media.js`. |
| `cc75296` | Inline video phase 1: play/launch icon buttons and the pinned player on screens. |
| `975d63a` | Headset spatial dashboard (wrist or pinned panel), Board and Timeline walls in XR, pointer rays back as default, sprite sizes in metres. |
| `931177a` | Zoom stops step 1: launch into the 180° wall, the 4-stop slider, closer stop 3 framing, wheel stepping; headset rays always from the target ray space. |
| `4aad8d3` | Radial controls: the dial engine and the phone thumb wheel (stop 3 renamed Horizon in `e929537`). |

## 2. Codebase configuration

### Runtime and deploy

- **Worker:** `src/index.js`. It holds every API route plus the portal page, which is one inline HTML template literal containing the CSS and the client script.
- **Worker modules:**
  - `src/synthesis.js`: Outcome Nodes.
  - `src/miner.js`: daily connection miner.
  - `src/groups.js`: groups and tags.
  - `src/share.js`, `src/share-page.js`: PWA share sheet.
  - `src/google-auth.js`: Google sign-in.
  - `src/metadata.js`: link previews.
  - `src/transcript.js`: YouTube transcripts.
  - `src/webfetch.js`: page text.
- **`wrangler.jsonc`:**
  - `main`: `src/index.js`, compatibility date `2026-09-16`;
  - cron `0 0 * * *` (the daily miner, then synthesis per user);
  - assets from `./public`;
  - `version_metadata` binding `CF_VERSION_METADATA`, used for cache-busting;
  - D1 binding `DB`: `aether_context_db`, id `3e602230-fe2d-4cc9-a488-85caec5ee24a`.
- **Environment names read by the code:**
  - `ADMIN_TOKEN`, `SESSION_SECRET`;
  - `GEMINI_API_KEY`, `GEMINI_API_BASE`, `ANTHROPIC_API_KEY`, `ELARION_WEB_SEARCH`;
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAILS`;
  - `TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_API_BASE`.

  Which of these are set in production was not re-checked this cycle. Gemini works live, because synthesis ran. Google sign-in and the Claude tier were waiting on secrets as of 2026-09-25 (see History below).
- **Deploy:** `npx wrangler deploy`, then `git push`.
  - Remote migrations: `npx wrangler d1 migrations apply aether_context_db --remote`. It sometimes fails with error 7403, and retrying works.
  - The live page is sent `Cache-Control: no-store`, and `/js/spatial/index.js?v=<version id>` changes each deploy. Users only need to reload once if a tab or the installed app was left open from before a deploy.

### Front end

- **Vendored libraries:** 3d-force-graph `1.80.0` and three.js `0.180.0`, self-hosted in `public/vendor/`.
- **Spatial modules:** `public/js/spatial/`, exposed to the page as `window.AetherSpatial` via `index.js`.

| Module | Role |
| --- | --- |
| `tokens.js` | Design tokens read from CSS. |
| `grouping.js`, `group-picker.js` | Hierarchy (Group by: group / category / platform / tag) and the group picker. |
| `camera-rig.js` | Damped camera rig, framing maths, `uncoveredTarget` (cover shapes: `right`, `bottom`, `sides`, `band`), WebXR-ready viewer dolly. |
| `card-faces.js`, `card-nodes.js` | Card faces (Outcome face included) and the card field: texture tiers hero 3× / near / far / plain, gallery blend, **board blend**, `setGlobalScale`, `displayPosition`. |
| `layout-gallery.js` | 180° gallery slots. |
| `hub-weights.js`, `lod.js` | Hub scale and glow; group proxies and level of detail. |
| `layout-2d.js` | Board columns (fixed or ranked), `columnAt`. |
| `layout-map.js` | Node-editor map layout and Bézier `wirePoints`. |
| `xr-math.js` | Pure WebXR placement: `placement`, `overviewPlacement`, `galleryPlacement`, `snapTurn`, `isTeleport`. |
| `xr.js` | WebXR session, rays, fade, snap turn, frustum-culling workaround. |
| `depth.js` | Connection Depth rules (pure; also imported by `src/synthesis.js` and `src/index.js`): `visibleLinks`, `primaryGroup`, `linkDepth`, `normalizeDepth`. |

- **Client script rules:** the page script sits inside a template literal. No backslashes, backticks or `${}` in it, and no duplicate top-level names. The status Board view already owns `boardDrag`, `endBoardDrag` and the body class `board-mode`, so the 2D board uses `boardCardDrag`, `endBoardCardDrag` and `flat-board`. The worker test "serves the graph UI with a client script that parses" enforces this.
- **Browser storage:** `localStorage` key `aetherViewPrefs` holds `{ view, listLayout, listSort, groupBy, boardMode }`. The admin token is stored under `aetherAdminToken`. The Connection Depth is **not** in browser storage: it is `users.connection_depth` on the server, loaded with `/api/graph`.

### Tests

- `npm test` runs `vitest run --no-file-parallelism` with two projects: `worker` (workerd) and `spatial` (node).
- At `975d63a`: **228 tests in 22 files, all passing.** New this cycle: `layout-2d`, `layout-map`, `xr-math`, `depth` (spatial), plus depth cases in the miner, synthesis and route tests.

### Local development

- Run `npx wrangler dev --port 8799 --var SESSION_SECRET:local-test-secret`. Google sign-in is not configured locally; sign in by setting an `aether_session` cookie for `user_owner`: `payload.HMAC-SHA256(local-test-secret, payload)`, both base64url, payload `{"sub":"user_owner","exp":<unix seconds>}` (`signSession`), e.g. in the browser console with `document.cookie = "aether_session=<token>; path=/"`. The local D1 has user `user_owner` with about 15 test nodes and no groups. The test data was left clean.
- Browser checks were done with headless Edge over CDP (port 9333), a signed `aether_session` cookie for `user_owner`, and a SwiftShader GPU. Those scripts lived in the session scratchpad and are **not in the repo**. Headless input latency makes quick double taps and swipes flaky in tests; they work with real input.
- **WebXR without a headset:** inject IWER (`iwer@2.5.0/build/iwer.module.min.js` from jsdelivr) with `new XRDevice(metaQuest3).installRuntime({ forceInstall: true })`. `forceInstall` is needed because Edge has a native `navigator.xr`.
  - Setting IWER controller quaternions did not aim the target ray as expected (the grip-to-ray mapping is unresolved).
  - Test real select and squeeze with `updateButtonValue`, and test picking by calling `xrOnSelect({ origin, direction })` directly.

## 3. How the product behaves now

### 3D graph and gallery

- **Opening scope:** the portal opens on the shortest recent time span with at least 5 cards. Pulling back from Space widens the span: day, week, month, groups, then all.
- **Launch view (zoom stops, 2026-09-28):** once the first layout settles, the portal opens the newest card's cluster as its 180° wall (stop 3), not the distant cloud. It waits up to 6 s for the cards, then falls back to the whole-graph view; a deep link still opens its card.
- **Radial controls (2026-09-29, mobile first):** flat pills and linear sliders are being replaced by solid, matte, concentric rings in the navy and teal system (no glass, blur or glow). One engine, `public/js/spatial/dial.js` (unit-tested), drives every platform: stops `pitch` radians apart, drag, flick and coast, a rubber-banded end, snapping into a stop, a `tick` per stop crossed (the haptic click) and a `change` on coming to rest.
  - **Ring order, outer to inner:** the View rim (3D Space · List · Timeline · Board · Carousel), then the primary ring (the Scale in 3D Space, the Board Layout on the Board, Time elsewhere), then what the stop needs (Space: Time, Cluster: Depth, Horizon: Show/platforms, Atomic: none; Board: Show and Time; List/Timeline/Carousel: Show). + Add is the hub (`wheelRings`).
  - **Coupling:** inner rings' knurling turns against the primary ring like meshed gears (`gearTurn`); their values never change on their own. Idle for 2.5 s, the wheel folds to the rim and the primary ring; a tap opens it.
  - **Phones (live):** `thumb-wheel.js`, an SVG quarter wheel pivoting on the bottom-right corner (`#thumb-wheel`, 164 px). It replaces the view switch, 2D toggle, Add, time stepper, depth slider, platform pills and board-layout bar at ≤767 px. Sweep a ring to turn it, or tap a stop. Each stop crossed vibrates (9 ms, 18 ms at an end). Where `navigator.vibrate` does not exist (iPhone Safari) the index wedge flicks and a soft tick sounds, which Settings → "Wheel clicks" turns off. The wheel lifts above the card's peek sheet and hides while a sheet is expanded. At ≤600 px the group list is a small tab beside the wheel; its title opens the full sheet. The status Board view reads as Board / Status on the wheel.
  - **Wheel mode (built 2026-09-29, not yet deployed):** a Simple / Advanced switch (`#wheel-mode`, just above the wheel; remembered per browser as `aetherWheelMode`, default Advanced). Simple keeps to the View rim and the primary ring (for new users); Advanced telescopes the inner rings out (`wheelRings({ simple })`). The headset barrel's hub switches the same mode.
  - **Desktop (built, not yet deployed):** the same wheel at ≥768 px, 232 px in the bottom-right corner (everything scales with the mount). Drag a ring with the mouse, or scroll over it: one stop per mouse-wheel notch, trackpads add up (`createScrollTurner`). The toolbar controls stay; the wheel mirrors them. It moves left of the card sidebar while a card is open.
  - **Headset lens barrel (built, not yet deployed; replaces the flat dashboard):** `xr-barrel.js`. Solid, matte `LatheGeometry` drums lit by the scene (Lambert, opaque, no glass), knurled faces, a teal index mark at the top. It rides 16 cm above the left wrist (or pinned, as the panel was), front turned to the user. Rings (`barrelRings`): View rim (Space · Gallery · Board), then Layout on the Board or Time, then Depth and Show; each inner ring stands 5 mm in front of the one around it, so Advanced telescopes out and Simple slides them back in. The hub is the Simple / Advanced switch; keys below: Back, Recenter, Zoom − / +, Room (MR), Pin, Exit.
    - **Picking:** the barrel's drums, faces, hub and keys are the first thing `xrPick` tests, so rays stop on it. `xr.js` now takes hold on `selectstart` and `squeezestart` (`onGrab`), calls `onDrag` every frame while held and `onRelease` on `selectend` / `squeezeend`; a press that took hold is not also a select or back. The ray's crossing of the ring's face turns it; a click without moving turns it to the stop under the ray. Each stop pulses the holding controller.
    - **Ray fix:** `xr.js` built each ray's direction with `setFromRotationMatrix` on the controller's world matrix, which carries the dolly's scale, so whenever the world was scaled the picking ray pointed away from the drawn line. It now reads the matrix's -Z column. Worth rechecking card selection on the Quest with this.
    - **Checked (IWER, simulated Quest 3):** clicking the View rim turns it to Board and back; holding the grip and sweeping Time turns it two stops with a pulse each (and is not a Back); the hub switches Simple and the inner rings retract. Not yet on a physical headset.
    - **Not yet:** Scale stops in the headset (they wait for the headset stop placements, zoom stops step 2).
- **Spatial zoom stops** (`public/js/spatial/zoom-stops.js`): Space (whole cloud), Cluster (one island), Horizon (the 180° wall; named Zoom until 2026-09-29), Atomic (one card).
  - **Top-bar slider** next to the depth slider; its labels are clickable too. It is hidden on phones until the vertical rail (step 3) and on the 2D board.
  - **Stays in sync:** every camera move reports its stop (`noteZoomStop` in `cameraGoTo`).
  - **Wheel:** on the wall, one flick = one stop (a trackpad's inertia included; the whole flick is kept from the orbit controls). In Space and Cluster the wheel zooms freely and steps on past 0.6× or 1.8× the stop's framing distance. The time span only widens from Space.
  - **Stop 3 framing:** the camera stands inside the arc, 0.1 rad above the card and looking down, close enough that the card fills 80% of the free width (90% of the height at most; on desktop the free area starts below the top bar). The arc is widened (`arcFraming`) so the next cards' inner edges sit at 94% of the half-width and run off the edges; a wall the layout makes wider still is met by stepping back, down to 74%. Desktop drags slide along the wall and settle on the nearest card; the arrows and a swipe on the view move it to the next card without opening it; changing group is a swipe on the Categories bar or group tab (2026-10-01).
  - **Stop 4 framing:** the camera moves along the card's radius until it fills 88% of the free width (86% of the height), below the top bar (it is no longer forced nearer than stop 3, which clipped the card under the top bar). On desktop the group list steps aside (`body.zoom-atomic`) while a card is open on the wall.
- **Focus:** focusing any card opens its cluster as a 180° gallery. An Outcome Node gets its own gallery with the saves it cites.
- **Desktop layout:** the group list is a left sidebar and the node card a right sidebar. Outside the wall, the camera frames the focused card in the free centre at up to 58% of the free width and 50% of its height (`FOCUS_FILL_WIDE`); on the wall, stop 4's framing applies. Translucent ◀ ▶ arrows sit below the wall.
- **Phones:**
  - A focused card hides the group list and the filter row.
  - The node card is one bottom sheet with a 24vh peek; swipe up or tap the handle to expand it, swipe down to collapse and then close.
  - The camera frames the card at 88% of the width (`FOCUS_FILL_COMPACT`).
  - A horizontal swipe on the 3D view steps cards on the wall, like the ◀ ▶ arrows above the group tab; a swipe on the group tab or the Categories pill changes group (2026-10-01; from 2026-09-29 the view swipe changed group).
- **Focused card:** it gets a 1536×960 "hero" texture, and there is no hover tooltip over wall cards.
- **Double tap:** it closes the panels and zooms out to the whole graph, even while the gallery is flying out. The glow halos don't take clicks, and the second tap is read from the raw pointer release.
- **Elarion Q&A:** the input clears on send, and each question is logged above its answer.

### Agentic Synthesis (Phase 7)

- The daily cron creates at most 2 Outcome Nodes per user per day.
- The admin button "✦ Synthesize Outcomes Now" skips that limit. It can add up to 2 per press per user, closes the settings panel, and flies into the newest Outcome's gallery once its card has settled.
- Outcomes can be Accepted, Regenerated (refused once accepted), Exported (a `aether.blueprint/1` JSON download plus clipboard, which sets the status to `sent`), or Dismissed.

### 2D board (Phase 5)

- **The morph:** "2D Board" in the top bar morphs the same cards onto a flat board; "3D Space" morphs them back. The force layout is never moved.
- **Layout switcher:** Groups · Status · Map at the bottom of the board, remembered per browser.
  - **Groups:** a column per primary group (a card's group, or its type while it has none), whatever Group by says. Cards drag freely between any columns (2026-09-28, the old lock is removed): onto a group's column a card joins that group; onto a type's column it takes that type (`PATCH /api/node { category, group_id }`) and leaves its group. Every move saves optimistically, with a 6 s Undo toast that restores both type and group. The only refusals are physical: a video link is re-detected as a video from its URL, and Outcome cards keep their type. Tapping a group header renames the group through `PATCH /api/groups/<id>`.
  - **Status:** Inbox, Active, Reference and Done, empty columns included. A drop changes the status, with Undo.
  - **Map (the Node Editor view):** a left-to-right node-editor layout of linked cards with Bézier ribbon wires coloured by link type. Unlinked cards sit in a grid below. Dragged cards stay where they are put for the session.
- **Touch guardrail:** a card lifts only after a 280 ms hold; moving sooner pans.
- The legend is hidden on the board, and the framing keeps clear of the top chrome and the layout switcher.

### WebXR (Phase 6)

What was built while you were away. Full notes are in SPATIAL_ARCHITECTURE.md 5.5.

- **Entering:** "Enter MR" (or "Enter VR") appears only when `navigator.xr.isSessionSupported` allows it. `immersive-ar` passthrough is preferred, on `local-floor`, with optional `hand-tracking`. Entering closes the board and panels. Leaving through the headset menu restores the screen view, controls and background.
- **Frame loop:** the library's `requestAnimationFrame` loop is paused. Each XR frame steps the card field, then runs one library `_animationCycle()`, then `pauseAnimation()`. The page's own card loop stands down while presenting.
- **Viewer placement** (dolly position, yaw and scale only; never the camera):
  - The overview puts the graph's radius at 1.1 m, centred 1.9 m ahead at eye height.
  - The gallery stands the user at its centre with the arc 1.6 m away.
  - The head's horizontal offset is cancelled and the real floor stays under the user.
- **Comfort:** teleports happen behind a 150 ms fade, and the first placement waits, dark, for the first head pose. Snap turns are 30° on the thumbstick. There is no smooth rotation.
- **Sizes:**
  - In the overview, cards are drawn at about 15 cm (`XR_OVERVIEW_CARD_M`, at most 6×).
  - The gallery arc's minimum radius is 36 units in a headset (18 on screens), which makes cards about 0.5 m wide.
  - A focused card slides forward only 10% of the radius (`XR_FOCUS_SLIDE`).
- **Input:** a teal ray and cursor per controller or tracked hand. Select (trigger or pinch) on a card opens its gallery; a card on the same wall comes forward without moving the viewer. Select on nothing, squeeze, or B/Y goes back to the overview.
- **Culling workaround:** three.js culls wrongly under a scaled dolly, which hid whole clusters. Frustum culling is disabled while presenting (re-applied every 30 frames) and restored on exit.
- **Emulator test coverage:** verified the button, entering MR, the overview over simulated passthrough, real select and squeeze events, pick and hover, the gallery teleport, same-wall focus, back, and exit. Not covered: snap turn (unit-tested only), hand pinch, and any physical device.

## 4. Next steps (in order)

1. **Headset retest after the Quest 2 fixes (2026-09-28).** A first real test on a **Quest 2** (Quest Browser) found three bugs, now fixed and live:
   - **MR showed empty passthrough, with a side-by-side stereo image on the page canvas.** The graph library renders every frame through its post-processing composer, whose last pass draws to the page canvas instead of the XR layer. The IWER emulator hid this, because there the XR layer is the canvas. While presenting, the composer now renders the scene directly (`xrDirectRender` in `src/index.js`), restored on exit. MR also falls back to VR when a mixed-reality session cannot start, and a frame that throws is logged once without ending the session.
   - **Stretched graph in the Quest Browser.** The library reads `window.innerWidth`/`innerHeight` once at load and never again, so the canvas and camera kept a stale aspect ratio. The graph is now sized from `#3d-graph`'s bounds on window, visual-viewport and container resizes (`fitGraphToContainer`), and again after leaving XR.
   - **Carousel: the laser pointer flickered and clicks stopped registering.** The 8px drag threshold turned a jittery laser press into a tiny drag: cards moved under the pointer and the click guard swallowed the click. Non-touch pointers now need a 24px, clearly sideways move to start a drag (60px for a flick), restyles are capped at one per frame, lost pointer capture ends the drag, and only the top card casts a shadow, with layers promoted only while dragging.

   All three were verified in a local browser (IWER for XR, including a forced MR failure falling back to VR). **Retest on the headset**, then continue with the checks below.

   **Quest 2 retest (2026-09-28): MR passthrough works.** Four more headset issues came out of it:
   - **Fixed:** an **AR vs VR choice** (the button reads "Enter XR" and offers Mixed reality or Virtual reality; VR is a real immersive-vr session on a dark navy space `#05080f`).
   - **Fixed:** **rays follow the controller's grip** by default instead of the Quest pointing pose, which felt off-angle. Pressing a thumbstick in switches between the two, and the choice is remembered (`aetherXrRayMode`); tracked hands keep their pointing pose.
   - **Fixed:** **physical label sizes**: group labels are 2.5 cm tall and group proxies 10 cm wide in the headset, whatever the world scale.
   - **Planned:** the **spatial dashboard**. It will be a canvas-drawn panel on the left wrist (palm toward the face, or X), with a pin button that detaches it into a floating panel at waist height. It carries views (as spatial versions: 3D, Board wall, Carousel gallery, a Timeline wall; List and Grid map to the Board), the 2D/3D morph, filters, the depth slider, back, a passthrough switch and exit. Build order agreed: headset fixes, then video phase 1, then the dashboard.

   Original checklist (Quest 3, "Enter MR"):
   - overview and gallery sizes and distances, and whether overview cards read at about 15 cm;
   - controller rays and hand pinch;
   - snap turn;
   - that passthrough shows behind the graph;
   - frame rate on a large graph with culling disabled.

   Tune the constants in `src/index.js` (`XR_*`) and `public/js/spatial/xr-math.js`.
2. **Connection Depth Slider: shipped in `5286f31` (2026-09-28).** A core backend parameter for the AI and clustering engine, with three cumulative levels. It shapes the wires, the synthesis bundles and the Outcome prompts; a card's primary group (`group_id`, or its category) never moves with it.

   | Level | Wires shown | Outcomes |
   | --- | --- | --- |
   | **Obvious** | Only inside a primary group (keyword, shared-tag, category-chain and obvious AI links). | Bundles stay inside one group (`minFamilies` 1, no diversity reward); the prompt asks for practical next steps. |
   | **Logical** (default) | Plus logical AI links; across groups: AI links, shared-tag links, and keyword links with 2 or more shared keywords (`STRONG_KEYWORD_LINK`). Weak keyword and category-chain links stay inside groups. | Today's rules: at least 2 topic families. |
   | **Abstract** | Every link, across any groups, plus abstract leaps, at most 3 per card by confidence (`ABSTRACT_LINKS_PER_NODE`). | Bundles must span 2 or more groups joined by at least one leap; the prompt asks for bold, cross-disciplinary plans. Leaps weigh 0.8 in bundle strength. |

   Outcome provenance links and a user's own manual links are always shown.

   **How it is built:**
   - **Migration 0015:** `users.connection_depth` and `node_edges.depth` (both `TEXT NOT NULL DEFAULT 'logical'`), plus `node_edges.confidence REAL`. The confidence column was added beyond the original spec, so abstract leaps can be ranked.
   - **Miner (`src/miner.js`, called from `mineNodes` in `src/index.js`):** items show their current group in braces, and every edge comes back as `{ a, b, depth, relation, confidence }` in the same single Gemini call.
     - The parser drops abstract edges without a relation (up to 140 characters) and abstract edges inside one group.
     - Unknown depths become `logical`, and confidence defaults to 0.5.
     - Per new item it keeps at most 3 obvious or logical edges and at most 3 abstract edges, most confident first.
     - Edges are stored with `INSERT OR IGNORE`, so the first label sticks.
   - **Rules (`public/js/spatial/depth.js`):** pure, and shared by the page (wire filter) and the worker (synthesis).
   - **API:** `/api/graph` returns every edge with `depth` and `confidence`, plus `connection_depth`. `PATCH /api/settings { connection_depth }` saves the level: session only, 405 for other methods, 400 for bad values. The cron's `synthesizeForUser` and Regenerate read the saved level.
   - **UI:** a three-stop range slider ("Obvious | Logical | Abstract") next to 2D Board. It filters wires instantly in 3D, the gallery and the board's Map, and saves after 500 ms. On phones (600px or narrower) it moves to the filter row after the time span and shows only the chosen stop's name.
   - **Checked:** in a local browser with seeded groups and edges, 5 wires at Obvious, 6 at Logical and 14 at Abstract, exactly as the table says. The level persists across a reload, and the Map follows it. The top bar fits on a 390px phone.

   **Follow-ups:**
   - Show an edge's `relation` (the abstract leap's explanation) on wire hover, in 3D and on the Map.
   - Existing live edges are all `logical`. Abstract leaps appear as the nightly miner labels new saves; older saves only get them after a re-mine, and even then `INSERT OR IGNORE` keeps existing pairs' labels. Consider a re-label pass.
   - The miner prompt is unit-tested but has not yet run live against Gemini with the new instructions. Check the first nightly run's `edges` and their depths.

3. **Inline video, phase 1 (screens): shipped 2026-09-28.** Phases 2 and 3 are still to build.
   - **Which links play:** `public/js/spatial/media.js` (pure, tested) decides. YouTube (watch, youtu.be, shorts, embed, live; start time kept) plays through the `youtube-nocookie.com` embed, Vimeo (public and unlisted) through `player.vimeo.com`, and direct `.mp4/.webm/.m4v/.mov` files through a `<video>`. TikTok, X, Facebook, Instagram and web pages launch in a new tab.
   - **Link buttons:** one compact icon button in all four link spots (node card, reader, group drawer, List/Grid/Board/Carousel cards). **▶ Play** is teal for playable videos; **↗ Launch** is a quiet outline for everything else. The icons are SVG, 36px (32px in lists), with a 44pt hit area. 3D card faces show the play badge only on playable videos.
   - **Pinned player:** YouTube embeds need a referrer (`strict-origin-when-cross-origin`).
     - In the graph (3D gallery or 2D board), it is pinned over the playing card's face and follows it every frame, always kept on screen. Tapping the thumbnail band of the focused card's 3D face plays it, found from the ray's surface position (`MEDIA_BAND` in `card-faces.js`).
     - With no card on screen (List, Timeline, Board, Carousel views), it floats centred at 16:9.
     - It stops when its card loses focus, the view changes, Esc or × is pressed, or a headset session starts. One video plays at a time.
   - **Still to build:**
     - phase 2 polish, if needed;
     - phase 3: direct files as a `VideoTexture` on the card (including in XR), and "Watch outside VR" (or a hand-off to the Quest Browser's player) for YouTube and Vimeo and for files blocked by CORS in the headset. There is no Worker proxy (decided 2026-09-28).
4. **Spatial dashboard: shipped 2026-09-28** (after the Quest 2 retest). **Replaced 2026-09-29 by the lens barrel** (radial controls above); `xr-panel.js` and `xr-dashboard.js` are gone. The notes below describe the panel as it was.
   - **The panel:** a 30 cm canvas-drawn panel (`xr-panel.js`, pure and tested, drawn and hit-tested like the card faces; `xr-dashboard.js` puts it in the dolly, in real metres, drawn over everything).
   - **Where it sits:** it rides 14 cm above the left controller or hand, turned to face the user. **Pin** moves it 55 cm in front and 30 cm below eye level, where it follows lazily once the user has turned about 35°. **X** shows or hides it.
   - **Using it:** the ray and trigger (or pinch) of either hand, with a light buzz on hover and a firmer one on select.
   - **Rows:**
     - **View:** Space, Groups, Status, Map, Timeline, Gallery. The Board layouts become a wall 1.7 m away that fits 2.4 × 1.4 m, with 3D column labels (the HTML headers do not render in a headset). Gallery opens the focused, pointed-at or newest card's 180° gallery.
     - **Time:** − / +.
     - **Depth:** Obvious, Logical, Abstract.
     - **Show:** the platforms.
     - **Actions:** Back, Recenter, Zoom − / + (factor 1.4), Room on/off (MR only: a dark shell around the head, no session restart), Pin/Unpin, Exit.
   - **Left thumbstick:** zooms continuously (the world grows or shrinks around the head); the right stick snap-turns.
   - **Rays** always come from the target ray space (the Quest pointing pose). The grip pose's forward axis runs along the handle, which pointed at the sky on the Quest 2.
   - **Rays still pointed at the sky after `975d63a` (Quest 2 retest):** the Quest browser had remembered the old grip choice (`aetherXrRayMode` in localStorage), which overrode the new default. Pushing the left stick in to zoom could also click it and flip the mode. The grip-ray option, its thumbstick toggle and the stored choice are now gone (the key is cleared on load). **Retest:** the laser should run straight out of the front of the controller.
   - **Sprite sizes:** three.js applies a sprite's size in the camera's units, which are metres in a headset. Labels are now sized in metres directly (2.5 cm tall; the 80968464 fix had made them metres high) and card glows are converted to metres.
   - **Timeline:** a new board layout on screens too, with a column per day, week or month to fit the span shown. Drops there change nothing.
   - **Checked** on the emulated Quest 3: every button, both panel placements, and zoom.
5. **Node Editor view (Map mode): shipped in `21c17b4`.** Possible follow-ups:
   - save dragged map positions (today they are session-only, in `mapMoves`, and lost on reload);
   - highlight the focused card's wires and dim the others;
   - direction arrows on wires;
   - create a link by dragging from one card's edge to another;
   - curved wires in the Groups and Status layouts, where links are hidden today.
4. **WebXR follow-ups:** the 3D group picker panel (spec 5.4), text entry for Ask Elarion and renaming, and the 2D board or Map inside the headset.
5. **Older setup items** (status not re-checked this cycle): Google sign-in secrets and linking the owner's email, `ANTHROPIC_API_KEY` for the Claude tier, and a live Android share-sheet test (see History).
6. **[TODO.md](TODO.md) backlog:** tests for `/api/graph` and the Telegram path, Gemini call batching, a Finish Line transport for blueprints (the Blueprint Clusters write-up), and renaming the worker.

## 5. Known issues and caveats

- **Board, empty type column:** a type's column only exists while some ungrouped card has that type, so a card whose own type has no column can't be dragged "home" to it. Use Undo, or the group picker's "remove".
- **Map positions** are not persisted.
- **WebXR:** not yet run on hardware. Frustum culling is off while presenting, so performance on large graphs is unknown. IWER's controller aiming in tests is unresolved; this is a test-harness issue only.
- **Small tablets (600-767px):** the phone "band" framing ignores side panels narrower than 60% of the width, so the drawer on the left can overlap the framed card.
- **Headless test flakiness:** double taps and swipes can miss their time windows because of CDP latency. This is not a product bug.
- **Stale docs:**
  - [ROADMAP.md](ROADMAP.md) and [ROADMAP_MASTER.md](ROADMAP_MASTER.md) still describe the old "2D Canvas" flat grid (replaced by the 2D Board morph in `154fe56`) and old version numbers.
  - [PROJECT_INDEX.md](PROJECT_INDEX.md) still says Gemini 2.5 Flash is the next milestone.

  This file and SPATIAL_ARCHITECTURE.md are current.

---

## History (before 2026-09-27)

### Active step
Web Content Fetcher, PWA share sheet and Google sign-in deployed (2026-09-25); Google sign-in and the Claude tier wait on secrets

#### Latest deployment
- Commit `5a86f9c` - feat: web content fetcher, PWA share sheet, Google sign-in (pushed to `main`).
- Deployed to Cloudflare Workers as `lingering-water-de49`, version `3021e7f0-8cbe-49b0-a64f-a3900450598d`: https://lingering-water-de49.klo377.workers.dev
- Migration `0012_web_content_google_auth.sql` applied to remote D1: `saved_nodes.content`, `users.email`, `users.google_sub`, `users.tier` (default `free`).
- Static assets: `public/` (manifest, service worker, icons) served through the `assets` setting in `wrangler.jsonc`.

##### Web Content Fetcher (`src/webfetch.js`)
- `POST /api/web-fetch {url?, nodeId?}` fetches a page with a desktop User-Agent, strips scripts, styles, nav, header and footer, and returns `{ success, content }` as Markdown-style text; with `nodeId` it saves to `saved_nodes.content`. `GET /api/web-fetch?id=` returns the stored text.
- Link cards (not YouTube, notes or images) show "Fetch Web Content", which opens the text in the full reader, then "Read Web Content".
- Private and local addresses are refused. Checked locally on Wikipedia and a Cloudflare blog post.
- The daily miner now adds the first 200 characters of a node's page text or synopsis to its prompt.

##### PWA share sheet (`/share`, `src/share.js`, `src/share-page.js`)
- `public/manifest.json` registers a GET `share_target` at `/share` (`url`, `title`, `text`); a minimal service worker makes the app installable. Android only; iOS Safari has no share targets.
- The sheet shows a link preview, model tier (Gemini Flash, Gemini Pro via `gemini-3.1-pro-preview` with Flash fallback, Claude Sonnet via `claude-sonnet-5`), action presets (Summarize, Event, Branch, Action Task) and a `/` command input.
- "Ingest to Aether" posts to `POST /api/share`, which saves the node to the inbox (Action Task goes to Active) and answers at once; metadata, page text and the preset run in the background, and the result is saved as a research entry on the node.
- Signed-out visitors are sent to sign in and then back to the share sheet.

##### Google sign-in (`src/google-auth.js`)
- `GET /api/auth/google` starts the OAuth 2.0 PKCE redirect flow (`openid email profile`); `POST /api/auth/google` takes a One Tap credential; `GET /api/auth/callback` finishes the redirect. ID tokens are verified against Google's keys.
- Accounts match by Google id, then by email. New accounts are created only for addresses in `GOOGLE_ALLOWED_EMAILS` (`@domain` allows a whole domain), on the free tier. The admin users endpoint accepts `email` to link an existing account.
- Sessions use the existing HTTP-only signed session cookie.
- The signed-out screen is an Apple-style card with "Sign in with Google", One Tap, and the username/password form below.

##### Setup still needed
- Google Cloud OAuth web client with the production origin and `/api/auth/callback` redirect URI, then `wrangler secret put` for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_ALLOWED_EMAILS`. Until then the Google button is hidden.
- `ANTHROPIC_API_KEY` secret to enable the Claude Sonnet tier (greyed out until set).
- Link the owner account's email through `POST /api/auth/users`.

##### Not yet exercised live
- Share-sheet presets on any model tier, Gemini Pro, the Claude call, real Google sign-in and One Tap, installing and sharing on Android. The transcript synopsis from the previous release has not run live either.

#### Earlier deployments (2026-09-25)
- `b9fc0089` (commit `899f1e3`): Transcript section on YouTube node cards; `/api/graph` carries `synopsis` and `has_transcript`.
- `09267be9` (commit `69aa68e`): `/api/transcript` YouTube Transcript Pipeline, with migration `0011_transcripts.sql` (`raw_transcript`, `synopsis`).
- `8b44f780` (commit `26281e0`): clicking a legend category highlights it and flies the camera to its cluster centre.
- `15b98cf5` (commit `15a9833`): Focus Card Carousel view, a fifth view with a swipeable card deck; a node selected in the 2D/3D map can open the deck on that node.

#### Next up
- Finish the setup above, then test the share sheet on Android and Google sign-in end to end; see [ROADMAP.md](ROADMAP.md).

### Previous milestone
Phase 3 complete: Gemini 2.5 Flash API + rainbow clustering

#### Current status
- Cloudflare Worker is running from [src/index.js](src/index.js) with D1 persistence configured in [wrangler.jsonc](wrangler.jsonc).
- Telegram ingestion and the `/api/graph` graph feed are active.
- A new `/api/recluster` endpoint passes generic node records through Gemini for title/category normalization and D1 updates.
- The 3D graph now uses an HSL rainbow scale for node coloring, so related clusters glow across a color spectrum.

#### Completed implementation
- Added Gemini-based analysis helper for AI title/category classification.
- Added `/api/recluster` to reprocess weakly classified saved nodes.
- Updated node rendering to calculate hue from each node’s identity and group, producing a rainbow cluster effect.

#### Guardrails
- Keep worker calls bounded and fail-safe when the AI key is absent.
- Validate Gemini responses before writing to D1.
- Preserve the existing Telegram + graph flow while using AI enrichment as a second-pass normalization layer.
