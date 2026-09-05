# AGENTS.md

Project-level instructions for pi.

- `.pi/extensions/` — pi extensions (TypeScript, one `.ts` file per extension)
- `.pi/scripts/` — standalone scripts used by extensions (`.mjs`/`.ts`, run directly with `node`)
- `.pi/git/` — **read-only** upstream clones for reference: search them, never edit, commit, or build in them

There is no package.json or test suite here. When you change a script, verify it by running it; when you change a doc, verify example commands actually work.

## Tool Use Tips

### File Search

#### `findtree` — directory exploration

`findtree` is a pi **extension** (`.pi/extensions/findtree.ts`) that registers a **tool** the LLM can call and a **slash command** (`/findtree`) the user can invoke. It pipes `find` through `tree --fromfile`, collapsing repeated parent-directory prefixes into a compact ASCII hierarchy — fewer tokens, structure visible at a glance. This is the tool to use for any directory exploration task.

**LLM tool call** — the agent calls the `findtree` tool with `path` and `expressions` parameters, plus optional `from` (skip first N find result paths) and `lines` (paths per page, default 100, max 500). Paging is applied at the input level via `tail | head` so `tree` only processes the current page's paths.

**Slash command** — the user types:
```
/findtree . -type f -name "*.ts" -not -path "*/node_modules/*"
/findtree . -type f -name "*.ts" --from 100 --lines 100
```

**Example** — find all `.ts` files across the project (slash command):
```
/findtree . -type f -name "*.ts" -not -path "*/node_modules/*"
```
Output (collapsed tree, not repeated full paths):
```
.
└── src
    ├── components
    │   └── Button.tsx
    ├── hooks
    │   └── useAuth.tsx
    └── utils
        └── helpers
            └── format.ts
```

> ⚠ **`findtree` is a pi tool, not a shell command.** Do not invoke it via `bash` (e.g. `findtree . ... 2>/dev/null || find . ...`). It is not a CLI binary — calling it from a shell will fail silently (or fall through to `find`, losing tree formatting and paging). Always call it through the pi tool system or the `/findtree` slash command.

**Paging**: When results exceed 100 lines, the output is cropped with a footer indicating how many lines remain and the `--from N` value to use for the next page.

#### `fd` — use for flat listing and piping

Use `fd` when you need a flat list of paths (e.g., to pipe into `xargs`, `wc -l`, or another command). It is faster than `find`, uses simpler glob syntax, and respects `.gitignore` automatically.

**Example** — count all `.ts` files:
```
fd --type f --glob "*.ts" . | wc -l
```

**Example** — delete all `.log` files:
```
fd --type f --glob "*.log" . -X rm
```

If `fd` is not installed, use `findtree` instead.

#### Directory inspection — use `findtree`

For any directory, use `findtree` once to see the full structure in a single read. For a single directory, `ls` is fine.

### Content Search (use `rg`, never `grep -r` by default)

- **`rg` is the default for all content searches.** It is faster on large trees and automatically skips `.gitignore`-d directories.
- **Never use `bash grep -r`** for content searches when `rg` is available. If you catch yourself about to, stop and use `rg` instead.
- **If `grep -r` is unavoidable** (e.g., `rg` missing), scope it narrowly so it doesn't recurse into `.pi/` or `node_modules` and time out — e.g. `grep -rn "TODO" src/ --exclude-dir=node_modules`.

| Goal | Wrong | Right |
|------|-------|-------|
| Search file contents | `grep -r "or-metrics" .` | `rg "or-metrics"` |
| Search specific ext | `grep -r "TODO" --include="*.ts"` | `rg -t ts "TODO"` (also `-g '*.ts'`) |
| Invert match | `grep -rv "debug" .` | `rg -v "debug"` |

### File Editing

#### `edit` — precise replacements (primary for targeted changes)

Use `edit` for targeted text replacement. Multiple disjoint changes in one file go in **one call** as an `edits[]` array — do not make N sequential calls. Each `oldText` must be unique and non-overlapping in the file; if two changes touch the same block or nearby lines, merge them into one edit. Keep `oldText` as small as possible while still unique — don't pad with large unchanged regions.

#### `patch` — apply unified diffs (when you have a diff or want reversibility)

`patch` applies a unified diff file to a target file. It is reversible (`patch -R`), composable, and never silently overwrites content — it applies changes line-by-line and reports conflicts.

**Example** — apply a generated diff:
```bash
patch src/index.ts < changes.patch
```

**Example** — undo a patch:
```bash
patch -R src/index.ts < changes.patch
```

**Example** — generate and apply in one step:
```bash
diff -u original.ts modified.ts > changes.patch && patch original.ts < changes.patch
```

#### `write` — new files or complete rewrites

Use `write` only for new files or complete rewrites. Partial updates should use `edit` or `patch`.

#### `bash` with `sed`/`perl` — bulk or programmatic edits

For 3+ changes in a file, or transformations that are awkward as diffs, use `bash` with `sed`, `perl`, or a node script. These operate on the file directly without the file content entering the token stream.

**Example** — in-place replace across a file:
```bash
sed -i 's/old_string/new_string/g' src/config.ts
```

**Example** — structured transformation with node:
```bash
node -e "const fs=require('fs'); const f=fs.readFileSync('data.json','utf8'); const d=JSON.parse(f); d.key='value'; fs.writeFileSync('data.json',JSON.stringify(d,null,2));"
```

### Other Tool Preferences

- **Use `read` over `cat`/`sed`** — handles truncation gracefully and supports offset/limit for large files.
- **Check `~/.pi/agent/AGENTS.md`** for global tips that apply across all projects.

## Before Finishing

- Re-read your diff: check example commands for typos — tool flags are easy to get wrong (this file has had one).
- If you changed a script in `.pi/scripts/`, run it to confirm it executes.
- Confirm you made no edits under `.pi/git/` (read-only reference).