# 03 · Dual-Agent Team Cards (HITL · Auto · Planning)

Status: **spec, not built** · Surface: Mission Control → Overview workforce grid and Workflow Canvas `team` nodes ·
Extends: `public/js/engine/workforce.js` cards (DESIGN_SYSTEM.md §3) · Roadmap: Phase 4, Step 4.3

A team card pairs two agents that work one objective together, a **Lead** that does the work and a **Partner** that
challenges and reviews it, joined by an A2A Debate cable ([01](01-node-canvas.md)). The card's mode selector sets how
much autonomy the pair has.

## 1. Anatomy

The card keeps today's workforce card structure and spans two grid columns at ≥1100px:

```
┌──────────────────────────────────────────────────────────────┐
│ (A) Atlas · Lead      ⇄  (Q) Quartz · Partner    [Running]  ⏸ │  header
│ Research the Q4 vendor shortlist                              │  objective
│ ▓▓▓▓▓▓▓▓▓░░░░░  step 4/9 · debate turn 2/3                    │  progress
│ [ HITL | Auto | Planning ]                       Breaker ◉    │  mode + breaker
│ ETA 6m · 9 tasks · $0.042 so far / $0.30 cap                  │  footer
└──────────────────────────────────────────────────────────────┘
```

- **Header:** two avatar badges (the existing `AVATAR_TONES`) joined by a ⇄ glyph in `--flow-a2a`, each with name
  and role. Then the status pill (`PILL_TEXT` / `PILL_KIND`) and the Pause/Resume button. Pause applies to the whole
  team.
- **Objective and progress:** as today, plus the debate turn counter while the pair is debating.
- **Mode selector:** a 3-segment control (segments use `--radius-s`; the selected one uses `--accent-soft` fill and
  `--accent-line` border). It is a `role="radiogroup"` and each segment is a real 44pt target.
- **Breaker switch:** today's individual API breaker toggle, which trips **both** agents.
- **Footer:** ETA, task count, spend so far against this team's per-run cap (from the Budget Inspector,
  [04](04-budget-inspector.md)).
- **Focus:** tapping the card opens the focused view. The current sub-tabs gain **Debate** (the A2A transcript, one
  bubble per turn, Lead left and Partner right) and **Browser** when the team owns a browser node
  ([05](05-live-browser.md)).

## 2. Modes

| Mode | Model calls | MCP Read | Action cables | Typical use |
| --- | --- | --- | --- | --- |
| **HITL** (default for new teams) | yes | runs freely | **pause before every action** for approval | First runs, anything that sends or writes |
| **Auto** | yes | runs freely | run without asking, within the budget cap and breaker | Trusted, repeated recipes |
| **Planning** | yes | runs freely | **locked**: drawn at 30% with a lock glyph, never fire | Agree a plan before acting |

### HITL approvals

- When an Action is about to fire, the card's pill turns **Needs input** (orange) and an approval row slides in:
  the action summary ("Send Telegram to #ops: '…'"), plus **Approve**, **Edit**, and **Deny** with an optional
  reason fed back to the agents.
- The same approval goes to Telegram as inline buttons when a bot is connected ([07](07-connections-hub.md)),
  whichever answer arrives first wins.
- Approvals that go unanswered never auto-approve. After 30 minutes (a setting) the run pauses with
  "Waiting for approval".

### Planning output

- The pair debates and gathers context, then produces a numbered plan, shown as a plan view like the Outcome
  Node plan view (SPATIAL_ARCHITECTURE.md §8.5).
- The plan view's buttons are **Run with HITL**, **Run Auto**, **Revise** (which sends a note into another debate
  turn) and **Discard**.

### Switching modes mid-run

| From → To | Effect |
| --- | --- |
| Auto → HITL | Immediate; the next Action waits for approval |
| HITL → Auto | Confirmation dialog ("Atlas and Quartz will act without asking, up to $0.30 per run."), then immediate |
| Any → Planning | Takes effect at the next action boundary; queued actions are cancelled and listed |
| Planning → Auto | Requires an approved plan; otherwise the Auto segment is disabled, with a tooltip saying why |

The current mode is sent with every step. The engine, not just the UI, enforces it: an Action request in Planning
mode is refused server-side.

## 3. Debate settings (card menu ⋯ and canvas inspector)

| Setting | Values | Notes |
| --- | --- | --- |
| Rounds | 1 to 5 (default 2) | More rounds raise the budget estimate, live in [04](04-budget-inspector.md) |
| Partner stance | Reviewer · Devil's advocate · Domain expert | Picks the Partner's system prompt |
| Tie-break | Lead decides · Ask me | "Ask me" uses the HITL approval row |
| Models | inherit · BYOK override per agent | [07](07-connections-hub.md); default `miserly-auto` |

## 4. Proposed engine contract

- `POST /api/teams` `{ lead, partner, objective, mode, rounds, stance, tiebreak }` returns `{ team_id }`
- `PATCH /api/teams/:id` `{ mode }` returns the updated team; returns 409 when Planning → Auto has no approved plan
- `POST /api/teams/:id/approvals/:approvalId` `{ decision: "approve" | "edit" | "deny", edited?, reason? }`
- Run events arrive on `ws /api/runs/:runId/events` ([01](01-node-canvas.md) §4), with `approval_needed` and
  `debate_turn` frames.

## 5. Phones

- The card is one column wide, and the agent names collapse to their avatars plus role.
- The mode selector stays full-width. Below 360px it shows short labels (HITL / Auto / Plan).
- The approval row docks to the bottom of the screen, with Case Clearance ([02](02-case-clearance.md)).

## 6. Tests

- Mode matrix: which cables can fire in each mode.
- Mid-run switching rules, including the 409 path.
- An approval resolves only once when the card and Telegram both answer.
- Breaker trips both agents.
- radiogroup keyboard behaviour (arrow keys).
