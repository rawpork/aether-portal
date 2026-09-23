# Roadmap

Guiding principle: **token-lean**. Do everything that can be done with regex, SQL, or the client first; call Gemini only when a node genuinely needs it, and never pay twice for the same node.

See [PROJECT_STATE.md](PROJECT_STATE.md) for the current step and [TODO.md](TODO.md) for the actionable task list.

## Done

- **Phase 1 — Capture.** Telegram webhook → D1, with secret-token auth and a confirmation reply.
- **Phase 2 — Visualize.** 3D force graph with category/time/search filters, keyword-based semantic links capped per node.
- **Phase 3 — Enrich.** Gemini 2.5 Flash title/category cleanup, placeholder-context merging, batched admin-only `/api/recluster`, rainbow cluster coloring.

## Phase 4 — Token-lean enrichment (next)

Goal: cut Gemini spend per node to ~one call over its lifetime.

- ~~Track enrichment state (`ai_processed_at` column) and have `/api/recluster` skip nodes already processed.~~ Done.
- Enrich at ingest only when local heuristics are weak (short notes, bare URLs), not for every message.
- Keep prompts minimal: send the URL/text only, cap input length, keep `thinkingBudget: 0` and a small `maxOutputTokens`.
- Batch several nodes into one Gemini request during recluster (one JSON array in, one out) instead of one call per node.
- Prefer free signals before AI: domain → category map, page `<title>` fetch for bare links.

## Phase 5 — Scale the graph

- Store computed links (or cache `/api/graph` output) instead of recomputing O(n²) keyword overlap on every load.
- Paginate or time-window `/api/graph` once node count grows.
- Check the D1 schema into the repo as migrations.

## Phase 6 — Finish Line integration

- Hand enriched nodes to the Finish Line stage for ranking and final processing (see [PROJECT_INDEX.md](PROJECT_INDEX.md)).
- Publish selected outputs to Shamely.io.

## Non-goals (for now)

- Embeddings / vector search — revisit only if keyword links prove insufficient; they add per-node token cost.
- Multi-user accounts — single owner, admin token is enough.
