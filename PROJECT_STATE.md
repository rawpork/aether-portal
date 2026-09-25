# Project State

## Active step
YouTube Transcript Pipeline live: `/api/transcript` and the node-card Transcript section (2026-09-25)

### Latest deployment
- Commit `899f1e3` - feat: Transcript section on YouTube node cards (pushed to `main`).
- Deployed to Cloudflare Workers as `lingering-water-de49`, version `b9fc0089-2f91-4771-b159-fd60f54333c9`: https://lingering-water-de49.klo377.workers.dev
- Node card "Transcript" section for YouTube nodes: shows the stored synopsis, a "Get Transcript" / "Refresh" button that calls `POST /api/transcript`, and "Read Transcript", which loads the text on demand and opens it in the full reader.
- `/api/graph` now includes each node's `synopsis` and a `has_transcript` flag, so the synopsis shows without downloading the transcript.
- Not yet tried in a browser: first real test is pressing Get Transcript on a YouTube node, which is also the first live run of the Gemini synopsis.

### Transcript endpoint (commit `69aa68e`, first live in version `09267be9`)
- Migration `0011_transcripts.sql` (commit `1d9c280`) added `raw_transcript` and `synopsis` to `saved_nodes`; applied to remote D1.
- `POST /api/transcript {id, refresh?}` fetches a YouTube node's captions from the YouTube player API (Android, then iOS client), saves them to `raw_transcript`, and saves a Gemini synopsis to `synopsis`. With no captions, Gemini watches the video by URL for the synopsis. Stored results are reused unless `refresh` is true.
- `GET /api/transcript?id=` returns what is stored. Both need a signed-in session and only reach the user's own nodes.
- Verified: captions fetched from Cloudflare's network for three test videos (217 to 18,430 characters). Not yet exercised end to end with a signed-in session, and the Gemini synopsis and video fallback have not run live.

### Earlier deployments (2026-09-25)
- `8b44f780` (commit `26281e0`): clicking a legend category highlights it and flies the camera to its cluster centre.
- `15b98cf5` (commit `15a9833`): Focus Card Carousel view, a fifth view with a swipeable card deck; a node selected in the 2D/3D map can open the deck on that node.

### Next up
- Web Content Fetcher (`/api/web-fetch`); see [ROADMAP.md](ROADMAP.md).

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
