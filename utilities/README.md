# utilities

Small shared tools kept in base_pi so every project can use them.

## methodmap-cs

Copy of PlantWise's `tools/MethodMap` (Roslyn-based C# method lister).
Canonical home; PlantWise keeps its own working copy.

## methodmap-py

Python equivalent: `methodmap-py/methodmap.py`. Walks `*.py` files,
lists functions and methods per file with line numbers, ends with a
`TOTAL ...` line in the same shape as the C# tool.

Run it with plain `python3` — standard library only (`ast`).

## Wiring into pi-size-hello

`size-hello` runs its `mapCommand` **inside the project container**,
which can only see its own repo — not this folder. So a project that
wants the map line needs its own in-repo copy of the script, e.g.:

```json
"/workspaces/congruent_roster": {
  "alias": "congruent_roster",
  "label": "congruent_roster",
  "exts": [".py"],
  "containerPath": "/workspaces/congruent_roster",
  "mapCommand": ["python3", "tools/methodmap.py", "."],
  "mapTimeoutMs": 120000
}
```

Keep this folder as the source of truth; copy out to projects on demand.
