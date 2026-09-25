# Aether Portal — Pipeline & Memory Update (MU)

## ?? Active Architecture & System State
- **Production URL:** https://lingering-water-de49.klo377.workers.dev
- **Environment:** Cloudflare Workers + D1 (aether_context_db) + Gemini 3.x API
- **Active Model Fallback Chain:** gemini-3.8-flash -> gemini-3.7-flash -> gemini-3.5-flash-lite
- **Background Automation:** Daily CRON (0 0 * * * at midnight UTC) running src/miner.js
- **Live Version:** 15b98cf5-9e3d-433e-ad09-e83c6c90c6fe (commit 15a9833, deployed 2026-09-25)

## Shipped
- [x] **Focus Card Carousel View** - Fifth view in the view switch: filtered nodes as a centered card deck with a scaled/faded depth stack, touch and mouse swiping (left = next, right = previous), arrow keys and prev/next buttons. Selecting a node in the 2D/3D map can open the deck focused on that node. Commit 15a9833, live on Cloudflare Workers as version 15b98cf5.
- [x] **Flat Node-Based Editor Mode (2D Canvas Toggle)** - Toggle button to flatten the Z-axis, align nodes into organized 2D rows/grids (like N8N / ComfyUI / node editors), and lock camera orbit to 2D pan/zoom. Shipped as the 2D Canvas toggle: nodes pinned to z = 0, categories on a 4-column grid, rotation off and left-drag pans.
- [x] **1-Hop Neighborhood Focus Walker** - Clicking a node dims everything except its direct 1st-degree connections. Shipped: selecting a node keeps it and its direct neighbours at full opacity and dims the rest.
- [x] **Orphan Node Toggle** - Hide unlinked singletons to clean up floating noise. Shipped as "Hide Unlinked" in the Filters popover.

## ?? Active Feature Pipeline (Next Steps)

### Immediate Next Step:
- [ ] **YouTube Transcript Pipeline (`/api/transcript`)** - Endpoint that fetches the transcript for a saved YouTube node so its full spoken content can feed Gemini summaries, clustering and Ask.
- [ ] **Web Fetcher (`/api/web-fetch`)** - Endpoint that fetches and extracts the readable text of a saved web link so its content (not just title and preview metadata) is available to AI enrichment.

### Upcoming UI Milestones:
- [ ] **Camera Centroid Fly-To** - Tapping a category in the legend smoothly glides the camera directly to that cluster's central anchor. Partly done: tapping a cluster's floating label on the canvas already flies to its centre and opens the cluster drawer; tapping a category in the legend still only toggles its highlight.
