# UI Component Specs (Phase 4: Agent Workflow Studio)

These are the build specs for the Phase 4 UI ([ROADMAP.md](../../ROADMAP.md#phase-4-agent-workflow-studio-ui-specs-2026-10-03)).
Each spec says where the component lives, how it looks and behaves, the engine or Worker contract it needs, and what
to test. Nothing here is built yet. Endpoints marked **proposed** don't exist yet on Aether_Engine, the portal Worker
or Miserly.io.

| # | Spec | Surface | Depends on |
| --- | --- | --- | --- |
| 01 | [Visual Node Canvas](01-node-canvas.md): drag-and-drop MCP / A2A / Action cables with data-flow pulses | Mission Control → Studio | Engine run events WebSocket (proposed) |
| 02 | [Case Clearance Spacing](02-case-clearance.md): 20 to 24px edge and diagonal corner offsets | Every surface | none |
| 03 | [Dual-Agent Team Cards](03-team-cards.md): HITL / Auto / Planning modes | Overview workforce, canvas `team` nodes | Engine teams API (proposed) |
| 04 | [Pre-Run Budget Inspector](04-budget-inspector.md): cost pie charts, monthly projection slider | Sheet from Run | Miserly `/api/interrogate` and `/api/manifest` through a portal proxy (proposed) |
| 05 | [Live Browser Streaming](05-live-browser.md): CDP screencast from Playwright | Browser node, team Browser tab, PiP | Engine browser sessions (proposed) |
| 06 | [Recipe Canvases & Vault](06-recipes.md): starter recipes, `aether.recipe/1` export | Studio → Recipes | D1 `0016_recipes.sql` (proposed) |
| 07 | [Connections Hub](07-connections-hub.md): Telegram bot, BYOK, MCP, Advanced Developer Mode | Mission Control → Connections | D1 `0017_user_connections.sql`, `CONNECTIONS_KEY` secret (proposed) |

## Shared rules

- **Design system:** Mission Control surfaces use the DESIGN_SYSTEM.md tokens already in
  `src/mission-control-page.js`, with both light and dark themes. Main-portal surfaces use DESIGN.md System 2.
  Interaction rules from DESIGN.md apply to both:
  - 44pt targets,
  - pointer-down feedback,
  - `cubic-bezier(0.25, 1, 0.5, 1)` over 300ms,
  - reduced motion.
- **New tokens** go on `:root` in `src/mission-control-page.js`, each with a light and a dark value:

  | Token | Light | Dark | Use |
  | --- | --- | --- | --- |
  | `--flow-mcp` | `#16A34A` | `#4ADE80` | MCP Read cables and pulses |
  | `--flow-a2a` | `#2563EB` | `#60A5FA` | A2A Debate cables and pulses |
  | `--flow-action` | `#EA580C` | `#FB923C` | Action cables and pulses |
  | `--case-clear` / `--case-clear-min` | `24px` / `20px` | same | [02](02-case-clearance.md); also added to `src/index.js` |
  | `--chart-1` … `--chart-6` | categorical palette | categorical palette | Budget Inspector slices ([04](04-budget-inspector.md)) |

- **Glow:** only the canvas pulse dots glow (DESIGN.md "Cable pulse glow"). Nothing else in these specs glows.
- **Breaker first:** every surface that runs agents shows the HALTED state, and every run is guarded by the engine's
  circuit breaker.
- **Safety defaults:**
  - New and imported workflows start in **HITL**, and nothing auto-approves.
  - Secrets are encrypted and never sent back to the browser.

## Mission Control navigation after Phase 4

| Rail item | Holds |
| --- | --- |
| Mission Control | Overview and workforce, now including team cards |
| **Studio** | Recipes gallery, Workflow Canvas, Budget Inspector, live browser PiP |
| Elarion | Unchanged |
| Projects | Blueprints (unchanged) |
| Run history | Unchanged, plus estimated vs. actual cost per run |
| **Connections** | Was "Settings". The Hub, with infrastructure behind Advanced Developer Mode |
