# Engine realtime contract (for Aether_Engine)

Hand-off for Phase 10 (Realtime), milestone R4. Source of truth: `public/js/realtime-protocol.js` (validators) and `PHASE2_PLAN.md` (section 2.4, 2.5 and 6). Agreed on the portal side 2026-10-07; **Aether_Engine has not yet accepted it.**

## What the engine does
The Worker cannot reach `localhost:3333`, so the engine connects **outward** (Option A) and pushes events. The portal's `UserHub` stamps `seq` and `at` and fans each event out to that user's open tabs. The engine is the source of truth; the hub never invents engine state. Control actions (trip, reset, answer) still go through the REST relay.

## Connection
- URL: `wss://<portal-host>/api/engine/connect` (one connection per engine user; a new one replaces the old).
- Auth: `Authorization: Bearer <engine:push token>` on the upgrade request.
- Send text frames only, each a single JSON object, **at most 4096 bytes (UTF-8)**.
- On connect, send `engine.hello` first. Reconnect with backoff: 1 s doubling to 30 s, jittered between half and the whole step.
- Send at least one event, or the exact text frame `{"v":1,"type":"ping"}` (answered `{"v":1,"type":"pong"}`), every **30 s**. Protocol-level WebSocket ping frames are not seen by the hub. If the hub hears nothing for **60 s** it emits `engine.bye` and Mission Control shows "Engine offline".
- Rate: keep bursts small; coalesce `task.step` events to at most a few per second per task.
- The hub sends nothing the engine needs to act on; invalid frames are dropped and counted, and 5 invalid frames close the socket (code 1008). The engine may send up to 50 frames per second; over that the socket is closed. A new engine connection for the same user closes the old one (code 1012). If the engine's socket closes, the hub announces `engine.bye` (`reason: "disconnected"`) at once.

## `engine:push` token
Minted like the existing engine tokens (`src/engine-token.js`: HS256, signed with the shared secret that equals the engine's `SUPABASE_JWT_SECRET`), with these differences:

| claim | value |
|---|---|
| `alg` | `HS256` |
| `sub` | `portal:<userId>` (the hub is addressed by this user) |
| `iss` | `aether-portal` |
| `aud` | `aether-portal-realtime` (not `authenticated`) |
| `scope` | `engine:push` (exactly; no other scopes) |
| `iat`, `exp` | `exp - iat <= 300` s; the token is checked once, at the upgrade |

Requirements the portal enforces (R1/R4):
- A token with `scope: engine:push` is accepted **only** on `/api/engine/connect`. It never reads or writes the graph, REST routes, or other users' hubs, and a normal session token is refused on the connect route.
- The scope, audience and `exp` are all checked; a leaked token is useless after 5 minutes and cannot be used for anything else.
- Rotation: the shared secret rotates by deploying the new value to both sides; tokens are never stored.

Open item for the engine: who mints the token (the engine, from the shared secret, or the portal via a mint route). Default proposal: the engine mints its own, since it holds the secret.

## Frame format
Every frame the engine sends:

```json
{ "v": 1, "topic": "engine", "type": "<type>", "data": { ... } }
```

Do not send `seq` or `at`. Unknown keys inside `data`, unknown types and wrong versions are rejected. IDs are non-empty strings of at most 128 characters. Counts are non-negative integers. **Never put content (prompts, outputs, file text) in an event: ids and status only.**

## Event types and `data` schemas

JSON Schema (draft 2020-12), shared definitions first.

```json
{
  "$defs": {
    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
    "count": { "type": "integer", "minimum": 0 },
    "text": { "type": "string", "maxLength": 280 },
    "taskStatus": { "enum": ["queued", "running", "awaiting", "done", "failed", "cancelled"] },
    "agentState": { "enum": ["ACTIVE", "HALTED"] }
  }
}
```

| `type` | required `data` | optional `data` | replaces polling of |
|---|---|---|---|
| `engine.hello` | `version` (id) | `capabilities` (up to 16 strings, each 1 to 32 chars) | engine row in the status pill |
| `engine.bye` | none | `reason` (text) | engine row (also emitted by the hub on 60 s silence) |
| `agent.state` | `agent_id` (id), `state` (agentState) | `reason` (text) | breaker bar, workforce |
| `task.started` | `task_id`, `agent_id` (ids), `status` (taskStatus) | `total_steps` (count) | task monitor, workforce |
| `task.step` | `task_id`, `agent_id`, `status`, `completed_steps` (count), `total_steps` (count) with `completed_steps <= total_steps` | none | task monitor, run history |
| `task.finished` | `task_id`, `agent_id`, `status` | `completed_steps`, `total_steps` | task monitor, run history |
| `task.awaiting` | `task_id`, `agent_id`, `question` (1 to 280 chars; collapse whitespace and cut with an ellipsis) | none | operator console, decision banner |
| `task.choice` | `task_id`, `option` (id) | none | operator console (an answer was given elsewhere) |

Examples:

```json
{ "v": 1, "topic": "engine", "type": "engine.hello", "data": { "version": "1.4.0", "capabilities": ["tasks", "approvals"] } }
{ "v": 1, "topic": "engine", "type": "agent.state", "data": { "agent_id": "master-brain", "state": "HALTED", "reason": "Paused from Mission Control" } }
{ "v": 1, "topic": "engine", "type": "task.step", "data": { "task_id": "t1", "agent_id": "a1", "status": "running", "completed_steps": 2, "total_steps": 5 } }
{ "v": 1, "topic": "engine", "type": "task.awaiting", "data": { "task_id": "t1", "agent_id": "a1", "question": "Deploy to production?" } }
```

## Engine-side checklist (R4)
1. Emit `engine.hello` on every (re)connect, and `agent.state` for every agent's current state right after it, so the portal starts from the truth.
2. Emit `agent.state` on every breaker trip and reset, `task.*` on every transition, `task.awaiting` when a question is raised, `task.choice` when it is answered from any surface.
3. Validate outgoing frames with the same rules (copy `validateEngineInput` from `public/js/realtime-protocol.js`, or import it).
4. Keep the REST relay as is; realtime never carries commands.
5. Mark open questions back to the portal in this file or in `ROADMAP.md`.

## Status (2026-10-08)
Implemented in Aether_Engine (`src/realtimePush.ts`, `realtimeEvents.ts`, `realtimeProtocol.ts`). Decisions the engine made: the engine mints its own token (no portal mint route); the token goes in the `Authorization: Bearer` header only (no query parameter); the engine is opt-in with `PORTAL_REALTIME_USER` and uses the same `PORTAL_URL` as its status page; task statuses map `RUNNING` to `running`, `COMPLETED` to `done`, `HALTED` to `cancelled`, `FAILED` to `failed`; `task.choice.option` is the 1-based option number as a string; the master brain's state is always included in the snapshot.
