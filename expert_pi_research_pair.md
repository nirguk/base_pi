# expert_pi_research_pair

Session anchor: **`01a09ad1-374a-7215-b27f-aa8985ed48b0`**

This file records the pi session in which the `pi-research-pair` workflow was designed and validated (Stages 1 + 8 of pi-audit). Use `/resume` with the session id above (or `pi -r <id>`) to return to that conversation; `/tree` navigates to the specific design/validation entries, seen via `/session`.

> **Location note:** the reusable workflow assets were later consolidated into **`base_pi/.pi/research-pair/`** (the canonical home) so `base_pi` self-contains the whole toolchain. `/workspaces/pi-audit/` keeps only project-local products (`research/`, `research-plan.md`, `HANDOVER.md`) plus **symlinks** (`check-research.mjs`, `run-stage.mjs`, `prompts/`) onto the base_pi canonical copies.

For the workflow itself (living spec, agents, gate, runbook), see:
- Living spec: `base_pi/.pi/research-pair/RESEARCH_PAIR.md`
- Agents: `base_pi/.pi/agents/pi-researcher.md`, `base_pi/.pi/agents/pi-condenser.md`
- Gate/scaffold: `base_pi/.pi/research-pair/bin/check-research.mjs`, `bin/run-stage.mjs`
- Runbook: `base_pi/.pi/research-pair/README.md`
- Prompt templates: `base_pi/.pi/research-pair/prompts/`