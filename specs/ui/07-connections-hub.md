# 07 · User Connections Hub & Advanced Developer Mode

Status: **spec, not built** · Surface: Mission Control → **Connections** (replaces the "Settings" rail item;
`#connect` keeps working) · Roadmap: Phase 4, Step 4.7

The Hub is where a user connects the outside world to their agents: a **Telegram bot** for messages and approvals,
their **own model keys (BYOK)**, and **MCP connectors**. Infrastructure plumbing moves behind an **Advanced Developer
Mode** toggle, so the default view only shows what an operator needs: engine URLs, tokens, tunnels and the Miserly
client key.

## 1. Layout

The page has three sections, each a plain list of rows on one `--surface` panel, with no cards inside cards:

```
Connections                                         Advanced Developer Mode ○
──────────────────────────────────────────────────────────────────────────────
Messaging    Telegram  @aether_ops_bot · connected · chat bound      [Manage]
Models       Anthropic  sk-ant-…4f2a · overrides 2 agents           [Manage]
             Google Gemini  not connected                           [Connect]
Tools (MCP)  GitHub  3 tools read · 2 actions · healthy             [Manage]
             + Add MCP connector
```

Each row shows status in words plus a pill: Connected (green), Needs attention (orange), Not connected (grey),
Error (red). **Manage** opens a right-side sheet on desktop and a bottom sheet on phones.

## 2. Messaging: Telegram Bot Token

1. **Connect:** paste the token from @BotFather. The client checks its shape (`^\d{6,12}:[A-Za-z0-9_-]{30,}$`)
   before sending anything.
2. **The Worker's `POST /api/connections/telegram`:**
   - calls `getMe` to verify the token and get `@username`,
   - calls `setWebhook` to `/api/telegram/bot/:connectionId` with a random `secret_token`,
   - stores the token **encrypted** (see §6) and returns only `{ username, token_hint: "123456:…abcd" }`.
3. **Bind the chat:** the sheet shows "Open @aether_ops_bot and send /start", with a `t.me` link and a QR code
   (`src/services/qr.ts`). The first `/start` from a chat binds that chat id to the user, and the row turns
   "chat bound".
4. **Uses:**
   - HITL approvals with inline buttons ([03](03-team-cards.md)),
   - Telegram triggers and `telegram_send` actions in recipes ([06](06-recipes.md)),
   - run-finished summaries, which can be switched off per workflow.
5. **Manage:** Send test message, Rebind chat, Replace token, Disconnect. Disconnect calls `deleteWebhook` and
   deletes the row.

The existing operator bot (the `TELEGRAM_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` Worker secrets, used for ingest at
`/api/telegram`) is unchanged. It shows as
"Aether bot (shared)" and can't be edited here.

## 3. Models: BYOK overrides

- **Providers:** Anthropic, Google Gemini and OpenAI-compatible (base URL plus key). Each key is verified with a
  cheap list-models call before it is saved. The models it can use come from that call.
- **Overrides**, applied in order (later wins):
  1. **Default:** `miserly-auto` through Miserly.io. This is the current behaviour and stays the default.
  2. **Per role:** Master Brain (Elarion), team Lead, team Partner, triage agents.
  3. **Per node:** set in the canvas inspector ([01](01-node-canvas.md)). It shows "BYOK · claude-sonnet-5-5" on the
     node.
- **Costs:** BYOK calls are billed to the user's provider account, not to Aether or Miserly. The Budget Inspector
  ([04](04-budget-inspector.md)) still estimates them with Miserly's price table, labelled "billed by Anthropic".
  Where the provider isn't in that table, it shows "price unknown".
- **Open dependency:** routing BYOK traffic *through* Miserly, which would keep budgets, telemetry and savings
  headers, needs a Miserly passthrough-key feature that doesn't exist yet. Until then, BYOK calls go straight from
  the engine to the provider. Miserly caps don't apply to them, and the UI says so on every BYOK row.

## 4. Tools: MCP connectors

- **Add:**
  - name,
  - server URL (https only; `http://localhost` only in Advanced mode),
  - transport: Streamable HTTP by default, or legacy SSE,
  - auth: none, bearer token, or OAuth 2.1 using the MCP authorization flow (the Worker handles the redirect).
- **Test:** the Worker (or the engine, for localhost servers) runs `initialize` then `tools/list` and
  `resources/list`, and shows the server's name and version.
- **Tool list:** one row per tool, with an on/off switch and a **Read / Action** classification.
  - The default comes from MCP tool annotations: `readOnlyHint: true` is Read. Anything else, including
    `destructiveHint`, is Action.
  - The user may *raise* a Read tool to Action, but never lower an Action tool to Read without a confirm
    ("This tool can change things. Treat it as read-only anyway?").
  - The classification decides the cable kind on the canvas: green MCP Read or orange Action.
- **Health:** checked when the Hub opens and every 10 minutes while a workflow uses the connector. A failing
  connector shows Needs attention, and its canvas nodes get a dashed outline.

## 5. Advanced Developer Mode

- A switch in the page header (`role="switch"`), off by default, stored per browser as `aether.devMode`. It is a
  **visibility preference, not access control**: everything it reveals is still protected by the same session and
  engine auth.
- **Off** (default) shows only the three sections above, plus a one-line engine status ("Engine connected ·
  local").
- **On** adds these sections, moved out of today's Settings tab unchanged:

  | Section | Contents |
  | --- | --- |
  | Engine & pairing | Connection Wizard (`connection-wizard.js`): engine URL, tunnel detection, QR pairing, cloud engine |
  | Engine token | The token panel and paste-a-token fallback (`connection.js`) |
  | Miserly.io | Quick Setup's Miserly client key, Free Sandbox Mode and verification steps (`quick-setup.js`) |
  | Diagnostics | Request IDs, raw JSON views in Blueprints, `?debug=clearance` ([02](02-case-clearance.md)), engine health JSON |

- **Escape hatch:** when something in Advanced needs attention (engine unreachable, TOKEN NEEDED, Miserly key
  invalid), the default view shows one orange row, "Engine connection needs attention", with a **Fix** button. Fix
  turns Advanced on and scrolls to the right section. Problems never hide behind the toggle.
- Existing deep links (`#connect`, `?engine=` pairing) still work. They turn Advanced on for that visit only, without
  saving the preference.

## 6. Secrets handling (Worker)

- All connection secrets are stored in D1 (proposed migration `0017_user_connections.sql`):
  `user_connections(id, user_id, kind, label, secret_ct, secret_iv, hint, meta_json, status, created_at, updated_at)`.
  - They are encrypted with AES-GCM under a key derived from a new Worker secret, `CONNECTIONS_KEY`.
  - Each row has a random IV, and the user id is used as additional authenticated data.
- Secrets never return to the browser after saving. Responses carry only `hint` (the last 4 characters) and
  status.
- Writes need the signed-in session plus a same-origin check, like `PATCH /api/node/:id`. Every connect, replace and
  disconnect is logged (no secret values) to an activity list in the Hub.
- The engine receives secrets only for the duration of a run, over the authenticated engine API, and never writes
  them to `outputs/` or logs.

## 7. Tests

- **Telegram:** token-shape validation; `getMe` failure; webhook secret checked on incoming updates; chat binding
  on the first `/start` only.
- **BYOK:** override precedence (default → role → node); the "not through Miserly" label.
- **MCP:** annotation → Read/Action default; lowering a classification needs a confirm; health states.
- **Dev Mode:**
  - the default view hides the infrastructure sections,
  - Fix turns Advanced on,
  - deep links don't save the preference.
- **Secrets:** API responses never contain secret values (snapshot test).
