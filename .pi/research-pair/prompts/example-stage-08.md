# Stage 8 Example — Analytics CLI & Slash Commands

Concrete placeholder fill for a real stage, showing the orchestrator-authored `{{QUESTIONS}}` set that both the **researcher** and **condenser** see identically. Source of truth: `/workspaces/pi-audit/research-plan.md` §8 (lines 109–120).

Use this as a worked example to fill the placeholders in `researcher.md` / `condenser.md`, not as a template to copy wholesale (your stage will have different questions).

## Shared / fixed values

| Placeholder | Value |
|---|---|
| `{{JOB_NAME}}` | `pi-audit` |
| `{{JOB_CONTEXT}}` | pi-audit is a SQLite audit-sink extension for pi (live collation, failure tracking, OpenRouter latency, cache stats, zero-bloat, Git coupling). Stage 8 goal: define the user-facing commands (`/audit-stats`, `/audit-costs`, `/audit-tools`, `/audit-cache`, `/audit-commit <ref>`) for querying that data, built on the decisions from stages 1–7. |
| `{{STAGE_TOPIC}}` | `Analytics CLI & slash commands` |
| `{{RESEARCH_RAW_PATH}}` | `/workspaces/pi-audit/research/research-stage-08-analytics-cli.md` |
| `{{CONDENSED_X_PATH}}` | `/workspaces/pi-audit/research/research-stage-08-analytics-cli-x.md` |
| `{{SOURCE_FILES}}` | `/workspaces/pi-audit/research-plan.md`, and (for patterns) the pi extension files it cites |
| `{{TARGET_LINES}}` | `research-plan.md:109-120`; extension files: cite exact `file:line` in task |
| `{{SEED_FILES}}` | `<none provided>` (or a prior raw) |
| `{{SEARCH_ANGLES}}` | `<none provided>` — mostly local (pi API docs) |

## Shared `{{QUESTIONS}}` — the orchestrator's minimum set (the SAME text for both agents)

The orchestrator writes one minimum question set for the stage. The researcher answers each broadly (low bar, web freedom); the condenser folds each to a decision-relevant answer (high bar). **Both receive this identical list.**

1. What does `pi.registerCommand(name, handler)` accept, and what may the handler do (args, output, TUI)? Cite source file + line.
2. What can `ExtensionCommandContext` provide beyond the base context (cwd, session, scripts, output) that a slash-command handler needs?
3. How do existing pi extensions (`pi-failures`, `findtree`) register and render slash commands — TUI widget vs plain output? Cite.
4. What is the `--since` / `--slug` / `--format` flag convention (if any) in existing pi commands?
5. How can a command reliably locate and open the audit DB? Does it need `ctx.cwd` / `ctx.sessionManager`?
6. Which default analytics queries (per-model TTFT, per-commit cost, tool reliability, cache hit ratio) are the right defaults?
7. Where can a command write/print structured output, and what does multi-element TUI rendering require (if used)?

## How the two agents treat the SAME questions

- **Researcher** — within `{{JOB_CONTEXT}}`, range broadly across web + local files; answer each `{{QUESTIONS}}` item fully, cite file/line or URL, keep edge/uncertain notes in the raw. Low surface-threshold; over-cover.
- **Condenser** — within `{{JOB_CONTEXT}}`, read the raw; take each `{{QUESTIONS}}` item and fold its answer down to the decision-relevant essence (command form, mvp order, rendering choice, flag corrections) with the reasoning preserved. Target 30–50%; use bullets/tables.

## Why this differs from the earlier split

Earlier drafts gave the researcher and condenser **different** question sets. The unified model keeps **one `{{QUESTIONS}}` set shared by both**, because both work toward the same `{{JOB_CONTEXT}}` and the same stage aim. The difference is **latitude and folding-bar** — researcher roams wide + low bar; condenser narrow + high bar — not *which questions each one sees*.