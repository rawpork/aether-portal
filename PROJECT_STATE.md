# Project State

## Active step
Web Content Fetcher, PWA share sheet and Google sign-in deployed (2026-09-25); Google sign-in and the Claude tier wait on secrets

### Latest deployment
- Commit `5a86f9c` - feat: web content fetcher, PWA share sheet, Google sign-in (pushed to `main`).
- Deployed to Cloudflare Workers as `lingering-water-de49`, version `3021e7f0-8cbe-49b0-a64f-a3900450598d`: https://lingering-water-de49.klo377.workers.dev
- Migration `0012_web_content_google_auth.sql` applied to remote D1: `saved_nodes.content`, `users.email`, `users.google_sub`, `users.tier` (default `free`).
- Static assets: `public/` (manifest, service worker, icons) served through the `assets` setting in `wrangler.jsonc`.

#### Web Content Fetcher (`src/webfetch.js`)
- `POST /api/web-fetch {url?, nodeId?}` fetches a page with a desktop User-Agent, strips scripts, styles, nav, header and footer, and returns `{ success, content }` as Markdown-style text; with `nodeId` it saves to `saved_nodes.content`. `GET /api/web-fetch?id=` returns the stored text.
- Link cards (not YouTube, notes or images) show "Fetch Web Content", which opens the text in the full reader, then "Read Web Content".
- Private and local addresses are refused. Checked locally on Wikipedia and a Cloudflare blog post.
- The daily miner now adds the first 200 characters of a node's page text or synopsis to its prompt.

#### PWA share sheet (`/share`, `src/share.js`, `src/share-page.js`)
- `public/manifest.json` registers a GET `share_target` at `/share` (`url`, `title`, `text`); a minimal service worker makes the app installable. Android only; iOS Safari has no share targets.
- The sheet shows a link preview, model tier (Gemini Flash, Gemini Pro via `gemini-3.1-pro-preview` with Flash fallback, Claude Sonnet via `claude-sonnet-5`), action presets (Summarize, Event, Branch, Action Task) and a `/` command input.
- "Ingest to Aether" posts to `POST /api/share`, which saves the node to the inbox (Action Task goes to Active) and answers at once; metadata, page text and the preset run in the background, and the result is saved as a research entry on the node.
- Signed-out visitors are sent to sign in and then back to the share sheet.

#### Google sign-in (`src/google-auth.js`)
- `GET /api/auth/google` starts the OAuth 2.0 PKCE redirect flow (`openid email profile`); `POST /api/auth/google` takes a One Tap credential; `GET /api/auth/callback` finishes the redirect. ID tokens are verified against Google's keys.
- Accounts match by Google id, then by email. New accounts are created only for addresses in `GOOGLE_ALLOWED_EMAILS` (`@domain` allows a whole domain), on the free tier. The admin users endpoint accepts `email` to link an existing account.
- Sessions use the existing HTTP-only signed session cookie.
- The signed-out screen is an Apple-style card with "Sign in with Google", One Tap, and the username/password form below.

#### Setup still needed
- Google Cloud OAuth web client with the production origin and `/api/auth/callback` redirect URI, then `wrangler secret put` for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_ALLOWED_EMAILS`. Until then the Google button is hidden.
- `ANTHROPIC_API_KEY` secret to enable the Claude Sonnet tier (greyed out until set).
- Link the owner account's email through `POST /api/auth/users`.

#### Not yet exercised live
- Share-sheet presets on any model tier, Gemini Pro, the Claude call, real Google sign-in and One Tap, installing and sharing on Android. The transcript synopsis from the previous release has not run live either.

### Earlier deployments (2026-09-25)
- `b9fc0089` (commit `899f1e3`): Transcript section on YouTube node cards; `/api/graph` carries `synopsis` and `has_transcript`.
- `09267be9` (commit `69aa68e`): `/api/transcript` YouTube Transcript Pipeline, with migration `0011_transcripts.sql` (`raw_transcript`, `synopsis`).
- `8b44f780` (commit `26281e0`): clicking a legend category highlights it and flies the camera to its cluster centre.
- `15b98cf5` (commit `15a9833`): Focus Card Carousel view, a fifth view with a swipeable card deck; a node selected in the 2D/3D map can open the deck on that node.

### Next up
- Finish the setup above, then test the share sheet on Android and Google sign-in end to end; see [ROADMAP.md](ROADMAP.md).

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
