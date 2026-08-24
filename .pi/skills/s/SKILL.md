---
name: s
description: Web search with workflow mode set to 'none' (no curator). Use /s or /skill:s followed by a search query to perform web searches without opening the interactive curator.
---

# Web Search (no curator)

## Usage

```
/skill:s <search query>
```

Or simply:

```
/s <search query>
```

## Behavior

This skill performs a web search with `workflow: "none"`, so the interactive curator is **not opened**. Results are returned directly inline.

## How to use

1. The user supplies a search query via `/s <query>` or `/skill:s <query>`
2. Use the `web_search` tool with the following defaults:
   - `workflow: "none"` — no curator, results returned inline
   - `query` — the user's search query
   - Other parameters (`provider`, `numResults`, `includeContent`, etc.) can be specified as needed