# ?? Aether OS — Consolidated Master Roadmap & Architecture Specification
> The Spatial Operating System for Compound Intelligence & Automated Action

## ?? Core Architecture & Operating Strategy
- **Production Endpoint:** https://lingering-water-de49.klo377.workers.dev
- **Stack:** Cloudflare Workers + D1 Database (aether_context_db) + Gemini 3.x API
- **AI Cost Routing Strategy:** 
  - **Tier 1 Workhorse (95% of tasks):** gemini-3.5-flash-lite (Fast, low-cost note queries, graph layout updates, categorization).
  - **Tier 2 Web Research (5% of tasks):** gemini-3.8-flash with native Google Search Grounding tools.
  - **Silent Fallback:** Automatic fallback to Tier 1 if Tier 2 hits grounding or quota errors.
- **Local Dev Tooling:** Claude Code CLI authenticated via **Claude Pro / Subscription tier** (rolling 5-hour window) to eliminate pay-as-you-go API overages.

---

## ? Completed Build Baseline (v1.5 Deployed)

- [x] **Cost-Optimized Two-Tier AI Router:** Tier 1 / Tier 2 fallback logic implemented in src/index.js.
- [x] **Persisted Card Research:** Card Q&A entries saved to D1 in research column (capped at 4,000 characters, max 10 entries per node).
- [x] **"Spawn Node from Answer" Action:** 1-click button under research responses that creates a new connected node on the 3D canvas.
- [x] **Database Migration 0005:** Live schema updated (0005_add_research.sql).
- [x] **UI Polish & Navigation:** 44px glass top bar, collapsible category legend, 1-Hop Neighborhood Walker, shape primitives, and orphan node toggles.

---

## ??? Active Fixes & UI Enhancements (Immediate Priority)

### 1. Research Persistence UI Render Bug
- [x] **In-Memory State Sync:** Update POST /api/ask handler in src/index.js to immediately append { question, answer, sources, date } into graphData.nodes in local memory.
- [x] **Overlay Persistence:** Fix node overlay generator so closing and reopening a card preserves the "Past Research & Q&A" accordion and all past + Create Node from Answer buttons.

### 2. Full Reader View (No Text Truncation)
- [x] **Remove Text Ellipses / Line-Clamping:** Eliminate CSS text-overflow: ellipsis and line-clamp on node detail views.
- [x] **Expandable Reader Modal:** Add a [ ? Expand Full Reader ] button to open long-form SOPs, briefs, and notes in an unclipped, scrollable glass modal.

### 3. Open Graph Link Previews
- [x] **Metadata Fetching:** Extract og:image, og:title, og:description, and source_url when links are saved via UI or Telegram.
- [x] **Card Header Preview:** Render cover image, site name, and a direct [ ?? Open Original Source ] link button at the top of the node card overlay.

---

## ?? Phase 1: Accounts & Multi-Tenancy (Deployed)

- [x] **Database Migration 0006_user_scoping.sql:**
  - Create users table with id, email, password_hash (PBKDF2), and telegram_chat_id.
  - Add user_id foreign key column to saved_nodes and node_edges.
- [x] **Admin-Only Account Provisioning:**
  - POST /api/auth/users protected by ADMIN_TOKEN to create user accounts securely.
- [x] **Authentication Middleware:**
  - POST /api/auth/login returning HttpOnly session cookies / JWTs.
  - Require active authentication on all graph routes (GET /api/nodes, POST /api/node, POST /api/ask).
- [x] **Glass Login Gate UI:**
  - Overlay login interface on the canvas when unauthenticated.

---

## Phase 2: Enhanced Visualization & Custom Views (In Progress)

- [x] **View Mode Switcher:** Graph / List / Timeline segmented control in the top bar; choice remembered per browser. The 2D/3D toggle stays inside Graph view.
- [x] **List & Grid View:** Scrollable glass cards with category chip, preview, site and date; List/Grid layout toggle; sort by newest, oldest, title or category; Open Graph cover images in Grid.
- [x] **Timeline View:** Vertical date feed with sticky Today / Yesterday / Last 7 Days / month headers and a category-colored spine.
- [x] **Shared Filters & Card:** Search, type, time and Hide Unlinked filters apply to every view; any item opens the regular node card (reader, Ask Elarion, spawn). Graph animation pauses while hidden.
- [x] **Telegram Link-Pairing:** Plain text sent within 2 minutes of a link is attached to that link as a note instead of creating a new node; text sent with a link in the same message is split into URL + note; `/note <text>` forces a standalone note (migration 0008: user_note).
- [x] **Visual Node Enhancements:** Saved favicons (with /favicon.ico fallback), node-type icon badges on every card and chip, og:image covers and list thumbnails, type-icon placeholder covers, and a play overlay on video thumbnails (migration 0008: favicon_url).
- [x] **Telegram Command Shortcuts:** `/research <topic or link>` (search-grounded research; a link keeps the answer in its card's Past Research, a topic is saved as a new article node), `/ask <question>` (keyword-ranked graph context), `/link <url> [note]`, `/note <text>`, and `/help` / `/start` (command guide + pairing info). Long answers are split under Telegram's 4,096-character limit.
- [x] **Bot Autocomplete Registration:** `setMyCommands` publishes the "/" command list on the first webhook each worker instance handles (Workers have no startup hook) and again on the daily cron.
- [x] **Telegram Commands Help Modal:** Paper-plane button next to search opens a glass modal listing the commands and explaining the 2-minute link + comment pairing; built from the same command list as `/help`.
- [x] **Facebook Metadata & Link Cleaning:** Share/ad tracking parameters (mibextid, fbclid, utm_*, YouTube si/is) are stripped before fetching and saving; Facebook links that return a login wall or placeholder title ("Facebook", "facebook/share", "Log in or sign up") are retried once with Facebook's link-preview crawler user agent; when a page still gives nothing, titles fall back to readable names ("Facebook Reel", "Google search: ...", "Page · site.com") instead of the raw URL. The metadata backfill also replaces existing URL-shaped titles.
- [x] **16:9 Thumbnails:** Grid covers, list thumbnails and the node card header use 16:9 frames (card header capped at 220px) with object-fit: contain, so YouTube frames and link images show uncropped; YouTube uses maxresdefault.jpg when the video has one, else hqdefault.jpg.
- [x] **Responsive Card Inspector:** On screens 768px and wider the node card is a floating right-side panel (440-480px wide, max 80vh) so the graph and legend stay visible (list/grid content makes room for it from 1100px); on phones it is a bottom sheet with a drag handle - drag down to close.
- [x] **Connected Cluster Carousel:** The card header shows "Card N of M in ..." with previous/next arrows (plus Left/Right arrow keys and left/right swipes on phones), cycling with wrap-around and keeping the graph focus and list highlight in sync. Members are the nodes reachable over drawn (AI-mined/manual) edges in a fixed order starting from the best-connected node; nodes without edges page through their category cluster instead.
- [x] **Telegram Photo Ingestion:** Photos (and JPEG/PNG/WebP/GIF images sent as files) are downloaded via getFile, described by Gemini vision (Flash-Lite, Flash fallback) into a title, caption and up to 8 tags, and saved as `image` nodes. A photo caption, or text sent within 2 minutes, becomes the node's note. D1 stores only Telegram's permanent file_id (migration 0009); the signed-in-only `/api/node-image/:id` route streams the image, so no bot token or expiring URL is stored. Images show as grid covers, list thumbnails and the card header, have their own Images filter, and captions/tags are searchable.
- [x] **Double-Click / Double-Tap Camera Reset:** Two clicks or taps on empty canvas within 350 ms and 30 px animate the camera back to a front-on view that fits every visible node (3D fits a bounding sphere; the flat 2D canvas fits its x/y extent). Clicks on nodes, edges and cluster labels never count, and search, type, time and orphan filters plus the legend highlight are left as they were.
- [x] **Platform Filter Bar:** A toolbar row under the header with All, YouTube, X/Twitter, Facebook, Links, Notes and Images pills, each with a live count of the nodes the other filters leave visible (e.g. "YouTube (4)"). Picking one dims the non-matching nodes on the graph (their category shells and labels fade too, and edges not touching a lit node go subtle) without hiding anything; List and Timeline show only the matching nodes. The camera double-tap reset keeps the active platform; Clear Filters resets it. Also fixed: the List/Grid layout pills no longer reset the type filter.

---

## ?? Phase 3: Lightweight Agentic Quarterback & Dynamic Skill Engine

- [ ] **Database Migration 0010_agent_skills.sql:**
  - Create agent_skills (holding skill_key, system_instructions, and required_tools) and agent_memory tables in D1.
- [ ] **Telegram Chat Linking (POST /api/telegram):**
  - Map telegram_chat_id to users.id (unrecognized chats receive a "Not Authorized" reply).
- [ ] **Just-In-Time (JIT) Skill Router:**
  - Intent classifier extracts task category and fetches matching system instructions from agent_skills in D1.
  - Injects skill prompts on demand to prevent context bloat and eliminate heavy MCP overhead.
- [ ] **Self-Updating Skill Feedback Loop:**
  - Support natural language corrections via Telegram to update skill instructions dynamically in D1.
- [ ] **Specialized Agent Capabilities:**
  - **Outreach Agent:** Draft cold outreach emails/DMs for founders; display inline Telegram approval buttons.
  - **Research & SOP Agent:** Extract web URL content, generate formatted step-by-step SOPs, attach #SOP tags, and auto-save as D1 nodes.
  - **Code Generation Agent:** Generate code snippets and attach code nodes to specific project clusters.
  - **Media Generation Agent:** Dispatch asset creation requests and save image/video URLs to the graph.

---

## ?? Phase 4: Project Boards & Navigation Views

### 1. Visual Project Board View (Milanote Canvas)
- [ ] **D1 Position Coordinates:** Store canvas (X, Y) positions for nodes when in Board Mode.
- [ ] **Interactive Checklists & Tasks:** Support - [ ] markdown checkboxes that update D1 node state on toggle (PUT /api/node/:id).
- [ ] **Media Cards & Drag-and-Drop Stacks:** Display image/video previews and group cards into visual containers (e.g., "Ideas", "Tasks", "Budget").
- [ ] **"? Execute SOP" Action Trigger:** Button on SOP cards to pass procedural steps directly to worker task queues.

### 2. Collapsible Tree Navigation View (2D Drawer)
- [ ] **Slide-Over Glass Tree Panel:** Mobile-friendly bottom/side sheet with expandable carets (> / v) displaying categories and child nodes (Raindrop.io style).
- [ ] **Two-Way 3D Camera Sync:** Selecting items in the Tree View glides the 3D canvas camera directly to that cluster or node.
- [ ] **Dynamic AI Taxonomy Engine:** Gemini Flash-Lite evaluates incoming content to automatically map notes to existing categories or propose new ones (NEW_CATEGORY: <Name>).

---

## ?? Phase 5: Future Major Release (v2.0 — WebXR Spatial VR)

- [ ] **WebXR Headset Support:** Three.js VRButton integration for full 3D room-scale VR on Meta Quest, Vision Pro, and SteamVR.
- [ ] **6DoF Physical Spatial Navigation:** Walk through category star systems in true physical room space.
- [ ] **Hand-Tracking & Spatial Gestures:** Pinch-to-inspect, drag-to-connect manual edge linking, and a floating 3D spatial glass HUD for Elarion AI prompts.
