# Aether Portal: agent instructions

Read `CLAUDE.md` in this folder first; it holds the startup steps, the handoff rule and the model policy. The two files must not disagree.

## Project root and dev server
- **Primary project root:** `D:\TitainSolutions_MD\AI_Projects\Proprietary\Aether_Portal`. Run project commands (`npm test`, `npx tsc`, `npx wrangler ...`) from here.
- **Default dev server:** `npx wrangler dev --port 8787` (http://localhost:8787, dev operator sign-in via `DEV_AUTH_BYPASS` in `.dev.vars`). Restart it after changing `src/*.js` page templates or `wrangler.jsonc`; JavaScript under `public/` loads live.
- If you run a second dev server for testing, use another port and a short `--persist-to` path (for example `D:/wst`): a long path breaks local Durable Objects on Windows.

## Where things are
- Plan and status: `PHASE2_PLAN.md` (Phase 10, realtime), `ROADMAP.md`, `PROJECT_STATE.md`.
- Engine contract: `ENGINE_REALTIME_CONTRACT.md`. The engine is the sibling repo `..\Aether_Engine`.
- Tests: `npm test` (vitest, all projects) and `npx tsc`; both should pass before a commit.
