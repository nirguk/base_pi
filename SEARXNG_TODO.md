# SEARXNG_TODO.md

Status notes about making **SearXNG the reliable, deterministic web-search provider**
for pi in this environment. Not urgent web-search infra — parked while the Quarto /
`congruent_roster` work is the priority, but the **core config defect has been fixed**
(see §2–3). This document records the corrected root cause and what (if anything)
remains to do.

- **Origin session:** `2026-09-10` (pi, congruent_roster work)
- **Status:** root-caused + config fix applied. Two follow-ups remain optional (§5).
- **Version caveat:** this was traced against `pi-web-access@0.28.0`.

---

## 1. Symptoms observed

A `researcher` subagent (`inclusionai/ling-3.0-flash`) doing web research repeatedly hit:

```
Auto provider search failed:
  - Exa: Exa MCP rate limit reached
```

and, later, while being asked to use SearXNG:

```
Error: SearXNG base URL is invalid or missing.
  1. Create /workspaces/base_pi/.pi/web-search.json with { "searxngBaseUrl": "https://search.example.com" }
  2. Set SEARXNG_BASE_URL to an HTTP(S) URL
```

Two distinct defects contributed; the second is the actual root cause.

## 2. Root cause (corrected)

There were **two independent problems**, and the first one I recorded initially was
**not the real blocker**.

### 2a. The config pi-web-access reads was MISSING (the true root cause)

`pi-web-access` resolves its config file via `getWebSearchConfigDir()` in
`/opt/pi-npm-store/npm/node_modules/pi-web-access/utils.ts`:

```ts
const explicitDir = process.env.PI_CODING_AGENT_DIR;
if (explicitDir) return cachedWebSearchConfigDir = explicitDir;   // <= short-circuits
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
if (xdgConfigHome) { const xdgDir = join(xdgConfigHome, "pi"); ... }
return join(homedir(), ".pi");
```

In this environment `PI_CODING_AGENT_DIR=/workspaces/base_pi/.pi`, so the config path
pi-web-access actually reads is

**`/workspaces/base_pi/.pi/web-search.json`**

That file **did not exist** → `loadConfig()` returned `{}` → SearXNG base URL
"invalid or missing".

- The file at **`.pi/pi/web-search.json`** (note the extra `pi/`) I initially pointed at
  is a **misplaced/orphan config** — no code reads it (only the package README mentions
  that path). It was misleading; do NOT mistake it for the live config.

### 2.2. The `web_search` tool description over-encourages Exa (secondary)

The `web_search` tool description (`pi-web-access/index.ts`, ~line 1786) contains:

> "Without a configured provider, **SearXNG is preferred first** ... **Otherwise Exa is
> preferred** before OpenAI, then Brave, Parallel, ..."

That paragraph describes the harness's *internal `auto` fallback order* but reads as
guidance — a lightweight subagent infers `provider: "exa"` is the sanctioned choice and
passes `exa` explicitly. Independently of config, that description text nudges subagents
toward Exa.

Also confirmed from source: `resolveRequestedProvider(requested)` returns an explicit
`provider` arg **before** consulting config, so an explicit `exa` bypasses SearXNG even
once config exists. Both causes were real; the missing config is the one that fully
explains "SearXNG unusable".

## 3. FIX APPLIED

Created the file pi-web-access actually reads:

**`/workspaces/base_pi/.pi/web-search.json`**
```json
{
    "provider": "searxng",
    "searxngBaseUrl": "http://172.17.0.1:8080",
    "ssrf": { "allowRanges": ["172.17.0.0/16"] }
}
```
- File path matches `getWebSearchConfigPath()` in this environment (verified).
- Schema keys are valid (`provider`, `searxngBaseUrl`, `ssrf.allowRanges` — confirmed in
  `index.ts` `WebSearchConfig`).
- SearXNG server reachable from the harness (`curl http://172.17.0.1:8080/` → 200).

> **Caveat:** `searxng.ts` / `index.ts` cache the config in a module-level
> `cachedConfig`. If pi is already running, a newly created/changed `web-search.json`
> may not be re-read until the pi process restarts (or the extension reloads). **Restart
> pi (or reload the web-access extension) after writing the file** to be safe.

## 4. `html-table-processing: none` research (parallel thread)

Separate research (see the same session) established: for Quarto **HTML output**,
`html-table-processing: none` is **practically unavoidable** for tables that combine
grouped/multi-index headers (spanners) with per-cell styling (e.g. red-bold). Neither
pandas `Styler` nor `Great Tables` survives Quarto's `data-quarto-postprocess` intact.
Narrower opt-outs exist: `data-quarto-disable-processing="true"` (`<table>` attr) and
`#| html-table-processing: none` (cell option). That's a **Quarto** decision, parked
pending the roster Phase-4 implementation — not a search-provider issue.

## 5. Remaining (optional) follow-ups

### 5a. Neutralize the "Otherwise Exa is preferred" description (recommended)
Now that the config exists, subagents omitting `provider` get SearXNG automatically.
But the description still says "Otherwise Exa is preferred," which can still lure a
subagent into passing `exa` explicitly (and that explicit arg overrides config). Options:
- **Dispatch-level (cheapest, no code):** instruct research subagents to pass
  `provider: "searxng"` (or omit `provider`), never `exa`.
- **Project extension override:** re-register/override the `web_search` tool description
  to drop the ambiguous clause and state the pinned configured provider is SearXNG.
  Survives store rebuild; verify pi's `registerTool` duplicate-name semantics first.
- **Upstream nudge:** file issue/PR on `posit-dev/pi-web-access` so the description is
  config-aware (omit the "Otherwise Exa is preferred" sentence when a provider is set).

### 5b. Fork decision (parked)
A lean SearXNG-only rewrite of `pi-web-access` (keep SearXNG + SSRF + config; drop
Exa/etc + curator) is the "keep the good, cut the rest" play. **Parked** — heavy to
maintain; revisit only if 5a proves insufficient. Do it in its own session/branch.

## 6. Verification recipe

After restarting pi:
```bash
S=<researcher session-jsonl>
grep -oE '"provider":"[a-z]+"' "$S" | sort | uniq -c   # expect searxng, not exa
grep -c "searxngBaseUrl" /workspaces/base_pi/.pi/web-search.json   # 1
curl -s -o /dev/null -w "%{http_code}\n" http://172.17.0.1:8080/   # 200
```
And confirm search results no longer warn "SearXNG base URL is invalid or missing".

## 7. Changelog
- 2026-09-10: fixed config path (root cause §2.1); created `.pi/web-search.json`;
  corrected this doc. Description-wording issue (§2b/5a) remains optional.