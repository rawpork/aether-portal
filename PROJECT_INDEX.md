# Project Ecosystem Index

## Core system
### Aether Portal
- The operational knowledge graph layer.
- Cloudflare Worker serves the 3D graph UI, Telegram webhook ingestion, and `/api/graph` data API.
- D1 persists saved nodes and semantic relationships.

### Finish Line
- The decision and completion layer for turning raw captured information into usable outputs.
- Responsible for AI-assisted normalization, ranking, and final processing before publishing or routing.

### Shamely.io
- The public-facing ecosystem surface and brand identity.
- Acts as the external destination for product presence, adoption, and user-facing storytelling around the system.

## Working flow
1. Capture input via Telegram or other upstream triggers.
2. Persist raw nodes in D1 through Aether Portal.
3. Enrich and structure data through the AI pipeline in the Finish Line stage.
4. Surface the result through the graph interface and downstream ecosystem channels, including Shamely.io.

## Current emphasis
Aether Portal is the live foundation; the next major milestone is wiring Gemini 2.5 Flash as the intelligence layer that upgrades raw saved content into a richer, connected knowledge system.
