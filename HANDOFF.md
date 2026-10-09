# HANDOFF: pick up here

Written 2026-10-08 at the end of a very long session. **To resume, the owner says "restart" or "pick up the next roadmap item".** Then:
1. Do the startup steps in `CLAUDE.md` (AGENT_CORE.md, registry/connectors.json, ROADMAP.md).
2. Read this file, then `ROADMAP.md` **Phase 10: Idea to Delivery**.
3. Run the health checks below, then start the first unchecked item under "Next up" (below). Say what you are starting in one line, build it, test it, commit, push, deploy.

## Where things stand (live)
- **Portal** `https://lingering-water-de49.klo377.workers.dev`: Worker version `aa8b16b0-1010-48be-af9c-79085af9d1cd`, `main` at `2f0725f`. 1081 tests, `npx tsc` clean.
- **Engine** (`../Aether_Engine`): `main` at `24d80fc`, 135 tests, runs on `localhost:3333` under the watchdog (`scripts/aether-up.ps1`).
- **D1** (`aether_context_db`): migrations 0019 (records + FTS5), 0020 (conversations), 0021 (complete recall) are applied remotely.
- Live index: `records` holds cards, deliverables, blueprints, phase outputs, runs, groups, conversations. Re-sweep: `cd ../Aether_Engine && env -u SUPABASE_JWT_SECRET npm run backfill:records`.

## What exists now (so you do not rebuild it)
| Area | Where |
|---|---|
| Mission Control page + shell (always dark, 6-item rail, Elarion tray above the composer) | `src/mission-control-page.js`, `public/js/engine/mission-control.js` |
| New project dialog: 5 tabs (templates, roadmap templates, Space cards, goal, links), guided intake (target, region, deliverables), page score + Elarion questions, one review, Approve & Run | `public/js/engine/new-project.js`, `roadmap-templates.js`; engine `src/intake.ts` |
| Project journey (plan, map, connections, test, launch, deliver) and Elarion's next question | engine `src/lifecycle.ts` (`GET /api/projects/lifecycle`), `public/js/engine/blueprints.js` (journey card), `workforce.js` `nextAction` (banner) |
| Studio: pan/zoom camera, version history (click to restore), a map for every project, hints + hover focus, connector toolbox, test-fire | `public/js/engine/workflow-console.js`; engine `src/workflows.ts` (versions, `createFromBlueprint`), `src/connectors.ts` |
| Elarion: tray, scope chips, per-project conversation threads stored in D1, context (Studio workflow, project phases + lifecycle), tools `search_records`, `get_record`, `project_status` | `public/js/engine/brain-dock.js`, `elarion-context.js`, `src/conversations.js`; engine `src/masterBrain.ts`, `recordsClient.ts`, `persona.ts` |
| D1 retrieval layer (FTS5, triggers, `/api/records/*`, account sweep) | `migrations/0019-0021`, `src/records.js` |
| Space: rail, ☰ drawer, toolbar of View/Time/Filter/Display/More trays, zoom-to-fit, composer hands messages to Mission Control | `src/index.js` |
| `/share` goes into the New project dialog | `src/share-page.js`, `src/index.js` |

## Next up (in order; the same list is in ROADMAP.md Phase 10)
1. **Run connector actions for real inside workflow runs**, only after an approval node (Telegram + Web request first). The engine runner treats action nodes as "proposed" today (`../Aether_Engine/src/workflows.ts` `startRun`). Connector code is ready: `src/connectors.ts` `runConnectorAction`.
2. **Test-fire a whole workflow**: simulate each step (no sends); optional real model; show the result per node.
3. **Google connection (OAuth)** with tokens kept in the portal D1 (never the browser); Gmail drafts + send from the user's own account (approval by default, per-workflow daily cap, unsubscribe line for marketing), Sheets/Drive, Calendar. `src/google-auth.js` has the sign-in flow to extend; Gmail send is a restricted scope (Google review needed beyond ~100 users).
4. **Google Places lead finder** (API key, not scraping) to a Sheet; email drafts per lead. Do NOT scrape LinkedIn (terms; account bans).
5. **Video channel pipeline**: script, voice (ElevenLabs is in `mcp-config.json`), render, YouTube upload.
6. **The shareable example workflow**: idea to website + videos + leads + outreach, runnable end to end by someone else.
7. **Sharing with other people**: accounts, plans (see the AuditPulse billing layer under `../Aether_Engine/outputs/projects/deploy-bp_ba7a9a2a_1791182033292/` for a tested ledger + Stripe webhook design), onboarding.
8. Elarion as proactive COO: Telegram nudges when a project stalls, weekly status.

## Health checks before you start
```
cd Aether_Portal && npx tsc && npm test          # ~2 minutes: run with a timeout, or in the background
cd ../Aether_Engine && npx tsc --noEmit && npm test
curl -s https://lingering-water-de49.klo377.workers.dev/api/version
```

## Gotchas that cost time this session
- **Stale Windows user variable `SUPABASE_JWT_SECRET`** overrides the engine's `.env`. Any script that signs a token to the portal must run as `env -u SUPABASE_JWT_SECRET npm run ...`. The watchdog already clears it.
- **Restarting the engine**: stop the process listening on port 3333; the watchdog starts it again within ~30 s (`outputs/service/watchdog.log`).
- **Large bash heredocs fail** ("unexpected EOF"). Write the script with the Write tool, then run it. Python edit scripts with exact-match `rep(a, b)` worked well.
- **Space (`src/index.js`) is one huge template string**: no backslashes, backticks or `${}` in the client script. The "client script parses" test guards it. Template changes need a `wrangler dev` restart.
- **Local dev + screenshots**: `npx wrangler dev --port 8788 --persist-to D:/wst` (apply migrations first with `npx wrangler d1 migrations apply DB --local --persist-to D:/wst` while it is stopped). Dev sign-in: `GET /api/auth/dev`.
- **Remote D1**: `npx wrangler d1 migrations apply DB --remote` works; `migrations list` returns error 7403 (ignore).
- **Do not `git add -A`** in Aether_Portal: it has untracked scratch files (`studio-aether-engine/` contains an embedded repo, zips, `fix_part4*.py`). Add paths explicitly. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the session line.
- The workspace-root `PROJECT_STATE.md` is the engine's auto-written forensic log. Do not hand-edit it.
- Tests that count FTS/tag tokens, theme tokens (`theme.spec.js`) and font floors (`a11y-floor.spec.js`: nothing under 12px) are strict. Match their formats.

## The owner's preferences (from this session)
- Talks plainly, no design vocabulary: say what changed and what it does, not jargon. Wants it done, deployed and verified.
- One app feel: Space and Mission Control both always dark, same shell. Minimal, dark, Geist-style.
- Elarion should act like a COO/CEO: know every project's state, say what is next, ask for the one input needed, never act outward (send, spend, publish) without approval.
- $0 fixed-cost ceiling for AuditPulse-style builds; free tiers only.
- Emails from the user's own Google account are wanted, with approval and caps by default.
- Honest limits: no LinkedIn scraping; cold email needs unsubscribe + legal basis.
