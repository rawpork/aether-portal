# Project State

> **Handoff snapshot, 2026-09-28.** Read this first when resuming. It covers what is live, how the codebase is configured, what was just built (Phase 6), and exactly what comes next. Design detail lives in [SPATIAL_ARCHITECTURE.md](SPATIAL_ARCHITECTURE.md) (the "As built" notes in sections 3.6, 5.5, 6.6 and 8.7), and visual rules in [DESIGN.md](DESIGN.md).

## 1. What is live

- **URL:** https://lingering-water-de49.klo377.workers.dev (Cloudflare Worker `lingering-water-de49`).
- **Latest commit:** `657fae9` "feat: WebXR mixed reality (Phase 6)", pushed to `main`. The working tree was clean at handoff.
- **Live version:** `a40b1a94-a395-482f-9f06-4bcff8cb1971` (deployed 2026-09-28).
- **Remote D1:** migrations `0001` to `0014` applied (`0014_outcomes.sql` on 2026-09-27). No migration is pending.
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

- **Client script rules:** the page script sits inside a template literal. No backslashes, backticks or `${}` in it, and no duplicate top-level names. The status Board view already owns `boardDrag`, `endBoardDrag` and the body class `board-mode`, so the 2D board uses `boardCardDrag`, `endBoardCardDrag` and `flat-board`. The worker test "serves the graph UI with a client script that parses" enforces this.
- **Browser storage:** `localStorage` key `aetherViewPrefs` holds `{ view, listLayout, listSort, groupBy, boardMode }`. The admin token is stored under `aetherAdminToken`.

### Tests

- `npm test` runs `vitest run --no-file-parallelism` with two projects: `worker` (workerd) and `spatial` (node).
- At `657fae9`: **201 tests in 19 files, all passing.** Nineteen tests are new this cycle, for `layout-2d`, `layout-map` and `xr-math`.

### Local development

- Run `npx wrangler dev --port 8799 --var SESSION_SECRET:local-test-secret`. The local D1 has user `user_owner` with about 15 test nodes and no groups. The test data was left clean.
- Browser checks were done with headless Edge over CDP (port 9333), a signed `aether_session` cookie for `user_owner`, and a SwiftShader GPU. Those scripts lived in the session scratchpad and are **not in the repo**. Headless input latency makes quick double taps and swipes flaky in tests; they work with real input.
- **WebXR without a headset:** inject IWER (`iwer@2.5.0/build/iwer.module.min.js` from jsdelivr) with `new XRDevice(metaQuest3).installRuntime({ forceInstall: true })`. `forceInstall` is needed because Edge has a native `navigator.xr`.
  - Setting IWER controller quaternions did not aim the target ray as expected (the grip-to-ray mapping is unresolved).
  - Test real select and squeeze with `updateButtonValue`, and test picking by calling `xrOnSelect({ origin, direction })` directly.

## 3. How the product behaves now

### 3D graph and gallery

- **Opening scope:** the portal opens on the shortest recent time span with at least 5 cards. Zooming out widens the span: day, week, month, groups, then all.
- **Focus:** focusing any card opens its cluster as a 180° gallery. An Outcome Node gets its own gallery with the saves it cites.
- **Desktop layout:** the group list is a left sidebar and the node card a right sidebar. The camera frames the focused card in the free centre at up to 58% of the free width and 50% of its height (`FOCUS_FILL_WIDE`). Translucent ◀ ▶ arrows sit below the wall.
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
  - **Groups:** a column per cluster under the current Group by. Dropping a card on another column regroups it (saved optimistically, with a 6 s Undo toast). A card can leave its group only for its own type's column, and columns are read-only when Group by isn't Group. Tapping a group header renames the group through `PATCH /api/groups/<id>`.
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

1. **First real headset test (Quest 3, "Enter MR").** Check:
   - overview and gallery sizes and distances, and whether overview cards read at about 15 cm;
   - controller rays and hand pinch;
   - snap turn;
   - that passthrough shows behind the graph;
   - frame rate on a large graph with culling disabled.

   Tune the constants in `src/index.js` (`XR_*`) and `public/js/spatial/xr-math.js`.
2. **Connection Depth Slider (specced 2026-09-28; not built).** A core backend parameter for the AI and clustering engine, not a visual highlight. It sets how far the engine reaches when it relates saves, on three cumulative levels:

   | Level | Meaning | Wires | Outcomes |
   | --- | --- | --- | --- |
   | **Obvious** | Surface-level and keyword connections. | Only between cards in the **same group**. | Bundles stay **within one group**; plans are practical next steps. |
   | **Logical** (default) | Standard semantic relatedness. | Obvious and logical edges, now also **across groups** between closely related cards. | Today's behaviour: bundles span at least 2 topic families (`MIN_FAMILIES`). |
   | **Abstract** | Distant, cross-disciplinary leaps. | Adds abstract edges, **between different groups**, preferring groups with no other link: the "wild" cross-map wires. | Bundles must span at least 2 groups joined by at least one abstract edge; the prompt asks for highly creative, non-obvious combinations. |

   **Groups never move with the slider.** A card's primary group is always assigned at the Logical level, which is today's miner granularity ("a short concept name for the theme"). The slider governs **cross-group traversal**: which wires may cross group boundaries, and which bundles synthesis may form. Its "same group" means the card's primary group: `group_id`, or its category while it has none.

   **Edge labelling (miner).** One pass, no extra Gemini calls:
   - `buildMinerPrompt` asks for every edge to carry `depth`:
     - `obvious`: same keyword, tool, product or explicit reference;
     - `logical`: same topic or project, or one builds on the other;
     - `abstract`: a shared principle or analogy across fields.
   - The JSON edge becomes `{ "a", "b", "relation", "depth" }`.
   - Abstract edges **must** include a `relation` explaining the leap, for the wire hover later. `parseMinerResponse` drops abstract edges without one. It also drops abstract edges whose endpoints share a group, since the prompt lists each item's group.
   - Per-item caps: today `MAX_EDGES_PER_NEW_NODE` is 3 in total. Proposal: keep 3 for obvious plus logical, and allow up to 2 abstract.
   - `mineNodes` (`src/index.js`) stores the label: `INSERT OR IGNORE INTO node_edges (source_id, target_id, relation, depth, user_id)`. Re-mining never relabels an existing edge, because `INSERT OR IGNORE` keeps the first label.

   **Non-mined links get a fixed depth:**
   - keyword links (`semantic`, from `buildGraphLinks` in `src/index.js`, which counts shared title and URL keywords, max 5 per card) are `obvious`;
   - shared-tag links (`concept`, `src/groups.js`, max 3 per card) are `obvious`;
   - Outcome `synthesis` links are always shown, whatever the depth.

   **Migration 0015:**
   - `ALTER TABLE users ADD COLUMN connection_depth TEXT NOT NULL DEFAULT 'logical'`
   - `ALTER TABLE node_edges ADD COLUMN depth TEXT NOT NULL DEFAULT 'logical'`

   Every existing edge becomes `logical`, which is what today's prompt produced. Values are validated in code (`obvious` | `logical` | `abstract`).

   **API:**
   - `/api/graph` returns every edge with its `depth`, plus the user's `connection_depth`.
   - The client filters wires by level and group, so dragging the slider is **instant**, with no refetch and no re-mining. The same filter feeds the 3D view, the 2D board's Map wires and the gallery.
   - A small authenticated endpoint (proposed: `PATCH /api/settings { connection_depth }`) saves the level, because the cron reads it for synthesis.

   **Synthesis (`src/synthesis.js`):**
   - `findCandidateBundles` is given only the edges visible at the user's level, plus that level's bundle rule from the table above.
   - `buildSynthesisPrompt` gets a level-specific instruction.
   - Link weights: `ai` 1, `concept` 0.6, `semantic` 0.5 today. Proposal: abstract edges weigh 0.8, so a bundle joined only by abstract leaps is not favoured over strong direct links unless the level is Abstract.
   - Novelty, fingerprints and the daily limit are unchanged.

   **Old saves:** abstract edges for saves mined before this change appear only after they are re-mined. Plan to extend the admin "Mine Tags & Groups for Old Nodes" pass (`/api/remine`) to write labelled edges.

   **Still to decide:**
   - Where the slider sits in the UI. Recommendation: a three-stop Obvious · Logical · Abstract control in the Filters popover, since it shapes the graph.
   - The abstract edge cap.
   - Whether keyword (`obvious`) links should cross groups at the Logical level, as this spec allows ("closely adjacent").

   **Tests to add:** prompt and parser (labels, required relation, the same-group rejection), the client wire filter per level, and synthesis bundle rules per level.
3. **Node Editor view (Map mode): shipped in `21c17b4`.** Possible follow-ups:
   - save dragged map positions (today they are session-only, in `mapMoves`, and lost on reload);
   - highlight the focused card's wires and dim the others;
   - direction arrows on wires;
   - create a link by dragging from one card's edge to another;
   - curved wires in the Groups and Status layouts, where links are hidden today.
4. **WebXR follow-ups:** the 3D group picker panel (spec 5.4), text entry for Ask Elarion and renaming, and the 2D board or Map inside the headset.
5. **Older setup items** (status not re-checked this cycle): Google sign-in secrets and linking the owner's email, `ANTHROPIC_API_KEY` for the Claude tier, and a live Android share-sheet test (see History).
6. **[TODO.md](TODO.md) backlog:** tests for `/api/graph` and the Telegram path, Gemini call batching, a Finish Line transport for blueprints (the Blueprint Clusters write-up), and renaming the worker.

## 5. Known issues and caveats

- **Board, empty type column:** a card that is the only ungrouped card of its type has no type column to return to once it joins a group, because the column vanishes when empty. Use Undo or the group picker's "remove" instead.
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
