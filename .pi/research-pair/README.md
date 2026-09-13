# Research Pipeline — Orchestration

Parent-facing runbook for the pi research pipeline. Two cooperating subagent prompts live in this folder:

- **`researcher.md`** — produces the **raw** research file (`{{RESEARCH_RAW_PATH}}`).
- **`condenser.md`** — produces the **condensed `-x`** file (`{{CONDENSED_X_PATH}}`).

Spawn **`researcher.md` first, then `condenser.md`**, injecting every placeholder below with concrete values. Do **not** hardcode output paths into either agent — always inject `{{RESEARCH_RAW_PATH}}` / `{{CONDENSED_X_PATH}}` externally per run.

## Placeholder index

Shared vocabulary used by both agents. Fill every `Required: yes` entry per run.

| Placeholder | Meaning | Researcher | Condenser | Required |
|---|---|---|---|---|
| `{{JOB_NAME}}` | Short name for the research job | ✓ | ✓ | yes |
| `{{JOB_CONTEXT}}` | Shared project goal + stage objective — the SAME text injected into both agents | ✓ | ✓ | yes |
| `{{STAGE_TOPIC}}` | Human description of the stage topic | ✓ | — | yes |
| `{{RESEARCH_RAW_PATH}}` | Absolute write-path for the raw file | ✓ (writes) | ✓ (reads) | yes |
| `{{CONDENSED_X_PATH}}` | Absolute write-path for the `-x` file | — | ✓ (writes) | yes |
| `{{SOURCE_FILES}}` | Source materials to read/inspect (paths) | ✓ | ✓ (fallback) | yes |
| `{{TARGET_LINES}}` | Exact `file:line` ranges in the sources | ✓ | ✓ (fallback) | yes |
| `{{QUESTIONS}}` | The orchestrator's **minimum question set** for the stage — the SAME text injected into BOTH agents | ✓ | ✓ | yes |
| `{{SEED_FILES}}` | Prior uncondensed research to seed the researcher; `<none provided>` if none | ✓ | — | yes (may be empty) |
| `{{SEARCH_ANGLES}}` | Web-search angle hints; `<none provided>` if only local sources suffice | ✓ | — | no |

---

## Why the two agents differ (latitude and threshold, not awareness)

The two agents are **not** separated by knowledge — **both** receive the same `{{JOB_CONTEXT}}` (project goal + stage objective) and reason toward it. Their real difference is **latitude of motion and the folding-bar**:

- **`researcher`** — ranges the **widest** (web + local), keeps a **low surface-threshold**, and deliberately over-covers so nothing decision-relevant is lost. It uses `{{JOB_CONTEXT}}` to gather purposefully, but casts a broad net.
- **`condenser`** — works only from the raw + draft, takes the **narrower latitude** and a **higher folding-bar**, collapsing breadth to what is decision-relevant while preserving the reasoning.

Consequence: the orchestrator authors **one minimum question set** (`{{QUESTIONS}}`) and injects the **same text into both agents**. The researcher gathers around each question broadly (low bar, web freedom); the condenser closes and folds each question to decision-relevant (high bar). It is normal and intended for a candidate fact or answer to appear at both stages — surfaced at low threshold, folded at high threshold.

---

## Running a stage via `run-stage.mjs` (gate automation)

The deterministic gate lives in **`base_pi/.pi/research-pair/bin/check-research.mjs`** (structural: existence, length, required sections, ratio note). The orchestration scaffold is **`base_pi/.pi/research-pair/bin/run-stage.mjs`** — a Node scaffold + gate *prep*, NOT an agent-spawner (pi host must launch the sub-agents).

Run them from the **project root** (whose `research/` dir has the stage files); the scripts resolve `research/` against `process.cwd()`, so you can use the canonical absolute path or a local symlink:

```bash
cd /workspaces/<project>
node /workspaces/base_pi/.pi/research-pair/bin/run-stage.mjs 08      # or: ./run-stage.mjs if a symlink is present
```

**When to use it:** per stage, between the two agent launches and after each lands.

```bash
node run-stage.mjs 08            # preconditions + print next steps + gate current files (raw + x)
node run-stage.mjs 08 --gate-only  # just run the gate (post-researcher or post-condenser)
```

Flow to run a stage end-to-end:
1. `node run-stage.mjs NN` — confirm clean, see next steps.
2. Spawn `pi-researcher` (workflowScript, see below) → it writes the raw.
3. `node run-stage.mjs NN --gate-only` → must PASS before continuing.
4. Spawn `pi-condenser` → writes the `-x`.
5. `node run-stage.mjs NN --gate-only` → final gate (raw + x).

If the gate FAILs after an agent, use the **resume** path below to have that agent fix + rewrite, then re-gate.

## Orchestration steps (parent)

1. **Inject** every `Required: yes` placeholder in both prompts with concrete values. Always set the two output paths yourself.
2. **Spawn `pi-researcher` (background/`async: true`)** — foreground/blocking children do not extend their
   ambient-extension web tools, so the researcher would abort. It writes the raw file.
3. **Verify** `{{RESEARCH_RAW_PATH}}` exists and is non-empty.
4. **Spawn `pi-condenser` (background/`async: true`)** — same background requirement.
5. **Verify** `{{CONDENSED_X_PATH}}` exists and is non-empty.

### Foreground/background gotcha

- **Foreground child + web tool = abort.** A child spawned with `async: false` does not load ambient
  extensions, so any `web_search` / `fetch_content` / `source_check` in its allowlist is unavailable and
  pi marks the run failed before it does work (the tool description warns MCP/extension/web tools must run
  as **background children**).
- **Parent gates need a shell — the parent must be the interactive session, not a child.** That is why the
  driver lives in the parent: only the parent can run `node check-research.mjs`.
- **Foreground is acceptable only** for a pure-local task (no web tools in the allowlist/contract).
  Otherwise stay in background mode.

### Minimal valid workflowScript (validated reference)

A `workflowScript` for the pair has a fixed shape. Notes from a real run (these cost a draft fix if missed):

- top-level `const` + top-level `await` only — **no `import`/`export`**, no nested `async function`/arrow helpers;
- keep `runs.run` args as plain-string arrays joined with `\n` — no backticks in the task text;
- gate needs `RESEARCH_DIR=` (project research dir) + the canonical absolute script path.

> **IMPORTANT — validated `2026-09-13`: `runs.host(...)` is unavailable in a workflowScript runner.**
> Both the background (`async`) and the blocking (`async:false`) runs rejected `runs.host` with
> “unknown resource provenance” / “unavailable in this host context”. The workflowScript runner is
> not a permission-sensitive host resource. **Therefore the live gate steps cannot run inside the
> workflow**; they must be run by the interactive **parent** session (you), which has a shell.
> The pattern that works:
> - agents self-gate by mirroring `check-research.mjs`'s string checks (they can’t execute `node`),
> - the parent gates the real artifact after each leg:
>   `RESEARCH_DIR=… node …/check-research.mjs NN`, then advances.
> Do NOT write the workflow to `await runs.host(...)` — that aborts the run. (The `runs.host` example
> below is retained only as the *intended-when-available* shape, not as current behaviour.)
>
> **Recommended driver:** orchestrate from the interactive **parent** session (this session), not a
> workflowScript at all, when the live gate must run inside the flow: spawn `pi-researcher` **as a
> background (`async: true`) child**, parent runs the gate command, spawn `pi-condenser` **as a
> background (`async: true`) child**, parent runs the final gate. The interactive parent
> has a shell, so the gate runs literally — no `runs.host`, no abort. Example snippet below shows one way.
>
> **Why background, not blocking:** both agents must be spawned as background children
> (`async: true`). Foreground/blocking (`async: false`) children do not load ambient extensions, so
> the researcher's `web_search` / `fetch_content` / `source_check` tools are unavailable and the run
> aborts at spawn (unavailable-tool) or produces a web-less raw. The agent legs therefore require
> background mode. The gates stay in the interactive parent (which has an actual shell); agents cannot
> execute `node`, so their self-gate is a static mirror and the parent run is the authoritative gate.

```js
const RAW = "/workspaces/<proj>/research/research-stage-01-x.md";
const X   = "/workspaces/<proj>/research/research-stage-01-x-x.md";
const DIR = "/workspaces/<proj>";
const GATE = "/workspaces/base_pi/.pi/research-pair/bin/check-research.mjs";

await runs.run("researcher", { agent: "pi-researcher", task: researcherTask });       // writes RAW
await runs.host("res-gate", { kind: "command",
  command: "RESEARCH_DIR=" + DIR + " node " + GATE + " 01 --raw-only", timeoutMs: 60000 });
await runs.run("condenser", { agent: "pi-condenser", task: condenserTask });           // RAW -> X
await runs.host("final-gate", { kind: "command",
  command: "RESEARCH_DIR=" + DIR + " node " + GATE + " 01", timeoutMs: 60000 });
```

Validate offline before running with `subagent({ action: "validate", workflowScriptPath })`.

## Recovery loop

If either file is missing or empty after the agent returns:

- `subagent({ action: "resume", id: <run id>, task: "Write the file now; do not re-read sources." })`
- Retry **once**. If it fails again, stop and report: exact run/status, file state, and the attempted resume (a lane blocker). Do not silently switch execution mode.

Success signal = a non-empty file at the expected absolute path.

## Why disk-write instead of a reply code-block

Both agents **write to disk** rather than returning the artifact in-chat. This makes recovery **gated on a checkable artifact** (file exists + non-empty) instead of a lossy chat reply. A partial/missing file is an obvious, resumable failure; a dropped reply is not.

- `resume` is a workable second-chance — the agent re-produces the artifact, not re-research.
- If a given deployment can't grant a write tool to the condenser, fall back to "return full markdown in reply; parent writes" — but that is the fallback, not the default.

## Consistency with the reference pattern

The two agent prompts mirror the pi `researcher` / `reviewer` agent-file convention (frontmatter `---` block, `tools`, `thinking`, `systemPromptMode`, per-role rules, output contract, "Return to parent" section). Reviewer-only reads in the model set; the `condenser` deviates from the review-only `reviewer` in exactly one way: it is granted `write` so it owns its own artifact.