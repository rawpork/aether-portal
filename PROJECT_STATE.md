# Project State

> **Handoff snapshot, updated 2026-09-28 (Connection Depth slider shipped).** Read this first when resuming. It covers what is live, how the codebase is configured, what was built, and exactly what comes next. Design detail lives in [SPATIAL_ARCHITECTURE.md](SPATIAL_ARCHITECTURE.md) (the "As built" notes in sections 3.6, 5.5, 6.6 and 8.7), and visual rules in [DESIGN.md](DESIGN.md).

## 1. What is live

- **URL:** https://lingering-water-de49.klo377.workers.dev (Cloudflare Worker `lingering-water-de49`).
- **Latest code commit:** `931177a` "feat: zoom stops step 1 - launch into the 180 wall, 4-stop slider, pointer-only rays", pushed to `main`.
- **Live version:** `7a62b549-b5e8-42bb-9efa-dff5b3d833ea` (deployed 2026-09-29, after `e929537` renamed stop 3 to Horizon).
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

- Run `npx wrangler dev --port 8799 --var SESSION_SECRET:local-test-secret`. The local D1 has user `user_owner` with about 15 test nodes and no groups. The test data was left clean.
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
  - **Next:** the desktop radial widget (the same rings, mouse drag and scroll wheel), then the headset lens barrel (opaque ring bands on the left wrist, turned with the right ray and trigger, controller haptics per stop, one Scale stop per stick push), with the headset stop placements.
- **Spatial zoom stops** (`public/js/spatial/zoom-stops.js`): Space (whole cloud), Cluster (one island), Horizon (the 180° wall; named Zoom until 2026-09-29), Atomic (one card).
  - **Top-bar slider** next to the depth slider; its labels are clickable too. It is hidden on phones until the vertical rail (step 3) and on the 2D board.
  - **Stays in sync:** every camera move reports its stop (`noteZoomStop` in `cameraGoTo`).
  - **Wheel:** on the wall, one flick = one stop (a trackpad's inertia included; the whole flick is kept from the orbit controls). In Space and Cluster the wheel zooms freely and steps on past 0.6× or 1.8× the stop's framing distance. The time span only widens from Space.
  - **Stop 3 framing:** the camera stands inside the arc, 0.1 rad above the card and looking down, close enough that the card fills 62% of the free width (70% of the height at most). The arc is widened (`arcFraming`) so the next cards' inner edges sit at 88% of the half-width; a wall the layout makes wider still is met by stepping back, down to 50%. Desktop drags slide along the wall and settle on the nearest card; arrows and swipes move the view without opening a card.
  - **Stop 4 framing:** the camera moves along the card's radius until it fills 86% of the free width (78% of the height), always at least 20% nearer than stop 3. On desktop the group list steps aside (`body.zoom-atomic`) while a card is open on the wall.
- **Focus:** focusing any card opens its cluster as a 180° gallery. An Outcome Node gets its own gallery with the saves it cites.
- **Desktop layout:** the group list is a left sidebar and the node card a right sidebar. Outside the wall, the camera frames the focused card in the free centre at up to 58% of the free width and 50% of its height (`FOCUS_FILL_WIDE`); on the wall, stop 4's framing applies. Translucent ◀ ▶ arrows sit below the wall.
- **Phones:**
  - A focused card hides the group list and the filter row.
  - The node card is one bottom sheet with a 24vh peek; swipe up or tap the handle to expand it, swipe down to collapse and then close.
  - The camera frames the card at 88% of the width (`FOCUS_FILL_COMPACT`).
  - A horizontal swipe on the 3D view snaps to the next or previous card, and there are no arrows.
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
4. **Spatial dashboard: shipped 2026-09-28** (after the Quest 2 retest).
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
