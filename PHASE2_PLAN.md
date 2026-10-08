# Phase 2 Plan: Real-Time WebSockets and Durable Object State Sync

Status: **R0 signed off by the owner 2026-10-07** (plan drafted the same day on `main` at `636cf91`). `public/js/realtime-protocol.js` and `test/realtime-protocol.spec.js` exist (section 2.5); the engine-side contract is in [ENGINE_REALTIME_CONTRACT.md](ENGINE_REALTIME_CONTRACT.md) and still needs Aether_Engine's acceptance before R4. R1 to R6 are not started.

## 0. Naming

"Phase 2" is already used twice in this repo: [ROADMAP.md](ROADMAP.md) says "Phase 2 complete" for the engine IPC gateway, and
[ROADMAP_MASTER.md](ROADMAP_MASTER.md) has "Phase 2: Enhanced Visualization" (in progress). This work is called **Phase 2 (Realtime)**
in conversation; in the roadmap files it should take the next free number (Phase 10) unless the owner decides otherwise.

## 1. Where things stand (before this phase)

- **Space live sync is one-way Server-Sent Events.** `src/graph-events.js`: one `GraphEvents` Durable Object per user holds that user's open
  streams in memory; the Worker publishes to it after a successful write (`graphEventFor` maps method and path to one of nine event types:
  `node.created|updated|deleted`, `link.created|updated|deleted`, `group.updated`, `settings.updated`, `graph.changed`). Space
  (`src/index.js`, `EventSource('/api/events')`) reloads the graph in place and closes the stream while the tab is hidden. Tests:
  `test/graph-events.spec.js`.
- **Gaps:** no sequence numbers, so a dropped stream loses events; no replay; no presence; a `setInterval` heartbeat keeps the object awake;
  nothing is stored; events flow to the browser only.
- **Mission Control polls everything:** breaker 5 s (30 s offline), tasks and workforce 2 to 5 s, decision banner 4 s, operator console, roadmap
  every minute.
- **The engine's only WebSocket is voice** (`/api/voice/stream`, direct to the engine). The engine relay (`src/engine-relay.js`) refuses
  `/api/voice/` and any WebSocket, because the Worker cannot reach the operator's localhost.
- **Open roadmap decision:** "Engine contracts (runs WebSocket, teams, approvals, browser sessions): agree them with Aether_Engine"
  ([ROADMAP.md](ROADMAP.md), Phase 4 open decisions).
- The Durable Object migration `v1` registered `GraphEvents` as a SQLite-backed class (`wrangler.jsonc`), so storage is available to a hub.

## 2. Architecture

### 2.1 Hub: one hibernating WebSocket Durable Object per user

- New class `UserHub` (new migration tag `v2`; `GraphEvents` stays until R6). Uses the **WebSocket Hibernation API**
  (`state.acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `setWebSocketAutoResponse` for ping/pong) so an idle hub costs nothing and
  needs no timer.
- Addressed by `idFromName(userId)`, the same naming as today. Upgrade at `GET /api/realtime` (`Upgrade: websocket`).
- **Auth:** the existing session cookie, checked in the Worker before the upgrade is forwarded; reject a missing or foreign `Origin`.
  Per-connection caps: message size (4 KB), messages per second, connections per user (8).
- **Storage:** a ring of the last 200 events or 10 minutes (whichever is smaller) with a monotonic `seq`, persisted so a hub that restarts keeps
  counting. Nothing else is stored.
- **Direction:** server to client for state; the client sends only `hello` (resume point and topics), `ping`, and `ack`. **All writes stay on
  the REST routes**, so the WebSocket cannot change data and adds no new authorization surface.

### 2.2 Message format (to be fixed in R0)

One JSON envelope per message, versioned:

```json
{ "v": 1, "seq": 1042, "at": "2026-10-07T12:00:00.000Z", "topic": "graph", "type": "node.updated", "id": "node_ab12", "origin": "tab_9f3" }
```

- `topic`: `graph` (the nine existing types, unchanged names), `engine` (see 2.4), `settings`, `system`.
- Events carry **ids and small hints, not content**; a client refetches what it needs (as Space does now). Patches are a later option.
- Client `hello`: `{ "v": 1, "type": "hello", "lastSeq": 1041, "topics": ["graph","engine"] }`. The hub replies with the missed events in
  order, or `{ "type": "gap" }` when `lastSeq` is older than the ring (the client then refetches everything).
- Shared definitions live in one dependency-free module (`public/js/realtime-protocol.js`), imported by the Worker and the browser, the same
  pattern as `public/js/shell-surfaces.js`.

### 2.3 Client: `public/js/realtime.js`

- Connect with exponential backoff and jitter; resume from `lastSeq`; close after a long hidden period and reopen on visibility.
- Feature detect and **fall back to SSE, then to polling**; a single kill switch (`REALTIME=off` in the Worker environment, mirrored in the page
  meta) turns it off everywhere.
- Dispatches by topic. Space maps `graph` events to its existing reload; Mission Control maps `engine` events to its existing refreshers, so
  polling code stays as the fallback and does not need rewriting.
- **Accessibility:** a remote event that needs the operator ("Atlas is waiting for your answer", "Halted") is announced through the existing
  `announce()` helper in `public/js/a11y.js` and never moves focus; the status pill and banner update as they do now.

### 2.4 Engine state contract (draft, for R0 with Aether_Engine)

The Worker cannot connect to `localhost:3333`, so the engine pushes **outward**. Two options; R0 picks one:

- **A. Outbound WebSocket (preferred):** the engine opens `wss://<portal>/api/engine/connect`, authenticated with a short-lived engine token (the
  existing `src/engine-token.js` minting, with a narrow `engine:push` scope), and sends events. The hub fans them out to that user's tabs.
- **B. Signed POST:** the engine POSTs batches to `/api/engine/events`. Simpler, but one request per event and no immediate backpressure.

Engine events (topic `engine`), all keyed by `agent_id` and `task_id`, ids and status only:

| type | payload | replaces polling of |
|---|---|---|
| `agent.state` | `agent_id`, `state` (ACTIVE or HALTED), `reason` | breaker bar, workforce |
| `task.started` / `task.step` / `task.finished` | `task_id`, `agent_id`, `status`, `completed_steps`, `total_steps` | task monitor, workforce, run history |
| `task.awaiting` | `task_id`, `agent_id`, `question` (truncated) | operator console, decision banner |
| `task.choice` | `task_id`, `option` (an answer was given elsewhere) | operator console |
| `engine.hello` / `engine.bye` | `version`, capabilities | engine row in the status pill |

Rules: the engine is the source of truth; the hub never invents engine state; if the engine is silent for 60 s the hub emits
`engine.bye` and Mission Control shows "Engine offline" as it does now. A control action (trip, reset, answer) still goes through the REST relay
and the hub only reports the result.

### 2.5 R0 spec as written (`public/js/realtime-protocol.js`)

The module is the source of truth; this section records the choices it makes where 2.2 and 2.4 were open.

- **Envelope:** `{ v, seq, at, topic, type, id?, origin?, data? }`. `seq >= 1`, `at` is UTC ISO-8601. `data` exists only on `engine` events
  (graph events use `id`). Frames over 4096 bytes (UTF-8) are refused before parsing.
- **Topics:** `graph` carries the nine existing types unchanged, `settings.updated` included, so R2 dual publish is a straight copy.
  `settings` and `system` are reserved with no types; the validator rejects them until a type is added.
- **Server control messages (no seq):** `ready {seq}` ends a resume (replay finished, you are current), `gap {seq}` means refetch everything,
  `pong` answers `ping`. Without `ready` a client could not tell "caught up" from "still replaying".
- **Client messages:** `hello {lastSeq, topics}`, `ack {seq}`, `ping`. Nothing else is accepted, so the socket cannot write data.
  `lastSeq: 0` means a first connection.
- **Resume (`resolveResume`):** replay the events after `lastSeq`; `gap` when the ring no longer holds `lastSeq + 1`, when `lastSeq` is ahead of
  the hub (the counter was lost), or on a first connection to a hub that already has history. An empty replay is a valid answer.
- **Engine events:** strict per-type schemas (required and optional fields, no extra keys, so content cannot ride along); `question` is
  capped at 280 characters (`truncateQuestion`); `task.step` needs `completed_steps <= total_steps`. Task statuses:
  `queued running awaiting done failed cancelled`. Agent states: `ACTIVE HALTED`.
- **Engine input** is `{ v, topic: "engine", type, data }` (no seq or at; the hub stamps them). It is the same for option A (one WebSocket
  frame) and option B (one item in a signed batch), so choosing A or B changes the transport only, not this file.
- **Reconnect schedule:** `backoffDelay(attempt)` doubles from 1 s to a 30 s cap with jitter between half and the whole step.
- **Limits:** 4 KB message, 200 events or 10 minutes of ring, 8 connections per user, 10 client messages per second, engine silent 60 s.

Still needed for sign-off: owner decisions in section 6, and the Aether_Engine side's agreement on the event list, the `engine:push` scope
and A or B. Recommendation: **A** (outbound WebSocket), because the hub learns of a dropped engine from the socket closing instead of waiting
out the 60 s silence, and a trip reaches the browser without batching delay.

## 3. Milestones

| # | Milestone | Done when |
|---|---|---|
| **R0 (signed off)** | Message format and engine contract written and agreed (this file's sections 2.2 and 2.4 become the spec); `public/js/realtime-protocol.js` with validators and tests | The owner and the engine side sign off on topics, event types, auth scope and A or B |
| R1 | `UserHub` Durable Object (migration `v2`), `/api/realtime` upgrade with auth and Origin check, hibernation, storage ring, resume and gap | Upgrade, auth, resume, gap and cap tests pass in the existing Worker test setup |
| R2 | Dual publish: the Worker publishes each graph write to the hub and to `GraphEvents` | Parity tests show both deliver the same events |
| R3 | `realtime.js` in Space behind the flag | Two tabs stay in sync; a mid-stream disconnect resumes with no missed event; a long gap refetches cleanly |
| R4 | Engine push (A or B) into the hub, with the engine-side change in the Aether_Engine repo | A run's progress and a breaker trip reach Mission Control with polling disabled |
| R5 | Mission Control switches from polling to realtime, polling kept as fallback | Breaker, tasks, choices and the engine row update live; unplugging realtime falls back with no visible error |
| R6 | Remove SSE and `GraphEvents`; docs (`ARCHITECTURE.md`, `ROADMAP.md`); flag defaults on | A full week of stable use; no open realtime bugs |

## 4. Test and rollout strategy

- **Unit:** envelope validation, ring (append, trim, resume, gap), backoff schedule, topic dispatch (pure, in `test/`).
- **Durable Object and upgrade tests** in the existing Worker pool (the current `graph-events.spec.js` shows the pattern).
- **Chaos cases:** drop the socket mid-event, reorder two reconnects, restart the hub, engine silent for 60 s, two tabs resuming at once.
- **Rollout:** flag off, then on for the dev operator, then on for everyone; SSE stays until R6.
- **Observability:** per-hub counters (connections, messages, gaps) kept in storage and exposed to the owner only.

## 5. Risks

- **Cost:** hibernation limits duration charges, but watch message counts; keep events small and coalesce bursts.
- **iOS home-screen apps** kill background sockets: resume and gap handling must be exercised on a real phone.
- **Engine credential:** the push token needs its own narrow scope and rotation; a leaked token must not read or write the graph.
- **Missed events:** a long gap always refetches; never apply a partial patch across a gap.
- **Privacy:** events carry ids only, so logs and `wrangler tail` do not leak card content.
- **Engine change:** R4 needs a change in the separate Aether_Engine repository; R0 must agree it first.

## 6. Decisions (approved by the owner, 2026-10-07)

1. **Phase number: 10.** The roadmap files call this work Phase 10.
2. **Engine push: Option A, outbound WebSocket.** The engine opens `wss://<portal>/api/engine/connect` with an `engine:push` token (see ENGINE_REALTIME_CONTRACT.md). Option B (signed POST) is not built.
3. **Resume window: 200 events or 10 minutes, whichever is smaller.**
4. **Events carry ids and small hints, not patches** (the suggested start; not changed by the owner).
5. **Single shared room:** one hub per user (`idFromName(userId)`), shared by all of that user's tabs and by the engine. Rooms spanning several users are not built and stay with Phase 8 multi-user work.
6. **`ready` message included** in the protocol (section 2.5).

## 7. Files this phase will touch

New: `src/realtime-hub.js`, `public/js/realtime-protocol.js`, `public/js/realtime.js`, `test/realtime-*.spec.js`.
Changed: `wrangler.jsonc` (migration `v2`), `src/index.js` (route, publish, flag), `src/graph-events.js` (dual publish, then removed),
`src/engine-relay.js` and `src/engine-token.js` (push scope), `public/js/engine/*.js` (subscribe, keep polling as fallback),
`ARCHITECTURE.md`, `ROADMAP.md`.
