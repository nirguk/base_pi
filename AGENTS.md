# AGENTS.md

Project-level instructions for pi.

## Tool Use Tips

- **Prefer `findtree` over `find`** — collapses repeated parent-directory prefixes and is more token-efficient for broad directory searches.
- **Prefer `rg` (ripgrep) over `grep -r`** — much faster on large trees; uses `.gitignore` to skip irrelevant dirs automatically. Available at `~/.pi/agent/bin/rg`.
- **Prefer `fd` over `find`** — faster, simpler syntax, respects `.gitignore`. Available at `~/.pi/agent/bin/fd`.
- **Use `bash` with targeted paths** — if `grep -r` is needed, scope it narrowly; recursive grep over `.pi/` with nested `node_modules` can time out.
- **Use `read` over `cat`/`sed`** — `read` handles truncation gracefully and supports offset/limit for large files.
- **Use `edit` for precise changes** — match exact `oldText` blocks; avoid overlapping edits in a single call. For multiple disjoint changes in one file, include them all in one `edits[]` array.
- **Use `write` only for new files or complete rewrites** — partial updates should use `edit`.
- **Check `~/.pi/agent/AGENTS.md`** for global tips that apply across all projects.

## Project Structure

- `.pi/extensions/` — pi extensions (TypeScript)
- `.pi/scripts/` — standalone scripts used by extensions
- `.pi/git/` — cloned upstream repos for reference
