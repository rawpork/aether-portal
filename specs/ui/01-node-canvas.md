# 01 · Visual Node Canvas (agent workflows)

Status: **built in part** (Step 4.1b: Workflow console with trigger, agent, MCP, action and human nodes and polled run events; ROADMAP.md lists what is not built yet) · Surface: Mission Control → **Studio** (new rail item) · Roadmap: Phase 4, Step 4.1

A 2D canvas where a user builds an agent workflow by placing nodes and dragging cables between their ports.
While a workflow runs, each piece of traffic along a cable shows as a coloured pulse travelling from source to
target.

> Not the knowledge graph's "2D Canvas" toggle (SPATIAL_ARCHITECTURE.md §3). That one flattens saved nodes. This one
> edits workflows. Code and copy call it the **Workflow Canvas** to keep the two apart.

## 1. Nodes

| Kind | Purpose | Ports |
| --- | --- | --- |
| `trigger` | Starts a run: manual, schedule, Telegram message, webhook | out: `start` |
| `agent` | One model-backed agent (role, prompt, model override, max tokens) | in: `start`, `context` · out: `mcp`, `a2a`, `act` |
| `team` | A Dual-Agent Team ([03](03-team-cards.md)); drawn as one node with two avatar badges | same as `agent` |
| `mcp` | An MCP server from the Connections Hub ([07](07-connections-hub.md)); lists its enabled tools | in: `read`, `act` |
| `action` | A side effect: send Telegram, write file, create portal node, HTTP POST, browser step | in: `act` |
| `browser` | A Playwright browser session ([05](05-live-browser.md)) | in: `act` · out: `observe` (MCP Read) |
| `human` | A HITL checkpoint: waits for approve / edit / deny | in: `act` · out: `start` |

Node card: 240px wide, `--surface` with a 1px `--line` hairline and `--radius-l`. The header row has the kind icon,
label, and a status pill using the DESIGN_SYSTEM.md §2 pills. The body shows one line of config summary. Ports sit on
the card edge as 12px dots inside 44px hit areas: inputs on the left, outputs on the right, each labelled on hover and
focus. A selected node gets a 1px `--accent` border. There is no shadow except while the node is being dragged.

## 2. Cables

A cable's kind is decided by the pair of ports it joins, never picked by hand:

| Kind | Colour token (light / dark) | Joins | Line | Meaning |
| --- | --- | --- | --- | --- |
| **MCP Read** | `--flow-mcp` `#16A34A` / `#4ADE80` (green) | agent `mcp` → mcp `read`, browser `observe` → agent `context` | solid 2px | Read-only tool calls and resources (MCP `readOnlyHint: true`) |
| **A2A Debate** | `--flow-a2a` `#2563EB` / `#60A5FA` (blue) | agent `a2a` ↔ agent `a2a` | double 2px rail, no arrowhead (bidirectional) | Agent-to-agent messages: debate turns, critique, hand-off |
| **Action** | `--flow-action` `#EA580C` / `#FB923C` (orange) | agent `act` → mcp `act` / action / browser / human | solid 2px with an arrowhead and a bolt glyph at the midpoint | Anything with side effects (MCP tools without `readOnlyHint`, every `action` node) |

- **Colour is never the only signal.** Each kind also has its own line style and glyph, and the cable's
  accessible name says the kind ("Action cable from Atlas to Send Telegram").
- **Contrast:** the light-theme values meet 3:1 against `--surface` `#FFFFFF` (WCAG 1.4.11, non-text). The dark
  values meet 3:1 against `#18181B`.
- **These are data colours, not accents.** They stay separate from the violet `--accent`, which still marks only
  selection. Action orange matches the "Needs Input" pill family on purpose: an Action waiting in HITL mode *is* the
  thing that needs input.
- **Geometry:** cubic Bézier with horizontal tangents (`dx = max(60, |x2 − x1| / 2)`). A2A cables between team
  members are drawn as a short arc inside the team node.
- **Selection:** a selected cable thickens to 3px and shows a delete handle at the midpoint.

## 3. Connecting (drag and drop)

- **Mouse:** press on an output port and drag. A ghost cable follows the pointer. Compatible input ports grow to
  16px, and incompatible ones fade to 30%. Release on a port to connect, or anywhere else to cancel.
- **Touch:** long-press a port for 350ms (the same threshold as the Board drag in ROADMAP_MASTER.md Phase 3), then
  drag. A quick swipe still pans the canvas.
- **Keyboard and assistive tech:** focus a port and press Enter to open "Connect to…", a list of compatible ports by
  node. Delete or Backspace removes a selected cable.
- **Refused drops:** the port shakes (2 × 4px, 200ms) and an inline tip says why ("An MCP server can't start a
  debate. Connect it from an agent's MCP port."). Under reduced motion there is no shake.
- **Rules:** no self-loops; at most one A2A cable per agent pair; Action cables cannot form a cycle without a
  `human` node in the loop (no unattended action loops).
- **Nodes:** dragged by the header, snapping to an 8px grid. Positions are saved with the workflow (see
  [06](06-recipes.md)).
- **Canvas:** wheel or pinch to zoom (25% to 200%); drag empty space or press Space and drag to pan;
  double-click or double-tap empty space to fit everything, like the graph's camera reset.

## 4. Data-flow pulses (live runs only)

Each engine flow event animates one pulse along its cable:

- The pulse is a 6px dot in the cable colour, travelling from source to target over 600ms with
  `cubic-bezier(0.25, 1, 0.5, 1)`. A2A pulses travel in the direction of the message.
- **Glow:** the dot carries a soft radial halo in its own colour, at most 14px radius and 45% opacity. That halo is
  the only glow on this surface. Nodes, ports and resting cables never glow. See
  [DESIGN.md → Cable pulse glow](../../DESIGN.md#cable-pulse-glow-mission-control-workflow-canvas-requested-2026-10-03).
- **Coalescing:** at most 3 pulses on a cable at once. Extra events add to a count badge on the cable ("+12") instead
  of spawning more dots.
- **Badges:** after a pulse lands, the target port shows a 1.5s tooltip-style badge with a short summary ("read
  3 rows", "turn 2/3", "sent message"). Hovering or tapping the cable lists its last 20 events.
- **Reduced motion:** nothing travels. The cable steps to 3px for 300ms, then back.
- **Halted runs:** on a breaker trip every pulse freezes where it is and fades to 30%, the cables turn grey, and a
  HALTED banner sits over the canvas until a reset.

### Proposed engine contract

`ws /api/runs/:runId/events` (bearer subprotocol auth, like `/api/voice/stream`) sends:

```json
{ "type": "flow", "cable_id": "c_12", "kind": "mcp_read", "from": "n_agent_1", "to": "n_mcp_2",
  "ts": 1791044878123, "summary": "read 3 rows", "tokens": 412, "cost_usd": 0.0009 }
```

`kind` is one of `mcp_read`, `a2a`, `action`. Other frame types include `node_status` (running, waiting, done,
failed), `approval_needed` and `halted`. The portal maps events to cables by `cable_id`. Events for unknown cables
are logged and dropped.

## 5. Rendering and performance

- Nodes are DOM elements. Cables and pulses are drawn in one SVG layer below the nodes, all inside one transformed
  container for pan and zoom.
- Pulses animate a single `requestAnimationFrame` loop that writes `transform` on pooled dot elements. There are no
  CSS animations per pulse.
- Budget: 60fps with 100 nodes, 200 cables and 50 active pulses on a mid-range phone. Rendering pauses while the
  tab is hidden.

## 6. Phones (≤ 600px)

- The canvas is full screen, and the node palette becomes a bottom sheet.
- Corner controls (zoom, fit, Run) follow the Case Clearance rules in [02](02-case-clearance.md).
- Editing works, but phones default to **view and run**: the "Edit" toggle stays off until the user taps it, so a
  stray touch can't rewire a workflow.

## 7. Tests (happy-dom)

- Port compatibility matrix and cable kind derivation
- Refused-drop messages and the action-loop rule
- Keyboard "Connect to…" flow
- Pulse coalescing cap
- Reduced-motion branch
- Halted freeze
