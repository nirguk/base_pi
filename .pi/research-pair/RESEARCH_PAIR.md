# pi-research-pair — living specification

> **This is the maintained record for the `pi-research-pair` workflow class.** Update this file
> whenever you refine the pattern (agent prompts, gate, orchestration, docs). It is the canonical
> home; **AGENTS.md** and **README.md** hold only pointers / condensed run usage.
>
> Status: **active & validated** on Stages 1 + 8 of pi-audit.

---

## Summary

A **two-agent research pipeline + deterministic gate**, for producing evidence-backed research
with verifiable artifacts (raw + condensed `-x`), for projects that need per-stage research.

```
[researcher]  raw  ── gate ──>  [condenser]  -x  ── gate ──>  reviewable decision doc
```

- **`pi-researcher`** — broad, low-threshold **gatherer**: writes the **raw** (≥ ~100 lines) from
  web + local sources. Wide latitude.
- **`pi-condenser`** — narrow, high-threshold **fold**: reads the raw, writes a **narrative-preserving
  `-x`** (30–50% is a *hope*, not a gate), keeping *why* (why-care / approach / decisions &
  rationale / open questions). A human can review the whole `-x` without touching raw.
- **Deterministic gate** (`check-research.mjs` / `run-stage.mjs`) — validates **structure**
  (exists, length, sections, ratio-note) **without reading content into model context**. Both
  agents self-gate after writing. Ratio is a note, not a fail.

## Placement & relationships

The canonical, reusable workflow assets live in **`base_pi/.pi/research-pair/`**. Each pi-audit (or any project) that runs this pipeline points its `research/`-rooted execution at this shared copy. Project-specific products (the `research/` output files, `research-plan.md`, `HANDOVER.md`) stay in the owning project repo — they are not part of the reusable workflow.

| File | Purpose | Maintain? |
|---|---|---|
| **`base_pi/.pi/research-pair/RESEARCH_PAIR.md`** (this file) | living spec | **yes — update on every refinement** |
| `base_pi/.pi/agents/pi-researcher.md`, `pi-condenser.md` | callable agent definitions (+ self-gate clause) | yes |
| `base_pi/.pi/research-pair/bin/check-research.mjs`, `bin/run-stage.mjs` | deterministic gate + scaffold | yes |
| `base_pi/.pi/research-pair/README.md` | runbook: placeholders, workflowScript, recovery | partial (run-enable) |
| `base_pi/.pi/research-pair/prompts/researcher.md`, `prompts/condenser.md` | agent prompt templates (spawned via runbook) | yes |
| `base_pi/.pi/research-pair/prompts/example-stage-08.md` | worked example fill | yes |
| `base_pi/AGENTS.md` → `#### pi-research-pair` | condensed pointer for a fresh session | **thin — should only point here + one-line** |
| (project, e.g. `pi-audit/`) `check-research.mjs`, `run-stage.mjs`, `prompts/` | **symlinks** onto the base_pi canonical copies so project-local execution keeps working | no (do not edit — regenerate via symlink) |

## Running for a project

Execute the gate/scaffold from the **project's** root (where its `research/` dir lives), referencing the canonical base_pi script:

```bash
cd /path/to/<project>          # the repo whose `research/` dir holds the stage files
node /workspaces/base_pi/.pi/research-pair/bin/run-stage.mjs 08 --gate-only
```

The scripts resolve `research/` relative to **`process.cwd()`**, not the script's own path, so running from the project root always finds the right research tree. `/workspaces/<project>/check-research.mjs` may exist as a symlink to the canonical copy for convenience (see the pi-audit example).

## Why we extended traditional sub-agents

A single generic `researcher` either **over-gathers** (a huge raw; context-heavy) or **under-supports decision work**. The pair decomposes the failure:

- separate **gather** from **decide/fold** (different latitude + folding bar),
- add a **deterministic gate** so "shape" is verified without a human reading raw into context,
- keep **human review on the `-x`** (the short artifact), not the raw.

This is the design response to: quality of research + context hygiene + reproducible verifiability.

## Key decisions (log — append as you refine)

- **Both agents see the same orchestrator-authored `QUESTIONS` + `JOB_CONTEXT`.** The difference is
  latitude/threshold, NOT which questions they answer. (Was:* different question sets. Reverted.)
- **Condensation ratio is a HOPE, not a gate** (do not fight to enforce 30–50%). (Was:* hard cap.
  Reverted.) Checker reports out-of-range only as a note.
- **Write-to-disk, not reply-code-block** — recovery = checkable artifact (file exists/non-empty),
  and the `-x` stays out of the main model context.
- **Deterministic self-gate** — each agent runs `check-research.mjs` after writing and iterates.
- **Numbering drift in `##` headers is OK / cosmetic** — not a gate; downstream can parse.
  (Exception not needed: as long as a single file's numeric `## N` headers stay consistent, the
  `inconsistent_section_numbering` check passes; mixing `## F.1` and `## 3.6` in one file fails.)
- **`pi-condenser` also runs as a background child** — it needs `write` + `read` and consistent tool loading
to mirror the researcher's spawn mode. The runbook's earlier "blocking" phrasing applied to the
condenser as well and should be read as *background*.
- **Keep raw ≥ ~100 lines; require section markers** (findings / questions / contradictions /
  gaps / sources) — tolerant of both `F.N` + `(Q#)` and `Q#` conventions.
- **Q-numbers etc. cosmetic**: do not tune the prompts to enforce uniform `Q` headers.
- **Researcher fresh-context, condenser fresh-context** (no inherited session chatter).
- **Spawn both agents as background (`async: true`) children.** Both prompts require web/mcp tools
  (`web_search`, `fetch_content`, `source_check`) in the researcher's allowlist, and ambient-extension
  tools load **only** for background child agents. A foreground/blocking child gets none of those
  tools and either aborts at spawn (unavailable-tool) or produces a web-less, structure-weakened raw.
  The pipeline therefore *depends* on background mode for the agent legs. The real `check-research.mjs`
  gate still runs in the **interactive parent** (which has a shell) after each leg — the agents cannot
  execute `node`, so their self-gate is a static mirror of the gate's checks, and the parent's run is
  the authoritative one.

  **Corrected pattern (validated 2026-09-13):** the earlier guidance said spawn the researcher/condenser
  as *blocking* (`async: false`) children. That is wrong — a foreground child does not load ambient
  extensions, so the researcher's web tools are unavailable and the run aborts before writing. Use:

  ```
  spawn pi-researcher  (async: true / background)   # writes raw  (web tools load)
  parent: node check-research.mjs NN --raw-only      # real gate, exit 0
  spawn pi-condenser   (async: true / background)   # writes -x   (writes + reads locally)
  parent: node check-research.mjs NN                # real gate, RAW + -x, exit 0
  ```

  Foreground is only acceptable when the agent's task requires **no** web/mcp tools (pure local
  `read`/`grep`/`write`) — in which case keep those tools out of the task's allowlist/contract too.

## Run path (from `prompts/README.md`)

```
node run-stage.mjs NN            # preconditions + gate + next steps
spawn pi-researcher (async/bg)  # writes raw   <- background: web tools load
node run-stage.mjs NN --gate-only
spawn pi-condenser (async/bg)    # writes -x
node run-stage.mjs NN --gate-only   # final gates raw + x
```

> **Spawn both legs as BACKGROUND (`async: true`) children.** Foreground/blocking children do not
> load ambient extensions, so the researcher's `web_search`/`source_check` tools are unavailable
> (run aborts). The parent runs the real `check-research.mjs` gate after each leg.

See `prompts/README.md` (under `base_pi/.pi/research-pair/`) for the placeholder table + spawn syntax. `AGENTS.md` (base_pi)
carries a one-line pointer + invocation phrase.

## Future work (track here)

- [x] **Consolidate reusable assets into `base_pi/.pi/research-pair/`** (canonical home; projects symlink onto it) — so `base_pi` owns the full paired-research toolchain.
- [ ] (future optional) Promote to a **pi extension** (`pi-research-pair`) — move `research-pair/` contents into an extension package under `.pi/extensions/` when it needs runtime/tool integration.
- [ ] Decide `-x` audience doc split (human vs build-agent) if cohesion requires.

_Last updated: 2026-09-13 (Stages 1+8 validated)._