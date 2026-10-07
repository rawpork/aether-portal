# Aether Portal

## On startup
1. Read `AGENT_CORE.md` (owner profile and the 10-persona roster).
2. Check `registry/connectors.json` first for any project, path, URL or command before searching the disk.
3. Skills: look them up through `registry/connectors.json` (`skills_vault`), which points at `proprietary/skills/`: `TS_Skills/` for every skill Titain Solutions creates (e.g. `design_audit`; new skills go here) and `community/` for read-only third-party skills (e.g. `scroll_craft`; never edit them). Do not search the disk for skills. Exceptions that stay put: the engine's recipe skills in `Aether_Engine/skills/` and the portal's `.aether/skills/AEPS/`.
4. Read `ROADMAP.md` for current phase and next steps.

## Handoffs
Zero context loss: every handoff (to another persona, agent, session or the owner) states the goal, what is done, what is left, exact file paths and the next action. Update `ROADMAP.md` when a step ships.

## Model policy
`sonnet` is the default (`~/.claude/settings.json`). Use Opus only for heavy multi-step orchestration, via a single-session flag or an inline `/model` switch.
