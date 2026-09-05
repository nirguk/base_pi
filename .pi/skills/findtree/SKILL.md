---
name: findtree
description: >-
  Prefer findtree over the built-in `find` tool when searching broad directory
  trees or when results are expected to span many subdirectories. findtree pipes
  `find` through `tree --fromfile`, collapsing repeated parent-directory
  prefixes into a single hierarchy — this dramatically reduces token consumption
  compared to the flat per-line output of the built-in `find`.
---

# findtree — Token-efficient file search with input-level paging

`findtree` is a pi **extension** (`.pi/extensions/findtree.ts`) that registers
a **tool** the LLM can call and a **slash command** (`/findtree`) the user
can invoke. It wraps `find` piped through `tree --fromfile -A` to produce a
compact ASCII tree. Paging is applied at the input level using `tail | head`
so `tree` only processes the current page's paths — bounding memory and CPU.
Each page shows a self-contained subtree for those paths.

## When to use findtree vs the built-in find

| Use-case | Prefer | Why |
|----------|--------|-----|
| Broad search across many directories | **findtree** | Tree hierarchy avoids repeating parent paths on every line |
| Deeply nested directory trees | **findtree** | Hierarchy shows structure at a glance; fewer tokens |
| Simple flat search (one directory, many files) | `find` (built-in) | Tree overhead adds no value for a flat list |
| Pattern search inside a single flat directory | `find` (built-in) | The tree is just one root node — no savings |
| Exploring unknown codebase structure | **findtree** | Visual hierarchy reveals project layout |

## Example

Given a search across `src/` with matches in `src/components/`, `src/hooks/`,
and `src/utils/helpers/`:

- **built-in `find`** output: `src/components/Button.tsx`, `src/hooks/useAuth.tsx`,
  `src/utils/helpers/format.ts`, `src/utils/helpers/parse.ts` — 4 lines, repeated prefixes
- **findtree** output: single tree with `src/` → `components/`, `hooks/`, `utils/helpers/`
  — fewer tokens, structure visible at a glance

## Usage

**As a tool** (the LLM calls it with parameters):
- `path` — directory to search (default: `.`) 
- `expressions` — find expressions as an array of strings
- `from` — skip the first N find result paths before building the tree (default: 0)
- `lines` — max find result paths per page (default: 100, max: 500)

**As a slash command** (the user types in the TUI):
```
/findtree . -type f -name "*.ts" -not -path "*/node_modules/*"
/findtree . -type f -name "*.ts" --from 100 --lines 100
```

## Paging large results

Paging is applied at the input level: `tail | head` limit the find results
fed to `tree` so only the current page's paths are processed. Each page
shows a self-contained subtree for those paths. Different pages may show
different root-level directories.

Use `--from N` to skip the first N paths and `--lines N` to set the page
size:

```
# First page (default, up to 100 paths)
/findtree . -type f -name "*.ts"

# Next 100 paths (skip the first 100)
/findtree . -type f -name "*.ts" --from 100

# Custom page size (up to 500 paths per page)
/findtree . -type f -name "*.ts" --lines 200

# Page 3: skip 200 paths, show 100
/findtree . -type f -name "*.ts" --from 200
```

The `--lines` value is capped at 500 to prevent runaway output. The footer
includes a `--from` hint so you can copy-paste the next page command.