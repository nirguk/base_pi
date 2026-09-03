# AGENTS.md

Project-level instructions for pi.

## Tool Use Tips

### File Search

#### `findtree` — default for broad directory searches

Use `findtree` as the first choice when searching across many directories or when results span a deep tree. It pipes `find` through `tree --fromfile`, collapsing repeated parent-directory prefixes into a compact ASCII hierarchy — fewer tokens, structure visible at a glance.

**Example** — find all `.ts` files across the project:
```
findtree . -type f -name "*.ts" -not -path "*/node_modules/*"
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

**Never use bare `bash find`** for filename searches — reach for `findtree` or `fd` first.

### Content Search (use `rg`, never `grep -r`)

- **`rg` is the default for all content searches.** It is faster on large trees and automatically skips `.gitignore`-d directories.
- **Never use `bash grep -r`** for content searches. If you catch yourself about to, stop and use `rg` instead.
- **If `grep -r` is unavoidable**, scope it to a narrow path so it doesn't recurse into `.pi/` or `node_modules` and time out.

| Goal | Wrong | Right |
|------|-------|-------|
| Search file contents | `grep -r "or-metrics" .` | `rg "or-metrics"` |
| Search specific ext | `grep -r "TODO" --include="*.ts"` | `rg "TODO" --ext ts` |
| Invert match | `grep -rv "debug" .` | `rg -v "debug"` |

### File Editing

#### `patch` — apply unified diffs (primary for targeted changes)

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

#### `edit` — precise single-change replacement

Use `edit` for one targeted text replacement at a time. Match exact `oldText` blocks; avoid overlapping edits in a single call. For multiple disjoint changes in one file, include all in one `edits[]` array.

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

## Project Structure

- `.pi/extensions/` — pi extensions (TypeScript)
- `.pi/scripts/` — standalone scripts used by extensions
- `.pi/git/` — cloned upstream repos for reference
