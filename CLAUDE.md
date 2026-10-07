# Aether Portal

## On startup
1. Read `AGENT_CORE.md` (owner profile and the 10-persona roster).
2. Check `registry/connectors.json` first for any project, path, URL or command before searching the disk.
3. Read `ROADMAP.md` for current phase and next steps.

## Handoffs
Zero context loss: every handoff (to another persona, agent, session or the owner) states the goal, what is done, what is left, exact file paths and the next action. Update `ROADMAP.md` when a step ships.

## Model policy
`sonnet` is the default (`~/.claude/settings.json`). Use Opus only for heavy multi-step orchestration, via a single-session flag or an inline `/model` switch.
