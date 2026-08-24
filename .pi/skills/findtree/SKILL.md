---
name: findtree
description: >-
  Prefer findtree over the built-in `find` tool when searching broad directory
  trees or when results are expected to span many subdirectories. findtree pipes
  `find` through `tree --fromfile`, collapsing repeated parent-directory
  prefixes into a single hierarchy — this dramatically reduces token consumption
  compared to the flat per-line output of the built-in `find`.
---

# findtree — Token-efficient file search

findtree is a drop-in replacement for the built-in `find` tool that wraps the
same `find` command but pipes results through `tree --fromfile -A` to produce
a compact ASCII tree.

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

```
findtree . -type f -name "*.ts" -not -path "*/node_modules/*"
findtree . -mtime -1 -not -path "*/.git/*"
findtree . -size +5M
```