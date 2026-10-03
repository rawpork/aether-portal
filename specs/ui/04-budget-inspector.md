# 04 · Pre-Run Workflow Budget Inspector

Status: **spec, not built** · Surface: a sheet that opens from the Workflow Canvas **Run** button and from a team
card's ⋯ menu · Depends on: Miserly.io `/api/interrogate` and `/api/manifest` · Roadmap: Phase 4, Step 4.4

Before a workflow runs, the inspector shows what one run should cost, where the money goes, and what a month of runs
adds up to, while the user can still change the plan.

## 1. When it shows

- **Run** on the canvas opens the inspector first. Its primary button is **Run now**.
- "Skip for runs under $0.05" is a per-browser setting (`aether.budget.skipUnder`), off by default.
- It always shows for **Auto** mode ([03](03-team-cards.md)) and whenever an estimate exceeds a cap (§5).
- It can also be opened on its own as "Inspect budget" to plan without running.

## 2. Where the numbers come from

All estimates are **local maths over Miserly's own routing and prices**, so the inspector and the gateway agree:

1. For every agent or team node, the portal builds the Messages request that node would send (system prompt, the
   upstream context it receives, tools, `max_tokens`).
2. It sends each request to **`POST /api/budget/estimate`**, a new portal Worker route. That route forwards the
   requests to Miserly `POST /api/interrogate`, which is a free dry run with no model call. It returns, per node,
   `{ tier, estimated_input_tokens, score }`.
   - The Worker uses the user's tenant key when Aether holds one.
   - Otherwise it uses `miserly_free_sandbox`, which Miserly accepts on `/api/interrogate`.
   - Proxying is required: Miserly sends no CORS headers, and the key must not reach the browser.
3. Prices come from Miserly `GET /api/manifest` → `tiers[].pricing_usd_per_mtok` (public, cached 1 hour).
4. For each node:
   - `calls` = 1 for an agent, or `rounds × 2 + 1` for a team (each debate turn, plus the Lead's final answer).
     Each MCP Read round-trip adds one call when the node's average tool calls per run is set.
   - **Expected** = `calls × (est_input × in_rate + expected_output × out_rate)`, where
     `expected_output = 0.35 × max_tokens`. That factor is a setting, labelled as an assumption.
   - **Ceiling** = `calls × (est_input × max(in_rate, cache_write_rate) + max_tokens × out_rate) × 1.2`. This is
     the same worst case as Miserly's `estimateWorstCaseCost`, so the inspector's ceiling is what the SafetyLedger
     will reserve.
   - **Baseline** = the expected cost if the node always ran on Miserly's `baseline_tier` (premium). Savings =
     baseline − expected.
5. Action and browser nodes are $0 in model cost. Browser nodes add the agent calls that drive them.

Estimates refresh with a 300ms debounce whenever the graph or a node setting changes. The slider (§4) never calls
the network.

## 3. Cost breakdown: pie chart

- **One donut chart** (a pie with a 60% hole) of the **expected** cost per run. The centre shows the total
  ("$0.042 per run") and, below it, the ceiling in muted text ("up to $0.11").
- A **Group by** segmented control switches between **Node** (default), **Model tier** (frugal / balanced /
  premium) and **Cable kind** (MCP Read / A2A Debate / Action, coloured `--flow-*`).
- Slice rules:
  - At most 6 slices: the 5 largest plus "Other". Slices under 2% merge into Other.
  - Slices are sorted clockwise from 12 o'clock, largest first.
  - Slices are separated by a 1px `--surface` gap.
- **Colours:** Node and Tier groupings use a fixed 6-colour categorical palette defined as tokens
  (`--chart-1` … `--chart-6`) with light and dark values, checked for distinctness. "Other" is always `--faint`.
  Cable kind uses the cable colours.
- **Interaction:**
  - Hovering or tapping a slice raises it 4px outward, shows a tooltip ("Atlas + Quartz · $0.021 · 50% ·
    balanced"), and highlights that node on the canvas behind the sheet.
  - Tapping the same slice again pins the highlight.
  - Every slice is a focusable `role="img"` with an `aria-label`. Arrow keys move between slices.
- **Legend and table:**
  - A legend to the right (below on phones) lists every slice with its value and share, and is clickable like the
    slices.
  - A **Table** toggle swaps the chart for a full per-node table: node, tier, calls, expected input and output
    tokens, expected, ceiling, baseline, saved.
  - The table is the accessible fallback and the source for **Copy CSV**.
- No 3D, no exploded slices at rest, no gradients, no shadows. Under reduced motion, slice raise and transitions are
  instant.

## 4. Monthly run projection

- A **Runs per month** slider snaps to 1, 5, 10, 25, 50, 100, 250, 500 and 1,000 (log-spaced), with a number field
  beside it for exact values. Default: the recipe's `budget.runs_per_month` ([06](06-recipes.md)), or 30.
- Below it, a horizontal bar compares:
  - **Expected per month** (solid), **ceiling per month** (hatched extension) and **baseline per month** (outline
    marker), each labelled in $.
  - **The cap line**, the nearest applicable limit:
    - the Miserly tenant plan's monthly cap (`GET /api/billing/status` → `spend.cap_usd`, via the portal Worker),
    - or the trial cap while trialing,
    - or Miserly's global monthly budget for operator keys (`/api/safety`, operator only).
  - If none of these is known, there is no cap line.
- Under the bar: "≈ $1.26 per month · saves $3.78 (75%) against always using premium · 4% of your Growth cap".
  The percentage uses Miserly's definition (savings vs. the baseline tier), so it lines up with the `x-miserly-savings`
  header the runs will later report.
- The slider's track uses `--accent` up to the thumb. The thumb is a 28px circle inside a 44pt hit area.

## 5. Guardrails

| Condition | Effect |
| --- | --- |
| Ceiling per run > the per-request ceiling (Miserly `max_request_cost_usd`) for any node | That node is flagged red in the table, with "Lower max tokens" as an inline fix. **Run now** is disabled. |
| Expected per month > the cap line | Amber warning. Run is still allowed, since a single run is fine. |
| Ceiling per run > the team's per-run cap | **Auto** cannot start, but **HITL** can. |
| Sandbox key in use | Banner: "Sandbox: estimates are real, runs are mocked at $0". **Run now** runs against the sandbox. |
| Estimate request failed | Shows the last good estimate marked "stale", plus Retry. Never blocks a HITL run. |

Each run stores its estimate (expected and ceiling) with the run. The run's result card then shows **estimated
vs. actual**, with actuals from Miserly's `x-miserly-cost` and the D1 usage log.

## 6. Layout

- **Desktop:** a right-side sheet, 480px wide, over the canvas. The donut, legend and Group-by control sit at the
  top, the projection below, and the guardrail list and Run now at the foot.
- **Phones:** a full-height bottom sheet with the donut at 200px. The legend and table sit under it, and Run now is
  pinned to the bottom with Case Clearance ([02](02-case-clearance.md)).

## 7. Tests

- Estimate maths:
  - the ceiling equals Miserly `estimateWorstCaseCost` for the same inputs,
  - team call counts,
  - the Other merge.
- Group-by switching keeps the totals equal.
- The slider snaps to its steps and the number field accepts exact values.
- Each cap-line source, and the case where no cap is known.
- Each guardrail state, and stale estimates.
- Table and CSV match the chart.
