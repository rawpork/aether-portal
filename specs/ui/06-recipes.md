# 06 · Pre-Populated Recipe Canvases & Custom Recipe Vault

Status: **spec, not built** · Surface: Mission Control → Studio → **Recipes** (the Studio's landing view) ·
Roadmap: Phase 4, Step 4.6

A **recipe** is a saved Workflow Canvas ([01](01-node-canvas.md)): its nodes, cables, team modes and budget
defaults, without any secrets. Aether ships pre-populated recipes so nobody starts from a blank canvas, and users
keep their own recipes in the **Vault**.

## 1. Recipe gallery

- The Studio opens on a grid of recipe cards. Each card is a `--surface` card with:
  - a **miniature canvas preview** (nodes as 8px rounded rects in their status-neutral colour, cables in their
    `--flow-*` colours, no pulses),
  - the title and a one-line purpose,
  - chips for the connections it needs ("Telegram", "MCP: GitHub", "Browser"),
  - the expected cost per run from the Budget Inspector maths ([04](04-budget-inspector.md)), computed on open.
- **Sections:** **Starter recipes** (built in), **My Vault**, **Imported**.
- **Search:** filters by title, tags and the connections a recipe needs.
- **Opening a recipe** loads a *copy* onto the canvas, so the original never changes. Nodes whose connection is
  missing show a dashed outline and "Connect Telegram" (and similar) inline links into the Connections Hub
  ([07](07-connections-hub.md)).

### Starter recipes

These are the same template families the synthesis engine picks from (TODO.md "Blueprint Clusters",
SPATIAL_ARCHITECTURE.md §8.3), so an Outcome Node can open straight into its recipe:

| Recipe | Shape | Default mode |
| --- | --- | --- |
| **Research → Brief** | trigger → team (Researcher + Reviewer) → MCP Read web fetch → action: create portal node | HITL |
| **SOP Builder** | trigger → agent → MCP Read (saved nodes) → team debate → action: save SOP node | Planning |
| **Content Pipeline** | trigger → team (Writer + Editor) → action: draft script + description → human checkpoint | HITL |
| **Ad Variants** | trigger → agent → A2A with critic → action: export variants | Planning |
| **Website Scaffold** | trigger → team → MCP Read (repo) → action: write files → human checkpoint | Planning |
| **Vendor Quote Run** | trigger → team → browser (allowlisted domains) → human → action: Telegram summary | HITL |
| **Telegram Triage** | trigger: Telegram message → agent (frugal) → action: reply or create node | Auto |

Starter recipes live in the repo as JSON (`public/recipes/*.json`), are validated in CI, and are versioned. A
newer version shows "Update available" on vault copies made from it, and never overwrites them.

## 2. Custom Recipe Vault

- **Save to Vault** from the canvas. The Vault stores recipes per user in D1 (proposed migration
  `0016_recipes.sql`):
  `recipes(id, user_id, name, description, tags, body_json, source_recipe, source_version, created_at, updated_at)`.
- **Card actions:** Open, Duplicate, Rename, Export, Delete (with confirm and a 10-second Undo toast).
- **Version history:** each save keeps the previous body (the last 10). Restoring makes a new save.

## 3. Export and import: `aether.recipe/1`

```json
{
  "schema": "aether.recipe/1",
  "name": "Vendor Quote Run",
  "description": "Collect quotes from allowlisted vendor portals and summarise them to Telegram.",
  "version": 3,
  "exported_at": "2026-10-03T12:00:00Z",
  "nodes": [
    { "id": "n1", "kind": "trigger", "label": "Manual", "position": { "x": 0, "y": 0 }, "config": { "type": "manual" } },
    { "id": "n2", "kind": "team", "label": "Atlas + Quartz", "position": { "x": 320, "y": 0 },
      "config": { "mode": "hitl", "rounds": 2, "stance": "reviewer", "lead": { "role": "Buyer", "model": "inherit" }, "partner": { "role": "Reviewer", "model": "inherit" } } },
    { "id": "n3", "kind": "browser", "label": "Vendor portal", "position": { "x": 640, "y": 0 },
      "config": { "allowlist": ["vendor-portal.example.com"], "record": false } },
    { "id": "n4", "kind": "action", "label": "Telegram summary", "position": { "x": 960, "y": 0 },
      "config": { "type": "telegram_send", "connection": { "kind": "telegram", "ref": "default" } } }
  ],
  "cables": [
    { "id": "c1", "kind": "action", "from": { "node": "n1", "port": "start" }, "to": { "node": "n2", "port": "start" } },
    { "id": "c2", "kind": "action", "from": { "node": "n2", "port": "act" }, "to": { "node": "n3", "port": "act" } },
    { "id": "c3", "kind": "mcp_read", "from": { "node": "n3", "port": "observe" }, "to": { "node": "n2", "port": "context" } },
    { "id": "c4", "kind": "action", "from": { "node": "n2", "port": "act" }, "to": { "node": "n4", "port": "act" } }
  ],
  "budget": { "cap_usd_per_run": 0.30, "runs_per_month": 20 },
  "requires": [ { "kind": "telegram" }, { "kind": "browser" } ]
}
```

- **No secrets, ever.** Connections are referenced by `{ kind, ref }`, never by token or key. The exporter
  rejects, rather than strips, any config value that looks like a credential:
  - it matches a Telegram bot token, `sk-`, `AIza`, `ghp_`, `msk_` or a JWT, or
  - its key name matches `token|secret|password|api_key`.
  The user sees which field to fix.
- `trigger → start` cables use kind `action`. They carry control, not data, and draw as orange.
- **Export** downloads `<slug>.aether-recipe.json`. **Copy link** encodes recipes under 8KB into a
  `/mission-control?recipe=<base64url>#studio` link, which asks "Import this recipe?" before saving, like the engine
  pairing link.
- **Import** (file, drop or paste) validates against `schema/recipe.schema.json` (to be added). It reports errors as
  `{ path, message }`, the way the Blueprints tab does.
  - Unknown node kinds block the import.
  - Unknown config keys are warnings.
  - Imported recipes always open in **HITL** mode, whatever their saved mode, until the user changes it.
- Converting to and from `aether.blueprint/1` is out of scope for v1. Outcome Nodes link to a starter recipe by
  template family instead.

## 4. Phones

- The gallery is one column, and previews are kept.
- Export and Import live in the card's ⋯ menu. Copy link uses the share sheet (`navigator.share`) where available.

## 5. Tests

- Every starter recipe validates and round-trips export → import unchanged.
- The secret detector rejects each credential pattern.
- Imports are forced to HITL.
- Missing-connection placeholders render.
- Vault versioning keeps 10 versions.
- Links over 8KB fall back to file export.
