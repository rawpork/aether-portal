# Studio Engine Architecture & Rules

You are connected to the Aether Studio Engine runtime environment.

## Rules
1. Never hardcode large tool sets into agent prompts.
2. New tool capabilities must be added via repo intake and sandbox testing.
3. Execution of verified tools must be dispatched directly via `StudioToolRegistry`.
4. Keep agent tool selections minimal (3–5 top matching tools max).

## Core Files
- Engine Script: `studio_engine.py`
- Active Manifest: `master_tool_manifest.json`
