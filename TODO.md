# TODO

Actionable tasks, roughly in priority order. Phases refer to [ROADMAP.md](ROADMAP.md).

## Now

- [x] Check the `saved_nodes` schema into the repo (`migrations/0001_init.sql`) so D1 can be recreated from source.
- [x] Add an `ai_processed_at` column and skip already-processed nodes in `/api/recluster` (Phase 4).
- [ ] Add tests for `/api/graph` shape and the Telegram save path using a mocked D1 binding.

## Next

- [ ] Only call Gemini at ingest for weak classifications (Phase 4).
- [ ] Batch multiple nodes per Gemini request in recluster (Phase 4).
- [ ] Domain → category lookup table before falling back to AI (Phase 4).
- [ ] Cache or persist graph links instead of recomputing per request (Phase 5).

## Later

- [ ] Paginate / time-window `/api/graph` (Phase 5).
- [ ] Rename the worker from `lingering-water-de49` to something descriptive (requires re-pointing the Telegram webhook).
- [x] Pin or self-host the `3d-force-graph` script instead of loading from unpkg (`public/vendor/`, with three.js).
- [ ] Finish Line hand-off and Shamely.io publishing (Phase 6). Outcome Nodes export as `aether.blueprint/1` (SPATIAL_ARCHITECTURE.md 8.6); decide the transport here.

## Agentic Synthesis Engine (Phase 7, SPATIAL_ARCHITECTURE.md section 8)

Aether's core value: a subconscious "big brain" that turns saves from different areas into executable Outcome Nodes (Input A + Input B → Outcome C).

- [x] Migration 0014: `outcome_status`, `outcome_fingerprint` on `saved_nodes`; `outcome_inputs` table.
- [x] Local candidate bundle scoring (diversity × strength × recency × novelty), unit-tested.
- [x] Synthesis Gemini call after the daily miner, and a validator (cited steps, known templates, 3-10 steps), unit-tested.
- [x] Create Outcome Nodes (`category = 'outcome'`) with synthesis links; at most 2 per user per day; dismiss memory by fingerprint.
- [x] Outcome card face (gold border, OUTCOME ✦ badge) and Outcome Gold glow with breathing pulse.
- [x] Node card plan view: numbered steps, tappable cited inputs, Accept / Dismiss / Regenerate / Send to Finish Line.
- [x] Outcome placement between the islands it bridges; always shown regardless of time scope.
- [x] `aether.blueprint/1` export for Finish Line.

## Future ideas

- [ ] **Blueprint Clusters** (approved for the roadmap 2026-09-27; concept write-up still to come). These template types are also the ones the synthesis call picks from for Outcome Nodes (SPATIAL_ARCHITECTURE.md 8.3):
  - Project Setup: architecture, DB schema, UI.
  - SOP Creation: standard operating procedures.
  - Content Creation: video scripts, descriptions, physical asset specs.
  - Ad Creation.
  - Website Creation.
