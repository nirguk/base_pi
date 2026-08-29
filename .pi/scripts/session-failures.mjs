#!/usr/bin/env node
/**
 * session-failures.mjs — deterministic analysis of failed turns across pi sessions.
 *
 * Scans pi session JSONL files under the pi sessions directory (or a custom
 * directory), and reports assistant turns that failed to complete and tool
 * calls that errored — grouped by model slug, session, day, or category.
 *
 * Deterministic by design:
 *   - no network calls, no environment drift
 *   - fixed output ordering (sorted groups, then timestamp, then id)
 *   - robust JSONL parsing (skips malformed lines instead of aborting the
 *     whole stream — unlike a single `jq` pass)
 *
 * Usage (invoked from pi via /failures, or directly):
 *   node session-failures.mjs [--dir <PATH>] [--since <DAYS>]
 *       [--session <ID>] [--by provider|slug|session|day|category] [--kind all|assistant|tool]
 *       [--json] [--detail] [--limit <N>] [--top <N>]
 *       [--secondary provider|slug|session|day|category]
 *
 * The default view is a primary × secondary cross-tab: `/failures`
 * behaves like `--by provider --secondary category`, i.e. providers as
 * rows with error-type breakouts. Pass `--secondary ""` (or an explicit
 * `--by` with `--secondary` equal to it) to collapse back to a single-
 * dimension summary.
 *
 * Provider lens (the default): each failure is attributed to the OpenRouter
 *   upstream provider that actually served them (e.g. baidu, digitalocean,
 *   novita, deepinfra, z.ai) — parsed from the `provider_name` embedded
 *   in the JSON error body within provider-error messages (handles the
 *   `provider_name":"Value"` JSON format that a simple regex cannot).
 *   Falls back to the pinned route (`openrouter-baidu` → `baidu`), then
 *   the parent model chain, then "unknown". The old per-model slug
 *   grouping stays available via `--by slug`.
 *
 * Cross-tabulation (`--secondary <dim>`): when a secondary dimension is
 *   supplied, the summary view renders a primary × secondary count matrix
 *   (e.g. `--by provider --secondary category` shows, per provider, how
 *   many failures fall into each category; `--by category --secondary
 *   provider` inverts the view). With `--detail`, the primary grouping
 *   alone is used for both the summary and the per-group breakdown rows.
 *   `--secondary` is ignored under `--json`.
 *
 * Examples:
 *   /failures                          # summary + per-provider table (default)
 *   /failures --by provider            # same lens, explicit
 *   /failures --by session             # grouped per session
 *   /failures --since 3                # only last 3 days
 *   /failures --session 01a04da1       # one session (prefix match)
 *   /failures --json --detail          # machine-readable, full rows
 *   /failures --by provider --secondary category  # cross-tab: errors per provider
 *   /failures --by category --secondary provider  # inverted cross-tab
 *
 * Exit code 0 = analysis completed (even if zero failures found).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, parse } from "node:path";
import { homedir } from "node:os";

// ─── Argument parsing (deterministic subset: flags with values or bare flags) ───
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}
function hasFlag(name) {
  return args.includes(name);
}

const DIR = flag("--dir", join(homedir(), ".pi", "agent", "sessions"));
const SINCE_DAYS = Number(flag("--since", "0")) || 0;
const SESSION_PREFIX = flag("--session", "");
const BY = flag("--by", "provider");
const SECONDARY = flag("--secondary", "category"); // default: crosstab error reasons under the primary grouping
const KIND = flag("--kind", "all"); // all | assistant | tool
const LIMIT = Number(flag("--limit", "0")) || 0;
const TOP = Number(flag("--top", "0")) || 0;
const WANT_JSON = hasFlag("--json");
const WANT_DETAIL = hasFlag("--detail");

const DIMENSIONS = ["provider", "slug", "session", "day", "category"];
/**
 * Resolve a row's value for a given dimension, used for both grouping and
 * secondary cross-tabulation.
 */
function valueOf(r, dim) {
  return dim === "provider" ? r.provider
       : dim === "slug" ? r.slug
       : dim === "session" ? r.sessionId
       : dim === "day" ? r.ts.slice(0, 10)
       : dim === "category" ? r.category
       : "?";
}

if (!["all", "assistant", "tool"].includes(KIND)) {
  console.error(`Unknown --kind '${KIND}' (expected all|assistant|tool)`);
  process.exit(2);
}
if (!DIMENSIONS.includes(BY)) {
  console.error(`Unknown --by '${BY}' (expected ${DIMENSIONS.join("|")})`);
  process.exit(2);
}
if (SECONDARY && !DIMENSIONS.includes(SECONDARY)) {
  console.error(`Unknown --secondary '${SECONDARY}' (expected ${DIMENSIONS.join("|")})`);
  process.exit(2);
}

// ─── Collect all entries from all session files ──────────────────────────────
const sessionDirs = [];
try {
  for (const name of readdirSync(DIR, { withFileTypes: true })) {
    if (name.isDirectory()) sessionDirs.push(join(DIR, name.name));
    else if (name.isFile() && name.name.endsWith(".jsonl")) sessionDirs.push(DIR);
  }
} catch (err) {
  console.error(`Cannot read sessions dir ${DIR}: ${err.message}`);
  process.exit(2);
}
if (sessionDirs.length === 0) sessionDirs.push(DIR);

/**
 * Each failure row is built deterministically:
 *   ts, kind ("assistant"|"tool"), slug, sessionId, category,
 *   stop, detail (short one-line description), indexInSession
 */
const rows = [];

const cutoffTs = SINCE_DAYS > 0 ? Date.now() - SINCE_DAYS * 86400_000 : 0;

function categoryOf(text, stop) {
  if (!text) return stop || "unknown";
  if (/429/.test(text)) return "429 rate-limit";
  if (/402/.test(text)) return "402 quota";
  if (/404/.test(text)) return "404 model-gone";
  if (/[Aa]bort/.test(text)) return "aborted";
  if (/terminated|Connection error/i.test(text)) return "terminated/conn-error";
  return "other";
}

function shortDesc(text, max = 110) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

/**
 * Extract the OpenRouter upstream provider name from a provider-side
 * error message. OpenRouter embeds the upstream attribution inside a JSON
 * object within the error text, e.g.:
 *   429: {"message":"Provider returned error","metadata":{"provider_name":"Baidu",...}}
 *
 * The regex-based approach used previously failed on the JSON format
 * `provider_name":"Value"` (no space before the colon, quote before the
 * colon) which is the format produced by OpenRouter's error payloads.
 *
 * This function extracts the embedded JSON object and walks it to find
 * `provider_name` at any depth (metadata.provider_name,
 * previous_errors[*].provider_name, …). Returns null when no attribution
 * is available (transport aborts, timeouts, tool errors, …).
 */
function extractProviderFromError(text) {
  const s = String(text ?? "");
  // Try to locate the JSON object embedded in the error message.
  const jsonMatch = s.match(/(\{.*\})/s);
  if (!jsonMatch) return null;
  let obj;
  try {
    obj = JSON.parse(jsonMatch[1]);
  } catch {
    return null;
  }
  // Walk the parsed object (and one level into arrays) for provider_name.
  const candidates = [
    obj?.metadata?.provider_name,
    obj?.provider_name,
  ];
  for (const prev of obj?.metadata?.previous_errors ?? []) {
    candidates.push(prev?.provider_name);
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/**
 * Normalize a provider name for the provider lens: strip the OpenRouter
 * routing prefix (`openrouter-baidu` → `baidu`) and lowercase so that
 * `provider_name:"DigitalOcean"` and route `openrouter-digitalocean`
 * group together.
 *
 * Plain `"openrouter"` (the router itself, not an upstream provider)
 * returns `"unknown"` — the router is not a low-level provider and
 * showing it as the provider would be misleading.
 */
function normalizeProvider(p) {
  if (!p) return "unknown";
  const s = String(p).trim().toLowerCase();
  if (!s) return "unknown";
  const stripped = s.replace(/^openrouter[-_]/i, "");
  return stripped || "unknown";
}

for (const dir of sessionDirs) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const fullPath = join(dir, file);
    let sessionId = parse(file).name;
    let lines;
    try {
      lines = readFileSync(fullPath, "utf8").split("\n");
    } catch {
      continue; // unreadable file — skip silently (deterministic: still sorted)
    }

    const entries = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        entries.push(JSON.parse(raw));
      } catch {
        // malformed line — skip, never abort (robustness vs jq)
      }
    }

    // Resolve session id from the session header entry.
    for (const e of entries) {
      if (e?.type === "session" && e.id) sessionId = e.id;
    }
    if (SESSION_PREFIX && !sessionId.startsWith(SESSION_PREFIX)) continue;

    // Index entries by id for model-slug back-resolution on tool rows.
    const byId = new Map(entries.map((e, i) => [e?.id, i]));
    const getEntry = (e) => (e?.parentId && byId.has(e.parentId) ? entries[byId.get(e.parentId)] : null);
    const modelOf = (e) => {
      let cur = e;
      for (let n = 0; n < 40 && cur; n++) {
        if (cur?.type === "message" && cur.message?.model)
          return `${cur.message.provider ?? "?"}/${cur.message.model}`;
        cur = getEntry(cur);
      }
      return "?";
    };
    // Resolve the provider for an entry by walking up its parent chain
    // (tool results don't carry provider/model themselves).
    const providerOf = (e) => {
      let cur = e;
      for (let n = 0; n < 40 && cur; n++) {
        if (cur?.type === "message" && cur.message?.provider)
          return normalizeProvider(cur.message.provider);
        cur = getEntry(cur);
      }
      return "unknown";
    };

    for (const e of entries) {
      if (e?.type !== "message" || !e.message) continue;
      const m = e.message;
      const tsMs = Date.parse(e.timestamp || "");
      if (cutoffTs && (!tsMs || tsMs < cutoffTs)) continue;
      const ts = (e.timestamp || "").slice(0, 19);

      if (m.role === "assistant") {
        const err = m.errorMessage;
        if (err) {
          const upstream = extractProviderFromError(err);
          rows.push({
            ts,
            kind: "assistant",
            slug: `${m.provider ?? "?"}/${m.model ?? "?"}`,
            provider:
              (upstream ? normalizeProvider(upstream) : null) ??
              (m.provider ? normalizeProvider(m.provider) : null) ??
              providerOf(e),
            sessionId,
            category: categoryOf(err, m.stopReason),
            stop: m.stopReason ?? m.rawStopReason ?? "?",
            detail: shortDesc(err),
          });
        }
      } else if (m.role === "toolResult") {
        const isErr = m.isError === true || m.details?.isError === true;
        if (isErr) {
          const content = Array.isArray(m.content)
            ? JSON.stringify(m.content)
            : String(m.content ?? "");
          rows.push({
            ts,
            kind: "tool",
            slug: modelOf(e),
            provider: providerOf(e),
            sessionId,
            category: "tool-error",
            stop: m.toolName ?? "?",
            detail: shortDesc(content),
          });
        }
      }
    }
  }
}

// ─── Deterministic ordering: group to be applied later; rows sorted by ts then id ───
rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.sessionId < b.sessionId ? -1 : 1));

// Kind filter
let filtered = KIND === "all" ? rows : rows.filter((r) => r.kind === KIND);

// ─── Output ──────────────────────────────────────────────────────────────────
function pad(s, n) {
  return String(s).padEnd(n);
}

function table(rowsIn) {
  const w = {
    ts: Math.max(10, ...rowsIn.map((r) => r.ts.length)),
    kind: 10,
    slug: Math.max(10, ...rowsIn.map((r) => r.slug.length)),
    cat: Math.max(8, ...rowsIn.map((r) => r.category.length)),
    stop: Math.max(10, ...rowsIn.map((r) => r.stop.length)),
  };
  const header = [
    pad("ts", w.ts),
    pad("kind", w.kind),
    pad("slug", w.slug),
    pad("session", 13),
    pad("category", w.cat),
    pad("stop", w.stop),
    "detail",
  ].join("  ");
  const lines = [header, "-".repeat(header.length)];
  for (const r of rowsIn) {
    lines.push(
      [
        pad(r.ts, w.ts),
        pad(r.kind, w.kind),
        pad(r.slug, w.slug),
        pad(r.sessionId.slice(0, 13), 13),
        pad(r.category, w.cat),
        pad(r.stop, w.stop),
        r.detail,
      ].join("  "),
    );
  }
  return lines.join("\n");
}

const groups = {};
const byDim = BY;
// A secondary dimension equal to the primary one is meaningless (e.g.
// category×category collapses to one column) — clear it so the single-dim
// view is shown instead.
const secDim = SECONDARY && SECONDARY !== byDim ? SECONDARY : "";
for (const r of filtered) {
  const key = valueOf(r, byDim);
  groups[key] = groups[key] || [];
  groups[key].push(r);
}

// Pre-compute secondary cross-tab per primary group: a nested counts map.
const crossTabs = secDim ? {} : null;
if (crossTabs) {
  for (const key of Object.keys(groups)) {
    const counts = {};
    for (const r of groups[key]) {
      const s = valueOf(r, secDim);
      counts[s] = (counts[s] || 0) + 1;
    }
    crossTabs[key] = counts;
  }
}

function allSecondaryKeys(crossTabs, topKeys) {
  const seen = [];
  for (const k of topKeys) {
    for (const s of Object.keys(crossTabs[k] || {})) {
      if (!seen.includes(s)) seen.push(s);
    }
  }
  return seen;
}

const out = [];
const hasCross = !!crossTabs;
if (WANT_JSON) {
  const payload = { total: filtered.length, by: byDim, groups };
  if (hasCross) payload.secondary = secDim;
  out.push(JSON.stringify(payload, null, 2));
} else {
  const label = hasCross && WANT_DETAIL
    ? `${byDim} → ${secDim}`
    : byDim;
  const totalNote = KIND === "all" ? `Failed turns: ${filtered.length}` : `Failed turns: ${filtered.length} (of ${rows.length} total failures; kind="${KIND}")`;
  out.push(`${totalNote} — grouped by ${label}`);
  out.push(`Sessions dir: ${DIR}`);
  if (cutoffTs) out.push(`Cutoff: last ${SINCE_DAYS} day(s) (files newer than ${new Date(cutoffTs).toISOString().slice(0, 19)}Z)`);
  out.push("");

  // Group summary table
  let remaining = filtered.length;
  const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length || (a < b ? -1 : 1));
  const topKeys = TOP > 0 ? keys.slice(0, TOP) : keys;

  if (hasCross && !WANT_DETAIL) {
    // Cross-tab summary: primary × secondary counts
    const secKeys = allSecondaryKeys(crossTabs, keys);
    const labelW = Math.max(byDim.length, ...keys.map((k) => String(k).length));
    const headerLine = pad(byDim, labelW) + secKeys.map((s) => `  ${pad(String(s), 11)}`).join("") + "  total";
    out.push(headerLine);
    out.push("-".repeat(headerLine.length));
    for (const key of topKeys) {
      const counts = crossTabs[key];
      const total = groups[key].length;
      const cells = secKeys.map((s) => {
        const v = counts[s] || 0;
        return `  ${pad(String(v), 11)}`;
      }).join("");
      out.push(`${pad(key, labelW)}${cells}  ${total}`);
    }
    out.push("");
  } else {
    // Single-dimension summary table
    for (const key of topKeys) {
      const g = groups[key];
      const pct = remaining > 0 ? Math.round((100 * g.length) / filtered.length) : 0;
      out.push(`${pad(g.length, 5)} (${pad(pct + "%", 4)})  ${key}`);
      remaining -= g.length;
    }
    out.push("");
  }

  // Detail rows
  if (WANT_DETAIL) {
    let shown = 0;
    for (const key of topKeys) {
      out.push(`── ${key} ──`);
      for (const r of groups[key]) {
        if (LIMIT > 0 && shown >= LIMIT) break;
        const extra = secDim ? `  [${valueOf(r, secDim)}]` : "";
        out.push(`  ${r.ts}  [${r.kind}] ${r.slug}  ${r.stop}${extra}  ${r.detail}`);
        shown++;
      }
      if (LIMIT > 0 && shown >= LIMIT) break;
    }
  }
}

console.log(out.join("\n"));