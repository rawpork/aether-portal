# Aether Portal — Pipeline & Memory Update (MU)

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
