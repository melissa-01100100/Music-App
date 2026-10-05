# Project guide for Claude

This is a game project run by three specialist agents (see `.claude/agents/`):

- **game-director** – game design, game flow, flowcharts, task planning. Owns the plan.
- **developer** – all code, architecture, tests, builds.
- **marketing-design** – branding, UI look and feel, store listing, launch.

## Source of truth
All shared knowledge lives in `docs/`. Agents read these before working and update them after:

| File | Owner |
|---|---|
| docs/GAME_DESIGN.md | game-director |
| docs/FLOWS.md | game-director |
| docs/TASKS.md | game-director (others mark tasks done) |
| docs/DECISIONS.md | anyone, dated |
| docs/TECH.md | developer |
| docs/BRAND.md, docs/UI_STYLE.md, docs/MARKETING.md | marketing-design |

## Workflow
1. New idea → game-director updates the design doc and adds tasks.
2. [DEV] tasks → developer. [DESIGN]/[MARKETING] tasks → marketing-design.
3. Anything that changes the game's rules goes back through game-director first.
