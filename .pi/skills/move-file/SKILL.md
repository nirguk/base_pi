---
name: move-file
description: >-
  Procedure for moving or renaming files in a git repo without silently breaking
  cross-references. Use whenever relocating or renaming a file (or folder) that
  other files may mention — docs, configs, scripts, tests.
---

# Move-file — relocation with a reference sweep

Moving a file is easy; the failure mode is silent breakage of references to
it. This is the loop to follow, plus the three guardrails that are usually
the difference between a clean move and a broken one.

## The loop

1. **`git mv <old> <new>`** — moves and stages in one step; git's rename
   detection keeps history and blame intact. Do not use plain `mv` for tracked
   files.
2. **Enumerate references by bare name**: `rg -l '<filename>'` — search the
   *name*, not the full old path, because references are often relative
   (`../terminology.md`) or basename-only. Add `-uu` to include gitignored
   files, since `.gitignore` rules and baseline paths can mention the file too.
3. **Read each hit in context**: `rg -n '<filename>' -C 2`. Decide per hit:
   a real path reference needs updating; a mention of the *concept* the file
   covers may legitimately stay.
4. **Update the genuine references** with `edit` (targeted replacements), not
   a blind global replace — context decides.
5. **Commit the move and the reference fixes together** — one commit, so
   nobody lands between the rename and the updates.

## Guardrails

### 1. Split tracked sources from regenerated outputs first

Rendered or generated artefacts (HTML beside a `.qmd`, `*_files/` asset dirs,
build outputs) must not be renamed alongside their source — that desynchronises
them. The correct move is: update the source's location, delete the stale
artefacts, re-render from the new location. If the artefacts are untracked,
this is often nothing more than re-rendering.

### 2. Verify by running, not just searching

A textual sweep finds literal references. It cannot catch paths composed at
runtime, config-driven reads, or tools with their own path conventions. After
the move, run the project's pinned verification — whatever the repo defines as
its oracle: demo baselines, the test suite, a golden-output diff. If it
passes, the move broke nothing executable.

### 3. Final sweep with `git grep`, and mean it

`git grep '<old-name>'` searches only tracked files — it is the authoritative
"nothing left" check. Hits you deliberately leave (transcripts, legacy notes,
historical records) are fine, but re-seeing them confirms the leave-alone
decision was made consciously, not missed.

## Notes

- The smoke test is project-specific. Do not hard-code one; ask "what does
  this repo pin as its verification?" (a README run section usually says).
- When moving a *directory*, the same loop applies to its contents — search
  for the directory name as well as notable files inside it.
- For Python *module* renames under `src/`, prefer a language-aware rename
  (rope/pyright) over this loop — imports need real refactoring, not text
  replacement.

## Gotchas (learnt the hard way)

- **`git mv` refuses directories holding only ignored/untracked files.** A
  folder whose tracked content is empty (e.g. only a gitignored build
  artefact inside) fails with `fatal: source directory is empty`. Move it
  with plain `mv`, then retarget any `.gitignore` rules that named the old
  path — and re-check `git status` for newly un-ignored outputs, since ignore
  patterns anchored at the old location stop matching after the move.
- **A new parent can silently change linter first-party detection.** Moving
  code under a fresh directory (e.g. `src/` → `code/src/`) can shift how the
  linter classifies imports, producing sort-order failures on lines you never
  touched. Run the linter as part of the post-move verification, not just the
  tests — and expect a config change (e.g. ruff's `src` list) alongside the
  move.