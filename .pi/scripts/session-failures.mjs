#!/usr/bin/env node
/**
 * session-failures.mjs — deterministic analysis of failed turns across pi sessions.
 *
 * Scans pi session JSONL files and reports assistant turns that failed to
 * complete and tool calls that errored, grouped by model slug.
 *
 * Deterministic by design:
 *   - no network calls, no environment drift
 *   - fixed output ordering (sorted groups, then timestamp, then id)
 *   - robust JSONL parsing (skips malformed lines instead of aborting)
 *
 * Usage:
 *   node session-failures.mjs [--dir <PATH>] [--since <DAYS>] [--slug <MODEL-SLUG>]
 *
 * Exit code 0 = analysis completed (even if zero failures found).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, parse } from "node:path";
import { homedir } from "node:os";
import { buildSummaryOutput, buildBreakdownOutput } from "./session-failures-display.mjs";

// ─── Args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}
function hasFlag(name) { return args.includes(name); }

const DIR = flag("--dir", join(homedir(), ".pi", "agent", "sessions"));
const SINCE_DAYS = Number(flag("--since", "7")) || 0;
const SLUG_FILTER = flag("--slug", "");

// ─── Collect rows ────────────────────────────────────────────────
const rows = [];
const slugAttempts = new Map(); // slug -> attempt count

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
  return String(text ?? "").replace(/\s+/g, " ").slice(0, max);
}

/**
 * Extract the OpenRouter upstream provider name from a provider-side
 * error message. Handles the JSON format `provider_name":"Value"`
 * (no space before the colon) that a simple regex cannot parse.
 */
function extractProviderFromError(text) {
  const s = String(text ?? "");
  const jsonMatch = s.match(/(\{.*\})/s);
  if (!jsonMatch) return null;
  let obj;
  try { obj = JSON.parse(jsonMatch[1]); } catch { return null; }
  const candidates = [obj?.metadata?.provider_name, obj?.provider_name];
  for (const prev of obj?.metadata?.previous_errors ?? []) candidates.push(prev?.provider_name);
  for (const c of candidates) { if (typeof c === "string" && c.length > 0) return c; }
  return null;
}

/**
 * Normalize a provider name: strip the OpenRouter routing prefix
 * (`openrouter-baidu` → `baidu`) and lowercase.
 * Plain `openrouter` (the router itself) returns `unknown`.
 */
function normalizeProvider(p) {
  if (!p) return "unknown";
  const s = String(p).trim().toLowerCase();
  if (!s) return "unknown";
  const stripped = s.replace(/^openrouter[-_]/i, "");
  return stripped || "unknown";
}

// ─── Scan session files ─────────────────────────────────────────
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

for (const dir of sessionDirs) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const fullPath = join(dir, file);
    let sessionId = parse(file).name;
    let lines;
    try { lines = readFileSync(fullPath, "utf8").split("\n"); } catch { continue; }

    const entries = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try { entries.push(JSON.parse(raw)); } catch { continue; }
    }

    // Resolve session id from the session header entry.
    for (const e of entries) {
      if (e?.type === "session" && e.id) sessionId = e.id;
    }

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

      // Count attempts per slug (both assistant messages and tool results).
      if (m.role === "assistant") {
        const slug = `${m.provider ?? "?"}/${m.model ?? "?"}`;
        slugAttempts.set(slug, (slugAttempts.get(slug) || 0) + 1);
      } else if (m.role === "toolResult") {
        const slug = modelOf(e);
        slugAttempts.set(slug, (slugAttempts.get(slug) || 0) + 1);
      }

      // Collect failure rows.
      if (m.role === "assistant") {
        const err = m.errorMessage;
        if (err) {
          const upstream = extractProviderFromError(err);
          const resolvedProvider = (upstream ? normalizeProvider(upstream) : null)
            ?? (m.provider ? normalizeProvider(m.provider) : null)
            ?? providerOf(e);
          rows.push({
            ts,
            kind: "assistant",
            slug: modelOf(e) || `${m.provider ?? "?"}/${m.model ?? "?"}`,
            provider: resolvedProvider,
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

// ─── Filter ──────────────────────────────────────────────────────
let filtered = SLUG_FILTER ? rows.filter((r) => r.slug === SLUG_FILTER) : rows;

// ─── Output ──────────────────────────────────────────────────────
if (SLUG_FILTER) {
  // Breakdown view: category + provider tables for the selected slug.
  const byCategory = {};
  const byProvider = {};
  for (const r of filtered) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
  }
  const totalAttempts = slugAttempts.get(SLUG_FILTER) || 0;
  const totalFailures = filtered.length;

  console.log(
    buildBreakdownOutput({
      slug: SLUG_FILTER,
      totalFailures,
      totalAttempts,
      byCategory,
      byProvider,
      SINCE_DAYS,
      cutoffTs,
      DIR,
    }).join("\n"),
  );
} else {
  // Summary view: per-model breakdown.
  const groups = {};
  for (const r of filtered) {
    const key = r.slug;
    groups[key] = groups[key] || [];
    groups[key].push(r);
  }
  // Surface slugs that had attempts but zero failures (healthy models).
  for (const key of slugAttempts.keys()) {
    if (!(key in groups)) groups[key] = [];
  }

  const topKeys = Object.keys(groups).sort((a, b) => {
    const aFails = groups[a]?.length ?? 0;
    const bFails = groups[b]?.length ?? 0;
    const aAtt = slugAttempts.get(a) || 0;
    const bAtt = slugAttempts.get(b) || 0;
    const aRate = aAtt > 0 ? aFails / aAtt : 0;
    const bRate = bAtt > 0 ? bFails / bAtt : 0;
    return bRate - aRate || bFails - aFails || (a < b ? -1 : 1);
  });

  console.log(
    buildSummaryOutput({
      groups,
      topKeys,
      slugAttempts,
      totalFailures: filtered.length,
      SINCE_DAYS,
      cutoffTs,
      DIR,
    }).join("\n"),
  );
}
