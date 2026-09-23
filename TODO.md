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
- [ ] Pin or self-host the `3d-force-graph` script instead of loading from unpkg.
- [ ] Finish Line hand-off and Shamely.io publishing (Phase 6).
