# pi-research-pair — fresh test handoff (start here, new session)

Captured from the work-in-progress session so a fresh Pi session can continue
without dragging the long parent context. Read this file, then follow the steps.

## Goal
Exercise the `pi-research-pair` workflow end-to-end on a FRESH stage-1 topic,
in a temp dir on the pi-audit container, proving: researcher -> gate(RAW) ->
condenser -> gate(RAW + -x). Use the installed pi agents
(`.pi/agents/pi-researcher.md`, `.pi/agents/pi-condenser.md`).

## The one hard constraint (learned)
`runs.host` (the only in-flight way to shell out) is UNAVAILABLE inside a
subagent workflow runner — both background and blocking. So the **gate steps
must be run by the parent (you, in the main session)**, not inside
the workflowScript. Two already-proven ways:

- Have each agent self-gate via a **labelled static mirror** of the gate's
  structural checks, emitting `SELF-GATE: PASS` or `SELF-GATE: FAIL (<defect>)`
  (they cannot execute node — no shell in their toolset). Both agent prompts
  now contain this contract (see `.pi/agents/pi-researcher.md` / `pi-condenser.md`).
- The parent runs the real gate on the artifact after each leg (see Steps) —
  the authoritative run.

> The condenser now also has `edit` (and dropped `rm`, which is not a pi
built-in tool — see the note below) and a “don’t agonise over minor
drafting” clause (in `pi-condenser.md`), so it should stop the full-file
rewrite spiral this round’s test is checking.

## Steps
1. Pick the **next fresh, unused** temp dir under `/workspaces/pi-audit/`, e.g. `/workspaces/pi-audit/research-pair-test5` (test3 and test4 are already used).
2. Run `pi-researcher` (agent) with a task that injects the placeholders
   below. It writes a RAW research file (>= 100 lines) to RESEARCH_RAW_PATH.
3. Parent: run the real gate to confirm RAW PASS (exit 0).
   ```sh
   RESEARCH_DIR=/workspaces/pi-audit/<tempdir> node /workspaces/base_pi/.pi/research-pair/bin/check-research.mjs 01 --raw-only
   ```
4. Run `pi-condenser` (agent) with the same shared JOB_CONTEXT + QUESTIONS;
   it reads the raw, writes the condensed -x to CONDENSED_X_PATH.
5. Parent: run the real gate to confirm RAW + -x PASS (exit 0; ratio note is
   a note, not a fail).
   ```bash
   RESEARCH_DIR=/workspaces/pi-audit/<tempdir> node /workspaces/base_pi/.pi/research-pair/bin/check-research.mjs 01
   ```
   Observation to fold back: whether the condenser now uses `edit`
   instead of full-file reset-writes (fewer tool calls) and stays glued to the
   “don’t agonise over minor drafting details” rule (fewer iterates). The parent
   real gate remains the only gate of record for advancing.

> **`rm` is NOT a pi built-in tool** (the built-ins are read, bash, powershell,
edit, write, grep, find, ls). Listing `rm` in a subagent’s `tools:` allowlist
aborts the whole run at spawn with “requested unavailable child tools: rm” —
even if the agent never calls it. It has been removed from
`.pi/agents/pi-condenser.md`. The condenser composes edits to leave no stray
files, and the interactive parent does any leftover `rm` cleanup outside the
child. (Validated in test5: the condenser never actually needed `rm`.)


## Placeholders (inject per run)
- JOB_NAME: `pi-audit`
- JOB_CONTEXT: pi-audit is a SQLite audit-sink extension for pi (live collation, failure tracking, OpenRouter latency, cache stats, zero-bloat, Git coupling). Stage 1 goal: map every pi extension hook (ExtensionAPI events + payload shapes) and decide which ones to consume.
- STAGE_TOPIC: Pi extension API & event lifecycle (usage/token event surface)
- RESEARCH_RAW_PATH: /workspaces/pi-audit/<tempdir>/research-stage-01-<slug>-test-raw.md
- CONDENSED_X_PATH:   /workspaces/pi-audit/<tempdir>/research-stage-01-<slug>-test-x.md
- SOURCE_FILES: [
    /usr/local/share/nvm/versions/node/v26.8.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md,
    /usr/local/share/nvm/versions/node/v26.8.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md,
    /workspaces/pi-audit/research-plan.md,
    /workspaces/pi-audit/research/research-stage-01-pi-extension-api.md (seed),
  ]
- TARGET_LINES: extensions.md:1-900; sdk.md:1-500
- SEED_FILES: /workspaces/pi-audit/research/research-stage-01-pi-extension-api.md (verify/correct/augment)
- QUESTIONS: Q1..Q5 (from the runbook; see also `base_pi/.pi/research-pair/prompts/example-stage-08.md`)

## Recommended driver (validated)
Orchestrate directly from THIS interactive session rather than a workflowScript,
when the live gate must run inside the flow:
1. `subagent({ agent: "pi-researcher", task: <fill placeholders>, async: true })` -> writes RAW
2. run bash gate: `RESEARCH_DIR=... node .../check-research.mjs 01 --raw-only`
3. `subagent({ agent: "pi-condenser", task: <same placeholders>, async: true })` -> writes -x
4. run bash gate: `RESEARCH_DIR=... node .../check-research.mjs 01`
The interactive parent has a shell, so the gates run for real.
(Do NOT `await runs.host(...)` inside a workflowScript - it aborts the run. And do NOT spawn the
agents as blocking/foreground - foreground children do not load ambient extensions, so the researcher's
`web_search`/`source_check` tools go missing and the run aborts before writing. Use `async: true`.)

## Configuration gotchas to avoid
- Agent has `grep` builtin, not `rg`. `tools: rg` rejects the whole agent run.
- Spawn both agents with `async: true`. Foreground/blocking children load no ambient extensions →
  the researcher's `web_search`/`source_check` are unavailable and the run aborts (unavailable-tool).
  Foreground is fine only for a pure-local task with those tools stripped from the allowlist.
- Gate resolves `research/` relative to cwd; run from the project root with `RESEARCH_DIR=` set.
- If you *do* use a workflowScript (gate-less flow only), top-level `const`/`await`, NO import/export,
  no nested helpers, no templates in task strings; `subagent({ action: "validate", workflowScriptPath })` first.