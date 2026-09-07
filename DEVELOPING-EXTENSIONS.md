# Developing pi Extensions Locally

## The core idea

Pi packages are **path-based, not copy-based**. A package can be referenced by a
**local path** in settings just like an npm or git source — and pi transpiles the
`.ts` files **fresh from disk on every startup**. So your working tree with
uncommitted changes *is* the installed package. No copy, no install, no sync step,
ever.

```
"packages": [
  "npm:pi-web-access",
  "git:github.com/nirguk/pi-llm-debugging",
  "/workspaces/pi-prompt-analysis"      ← local dev dir, edited in place
]
```

## The dev loop

1. **Point `.pi/settings.json` at your dev dir** — replace `git:`/`npm:` entries
   with `"/absolute/path/to/your-package"` (relative paths resolve against the
   settings file's directory).
2. **Restart pi.** There is **no `/reload` command** — settings and extensions
   load once at startup. The TUI session you were in keeps whatever was loaded
   when it started.
3. **Edit `.ts` → restart → changes are live.** No re-install, no syncing.
4. **Verify headlessly** when you don't want a TUI run:
   ```bash
   pi -p --no-session --no-approve "Reply with only: OK"
   ```
   Extension console output (e.g. PPA audit blocks) appears in stdout.

## Facts worth remembering

- **Local paths are first-class package sources.** Same slot as `npm:`/`git:` in
  the `packages` array. No `pi install` needed — just edit the JSON.
  `pi install /abs/path` works too and writes the settings entry for you.
- **`pi list` is your source of truth.** Shows each installed package *and its
  resolved path* — use it to catch a stale git clone (checked out from `origin/main`,
  missing your uncommitted work) shadowing your dev dir.
- **Project vs global scope:** project settings = `.pi/settings.json` (`pi install -l`
  writes there). Global = `~/.pi/agent/settings.json`. If the same package appears in
  both, the project entry wins. This repo (`base_pi`) is configured via its own
  `.pi/settings.json` — the mapping is **local to this repo**; other projects need
  their own entry.
- **Package manifest:** `package.json` with `"pi": { "extensions": ["./extensions"] }`
  (or convention dirs: `extensions/` for `.ts`/`.js`, `skills/`, `prompts/`, `themes/`).
  Core deps (`@earendil-works/pi-*`, `typebox`) are bundled by pi — list in
  `peerDependencies` with `"*"`, don't bundle.
- **Duplicates = double-loading.** If both the git version *and* your local path are
  in settings, both load (identical command/flag registrations, duplicate audit
  output). Keep exactly one entry per package.
- **Handshake gotcha:** extensions that fire an automatic first turn on
  `session_start` (like PPA's `handshake hello`) run once per fresh session. New
  code only takes effect in **new** sessions — a `resume`/`--continue` reuses the
  old session state.

## Going back to a published version

```bash
pi install -l git:github.com/you/repo     # restores the git entry
# or edit settings.json back to "git:github.com/you/repo" by hand
```

## Example: `pi-prompt-analysis` (ppa) in `base_pi`

Current state (as of this writing):

- `git:github.com/nirguk/pi-prompt-analysis` → replaced by
  `/workspaces/pi-prompt-analysis` in `.pi/settings.json`
- Verified: `pi list` shows the local path; `node scripts/verify-format.ts` passes;
  `pi -p` run fires all three PPA phases (cold / payload / usage) from the local code.
- Revert anytime with `pi install -l git:github.com/nirguk/pi-prompt-analysis`.

## The one-time verification checklist

When wiring a new local package into settings:

1. `pi list` — entry resolves to your dev path, not a stale clone
2. If the package has a unit-ish script (e.g. `scripts/verify-format.ts`), run it
3. `pi -p` headless run — extension loads without errors, hooks fire
4. Restart the interactive session and exercise the commands (`/ppa`, `/ppa json`, …)

## How this doc stays true

Re-verify commands when pi's behavior changes (`pi --version` bumps, settings
schema changes). The facts here were checked against pi `0.85.1`:
`pi list`, local-path sources in packages.md, no `/reload` command, fresh-session
handshake semantics.