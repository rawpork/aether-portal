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
- [ ] **In-Memory State Sync:** Update POST /api/ask handler in src/index.js to immediately append { question, answer, sources, date } into graphData.nodes in local memory.
- [ ] **Overlay Persistence:** Fix node overlay generator so closing and reopening a card preserves the "Past Research & Q&A" accordion and all past + Create Node from Answer buttons.

### 2. Full Reader View (No Text Truncation)
- [ ] **Remove Text Ellipses / Line-Clamping:** Eliminate CSS text-overflow: ellipsis and line-clamp on node detail views.
- [ ] **Expandable Reader Modal:** Add a [ ? Expand Full Reader ] button to open long-form SOPs, briefs, and notes in an unclipped, scrollable glass modal.

### 3. Open Graph Link Previews
- [ ] **Metadata Fetching:** Extract og:image, og:title, og:description, and source_url when links are saved via UI or Telegram.
- [ ] **Card Header Preview:** Render cover image, site name, and a direct [ ?? Open Original Source ] link button at the top of the node card overlay.

---

## ?? Phase 1: Accounts & Multi-Tenancy (In Progress)

- [ ] **Database Migration 0006_user_scoping.sql:**
  - Create users table with id, email, password_hash (PBKDF2), and telegram_chat_id.
  - Add user_id foreign key column to saved_nodes and node_edges.
- [ ] **Admin-Only Account Provisioning:**
  - POST /api/auth/users protected by ADMIN_TOKEN to create user accounts securely.
- [ ] **Authentication Middleware:**
  - POST /api/auth/login returning HttpOnly session cookies / JWTs.
  - Require active authentication on all graph routes (GET /api/nodes, POST /api/node, POST /api/ask).
- [ ] **Glass Login Gate UI:**
  - Overlay login interface on the canvas when unauthenticated.

---

## ?? Phase 2: Lightweight Agentic Quarterback & Dynamic Skill Engine

- [ ] **Database Migration 0007_agent_skills.sql:**
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

## ?? Phase 3: Project Boards & Navigation Views

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

## ?? Phase 4: Future Major Release (v2.0 — WebXR Spatial VR)

- [ ] **WebXR Headset Support:** Three.js VRButton integration for full 3D room-scale VR on Meta Quest, Vision Pro, and SteamVR.
- [ ] **6DoF Physical Spatial Navigation:** Walk through category star systems in true physical room space.
- [ ] **Hand-Tracking & Spatial Gestures:** Pinch-to-inspect, drag-to-connect manual edge linking, and a floating 3D spatial glass HUD for Elarion AI prompts.
