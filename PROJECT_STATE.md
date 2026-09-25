# Project State

## Active step
Legend fly-to and Focus Card Carousel view shipped and live (2026-09-25)

### Latest deployment
- Commit `26281e0` - feat: legend category click flies the camera to its cluster (pushed to `main`).
- Deployed to Cloudflare Workers as `lingering-water-de49`, version `8b44f780-525c-481e-9237-1f76ed4f805a`: https://lingering-water-de49.klo377.workers.dev
- Clicking a category in the legend highlights it and flies the camera to its cluster centre, reusing the fly-to from tapping a cluster label on the canvas. Clicking it again clears the highlight without moving the camera.
- The fly-to needs the cluster territories, which depend on three.js loading; if it fails to load, the legend click only highlights.
- Not yet checked by hand in a real browser after deploy.

### Previous deployment: Focus Card Carousel
- Commit `15a9833` - feat: add swipeable Focus Card Carousel view alongside 2D/3D map.
- Deployed as version `15b98cf5-9e3d-433e-ad09-e83c6c90c6fe`, now superseded by `8b44f780`.
- Carousel is a fifth view in the top-bar view switch (Graph / List / Timeline / Board / Carousel): the filtered nodes as a centered card deck with a scaled, faded depth stack behind the top card.
- Touch and mouse swiping (left = next, right = previous), plus prev/next buttons, a position counter and arrow keys; tapping the top card opens the regular node card.
- Selecting a node in the 2D/3D map and choosing "Carousel" (node card button or view switch) opens the deck on that exact node.
- The 2D/3D force simulation and graph rendering are unchanged; the deck hooks in through the existing view switching.
- Not yet checked by hand in a real browser after deploy: swipe feel, stack visuals and the phone layout.

### Next up
- YouTube Transcript Pipeline (`/api/transcript`) and Web Content Fetcher (`/api/web-fetch`); see [ROADMAP.md](ROADMAP.md).

## Previous milestone
Phase 3 complete: Gemini 2.5 Flash API + rainbow clustering

### Current status
- Cloudflare Worker is running from [src/index.js](src/index.js) with D1 persistence configured in [wrangler.jsonc](wrangler.jsonc).
- Telegram ingestion and the `/api/graph` graph feed are active.
- A new `/api/recluster` endpoint passes generic node records through Gemini for title/category normalization and D1 updates.
- The 3D graph now uses an HSL rainbow scale for node coloring, so related clusters glow across a color spectrum.

### Completed implementation
- Added Gemini-based analysis helper for AI title/category classification.
- Added `/api/recluster` to reprocess weakly classified saved nodes.
- Updated node rendering to calculate hue from each node’s identity and group, producing a rainbow cluster effect.

### Guardrails
- Keep worker calls bounded and fail-safe when the AI key is absent.
- Validate Gemini responses before writing to D1.
- Preserve the existing Telegram + graph flow while using AI enrichment as a second-pass normalization layer.
