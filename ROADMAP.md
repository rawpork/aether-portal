# Aether Portal — Pipeline & Memory Update (MU)

## ?? Active Architecture & System State
- **Production URL:** https://lingering-water-de49.klo377.workers.dev
- **Environment:** Cloudflare Workers + D1 (aether_context_db) + Gemini 3.x API
- **Active Model Fallback Chain:** gemini-3.8-flash -> gemini-3.7-flash -> gemini-3.5-flash-lite
- **Background Automation:** Daily CRON (0 0 * * * at midnight UTC) running src/miner.js
- **Live Version:** b9fc0089-2f91-4771-b159-fd60f54333c9 (commit 899f1e3, deployed 2026-09-25)

## Shipped
- [x] **Focus Card Carousel View** - Fifth view in the view switch: filtered nodes as a centered card deck with a scaled/faded depth stack, touch and mouse swiping (left = next, right = previous), arrow keys and prev/next buttons. Selecting a node in the 2D/3D map can open the deck focused on that node. Commit 15a9833, live on Cloudflare Workers as version 15b98cf5.
- [x] **Flat Node-Based Editor Mode (2D Canvas Toggle)** - Toggle button to flatten the Z-axis, align nodes into organized 2D rows/grids (like N8N / ComfyUI / node editors), and lock camera orbit to 2D pan/zoom. Shipped as the 2D Canvas toggle: nodes pinned to z = 0, categories on a 4-column grid, rotation off and left-drag pans.
- [x] **1-Hop Neighborhood Focus Walker** - Clicking a node dims everything except its direct 1st-degree connections. Shipped: selecting a node keeps it and its direct neighbours at full opacity and dims the rest.
- [x] **Orphan Node Toggle** - Hide unlinked singletons to clean up floating noise. Shipped as "Hide Unlinked" in the Filters popover.
- [x] **Camera Centroid Fly-To** - Tapping a category in the legend smoothly glides the camera directly to that cluster's central anchor. Shipped: tapping a category in the legend highlights it and flies the camera to its cluster centre (the same fly-to as tapping a cluster label on the canvas); tapping it again clears the highlight without moving the camera.
- [x] **YouTube Transcript Pipeline (`/api/transcript`)** - POST fetches a YouTube node's captions into raw_transcript and saves a Gemini synopsis (Gemini watches the video when there are no captions); GET returns the stored values. Migration 0011, endpoint commit 69aa68e. The node card Transcript section (synopsis, Get Transcript / Refresh, Read Transcript) shipped in commit 899f1e3, live as version b9fc0089.

## ?? Active Feature Pipeline (Next Steps)

### Immediate Next Steps (Backend):
- [ ] **Web Content Fetcher (`/api/web-fetch`)** - Endpoint that fetches and extracts the readable text of a saved web link so its content (not just title and preview metadata) is available to AI enrichment.
