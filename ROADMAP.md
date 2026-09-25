# Aether Portal — Pipeline & Memory Update (MU)

## ?? Active Architecture & System State
- **Production URL:** https://lingering-water-de49.klo377.workers.dev
- **Environment:** Cloudflare Workers + D1 (aether_context_db) + Gemini 3.x API
- **Active Model Fallback Chain:** gemini-3.8-flash -> gemini-3.7-flash -> gemini-3.5-flash-lite
- **Background Automation:** Daily CRON (0 0 * * * at midnight UTC) running src/miner.js

## ?? Active Feature Pipeline (Next Steps)

### Immediate Next Step:
- [ ] **Flat Node-Based Editor Mode (2D Canvas Toggle)** - Toggle button to flatten the Z-axis, align nodes into organized 2D rows/grids (like N8N / ComfyUI / node editors), and lock camera orbit to 2D pan/zoom.

### Upcoming UI Milestones:
- [ ] **1-Hop Neighborhood Focus Walker** - Clicking a node dims everything except its direct 1st-degree connections.
- [ ] **Orphan Node Toggle** - Hide unlinked singletons to clean up floating noise.
- [ ] **Camera Centroid Fly-To** - Tapping a category in the legend smoothly glides the camera directly to that cluster's central anchor.
