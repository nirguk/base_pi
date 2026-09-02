#!/usr/bin/env node
/**
 * session-failures.mjs — deterministic analysis of failed turns across pi sessions.
 *
 * Scans pi session JSONL files and reports assistant turns that failed to
 * complete and tool calls that errored, grouped by model slug.
 *
 * Attribution:
 *   - offline (forced with --offline, or automatic fallback): upstream providers
 *     come only from local data — the error body's metadata.provider_name and
 *     metadata.previous_errors[].provider_name (OpenRouter's reported chain).
 *   - online (default): also queries OpenRouter's generation API for each
 *     stored responseId (pi's responseId IS the gen id) and uses the
 *     server-side provider_responses[] for complete fallback chains.
 *
 * Determinism: offline mode never touches the network; output ordering is
 * fixed (sorted groups, then timestamp, then id); JSONL parsing is robust
 * (skips malformed lines instead of aborting).
 *
 * Usage:
 *   node session-failures.mjs [--dir <PATH>] [--since <DAYS>] [--slug <MODEL-SLUG>] [--offline]
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
const FORCE_OFFLINE = hasFlag("--offline");

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
 * Extract the provider chain from an OpenRouter error body:
 * `metadata.provider_name` (last attempt) + `metadata.previous_errors[]`
 * (earlier attempts in the same request). Returns { last, attempts }.
 */
function extractProviderChainFromError(text) {
  const s = String(text ?? "");
  const jsonMatch = s.match(/(\{.*\})/s);
  if (!jsonMatch) return { last: null, attempts: [] };
  let obj;
  try { obj = JSON.parse(jsonMatch[1]); } catch { return { last: null, attempts: [] }; }
  const attempts = [];
  const push = (p) => {
    if (typeof p === "string" && p.length > 0) attempts.push(normalizeProvider(p));
  };
  for (const prev of obj?.metadata?.previous_errors ?? []) push(prev?.provider_name);
  push(obj?.metadata?.provider_name);
  push(obj?.provider_name);
  const last = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  return { last, attempts: [...new Set(attempts)] };
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

// ─── Online resolution (generation API) ────────────────────────

/**
 * Look up OpenRouter generation records for a set of gen ids.
 *
 * The API is batched by unique id with bounded concurrency and per-id
 * retries. Transport-level failures (network, 5xx, 429 with Retry-After)
 * are retried as whole waves; 404 (pruned/no record) is terminal per id
 * and leaves the row on its local attribution.
 *
 * Returns a Map<genId, { ok, data?, terminal? }> plus wave diagnostics.
 */
async function resolveOnline(genIds, apiKey, { concurrency = 6, timeoutMs = 8000, retries = 3 } = {}) {
  const results = new Map(); // genId -> { ok: true, data } | { ok: false, terminal: bool, error }
  const pending = [...new Set(genIds)];
  let wave = 0;

  const fetchOne = async (gid) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(gid)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      if (res.status === 404) return { ok: false, terminal: true, error: "no record (pruned or unknown)" };
      if (res.status === 401 || res.status === 403) return { ok: false, terminal: true, error: `auth failed (${res.status})` };
      if (!res.ok) return { ok: false, terminal: false, error: `HTTP ${res.status}` };
      const body = await res.json();
      if (!body?.data) return { ok: false, terminal: false, error: "malformed response" };
      return { ok: true, data: body.data };
    } catch (err) {
      return { ok: false, terminal: false, error: err?.name === "AbortError" ? "timeout" : String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  };

  while (pending.length > 0 && wave < retries) {
    wave++;
    const batch = pending.splice(0, pending.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (idx < batch.length) {
        const gid = batch[idx++];
        const r = await fetchOne(gid);
        if (r.ok || r.terminal) results.set(gid, r);
        else pending.push(gid); // transient → retry in the next wave
      }
    });
    await Promise.all(workers);
    if (pending.length > 0 && wave < retries) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** (wave - 1)));
    }
  }
  // Anything still pending exhausted its waves.
  for (const gid of pending) results.set(gid, { ok: false, terminal: false, error: "retries exhausted" });
  return { results, waves: wave };
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
          const chain = extractProviderChainFromError(err);
          const providerSource = chain.last
            ? "error-body"
            : (m.provider ? "msg-provider" : "parent-chain");
          const provider = chain.last
            ?? (m.provider ? normalizeProvider(m.provider) : null)
            ?? providerOf(e);
          rows.push({
            ts,
            kind: "assistant",
            slug: modelOf(e) || `${m.provider ?? "?"}/${m.model ?? "?"}`,
            provider,
            providerSource,
            providerAttempts: chain.attempts,
            responseId: m.responseId ?? null,
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
            providerSource: "parent-chain",
            providerAttempts: [],
            responseId: null,
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

// ─── Online attribution (default; skipped with --offline) ────────
const notices = [];

if (!FORCE_OFFLINE && rows.some((r) => r.kind === "assistant" && r.responseId)) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    notices.push("online attribution skipped: OPENROUTER_API_KEY not set — using offline (local error-body) attribution");
  } else {
    const genIds = rows
      .filter((r) => r.kind === "assistant" && r.responseId)
      .map((r) => r.responseId);
    const { results } = await resolveOnline(genIds, apiKey);

    let resolved = 0, noRecord = 0, failed = 0;
    for (const r of rows) {
      if (r.kind !== "assistant" || !r.responseId) continue;
      const rec = results.get(r.responseId);
      if (!rec) continue;
      if (!rec.ok) {
        if (rec.terminal && /no record/.test(rec.error)) noRecord++;
        else failed++;
        continue;
      }
      const chain = (rec.data.provider_responses ?? [])
        .map((p) => p?.provider_name)
        .filter((p) => typeof p === "string" && p.length > 0)
        .map(normalizeProvider);
      const last = chain.length > 0 ? chain[chain.length - 1]
        : (rec.data.provider_name ? normalizeProvider(rec.data.provider_name) : null);
      if (last) {
        r.provider = last;
        r.providerSource = "online";
        r.providerAttempts = [...new Set([...r.providerAttempts, ...chain])];
        resolved++;
      } else {
        failed++;
      }
    }

    if (resolved === 0 && (noRecord + failed) > 0 && failed > 0) {
      notices.push(`online attribution failed after ${3} retries (${failed} lookup error(s), ${noRecord} no-record) — report uses offline (local) attribution`);
    } else {
      const bits = [];
      if (resolved > 0) bits.push(`${resolved} resolved via generation API`);
      if (noRecord > 0) bits.push(`${noRecord} no server-side record (kept local attribution)`);
      if (failed > 0) bits.push(`${failed} lookup failure(s) after retries (kept local attribution)`);
      if (bits.length > 0) notices.push(`online attribution: ${bits.join("; ")}`);
    }
  }
}

// ─── Debug-artifact fallback (best-effort recovery for rows without responseId) ──

/**
 * Try to recover generation ids from pi-llm-debugging artifacts for
 * assistant failure rows that have no responseId. Correlation is by
 * session dir + timestamp proximity (±60s) + model match from the
 * corresponding req.json.
 *
 * Returns a Map<rowIndex, { provider, attempts, source }> for rows that
 * could be resolved. Rows that cannot be resolved are simply not in the map.
 */
async function resolveFromDebugArtifacts(rowList, apiKey) {
  const results = new Map();
  const debugBase = join(process.cwd(), ".pi", "pi-llm-debugging");
  let apiKeyUsed = apiKey;
  if (!apiKeyUsed) apiKeyUsed = process.env.OPENROUTER_API_KEY;
  if (!apiKeyUsed) return results;

  // Group unresolved rows by sessionId.
  const bySession = new Map();
  for (let i = 0; i < rowList.length; i++) {
    const r = rowList[i];
    if (r.kind !== "assistant" || r.responseId || r.provider !== "openrouter") continue;
    if (!r.sessionId) continue;
    const group = bySession.get(r.sessionId) ?? [];
    group.push({ i, r });
    bySession.set(r.sessionId, group);
  }
  if (bySession.size === 0) return results;

  for (const [sid, group] of bySession) {
    const debugDir = join(debugBase, sid);
    let entries;
    try { entries = fs.readdirSync(debugDir); } catch { continue; }

    // Build seq → model map from req.json files.
    const seqModel = {};
    for (const f of entries) {
      const m = f.match(/^(\d+)-req\.json$/);
      if (!m) continue;
      try {
        const o = JSON.parse(fs.readFileSync(join(debugDir, f), "utf8"));
        seqModel[m[1]] = o.model ?? null;
      } catch { /* skip */ }
    }

    // Collect candidate gen ids from res-meta/error artifacts.
    const candidates = []; // { seq, gid, dateMs }
    for (const f of entries) {
      const m = f.match(/^(\d+)-(res-meta|error)\.json$/);
      if (!m) continue;
      let o; try { o = JSON.parse(fs.readFileSync(join(debugDir, f), "utf8")); } catch { continue; }
      const gid = o.headers?.["x-generation-id"];
      const date = o.headers?.date ? Date.parse(o.headers.date) : null;
      if (!gid || !date) continue;
      const seq = m[1];
      if (seqModel[seq] && seqModel[seq] !== "inclusionai/ling-3.0-flash" && seqModel[seq] !== "inclusionai/ling-3.0-flash-20260723") continue;
      candidates.push({ seq, gid, dateMs: date });
    }
    if (candidates.length === 0) continue;

    // Dedupe by gid.
    const seen = new Set();
    const uniq = candidates.filter(c => !seen.has(c.gid) && seen.add(c.gid));

    // Query the API for all candidates.
    const { results: apiResults } = await resolveOnline(uniq.map(c => c.gid), apiKeyUsed, { concurrency: 6, retries: 2, timeoutMs: 8000 });

    for (const { i, r } of group) {
      if (results.has(i)) continue;
      const rowTs = Date.parse(r.ts.slice(0, 19) + "Z");
      let best = null, bestScore = Infinity;
      for (const c of uniq) {
        const rec = apiResults.get(c.gid);
        if (!rec?.ok || !rec.data) continue;
        const d = rec.data;
        const endMs = Date.parse(d.created_at) + (d.latency || 0);
        const timeDist = Math.abs(endMs - rowTs);
        if (timeDist > 120_000) continue; // end of generation must be near row timestamp
        // Prefer failure-like records: cancelled, or no finish_reason, or very few output tokens.
        const isFailure = d.cancelled === true || d.finish_reason === null || (d.tokens_completion ?? 999) < 10;
        const score = (isFailure ? 0 : 1000) + timeDist;
        if (score < bestScore) { bestScore = score; best = { d, endMs, timeDist }; }
      }
      if (best && bestScore < 1000) {
        const chain = (best.d.provider_responses ?? [])
          .map(p => p?.provider_name)
          .filter(p => typeof p === "string" && p.length > 0)
          .map(normalizeProvider);
        const last = chain.length > 0 ? chain[chain.length - 1]
          : (best.d.provider_name ? normalizeProvider(best.d.provider_name) : null);
        if (last) {
          results.set(i, { provider: last, attempts: [...new Set([...r.providerAttempts, ...chain])], source: "debug-artifact" });
        }
      }
    }
  }
  return results;
}

// ─── Debug-artifact fallback (best-effort recovery for rows without responseId) ──
if (!FORCE_OFFLINE && process.env.OPENROUTER_API_KEY) {
  const unresolved = rows.filter((r) => r.kind === "assistant" && !r.responseId && r.provider === "openrouter" && r.category !== "aborted" && r.category !== "tool-error");
  if (unresolved.length > 0) {
    const debugResults = await resolveFromDebugArtifacts(unresolved, process.env.OPENROUTER_API_KEY);
    let debugResolved = 0;
    for (const [idx, info] of debugResults) {
      const r = rows[idx];
      if (!r) continue;
      r.provider = info.provider;
      r.providerSource = info.source;
      r.providerAttempts = info.attempts;
      debugResolved++;
    }
    if (debugResolved > 0) {
      notices.push(`${debugResolved} failure(s) resolved via pi-llm-debugging artifacts`);
    }
  }
}

// ─── Filter ──────────────────────────────────────────────
let filtered = SLUG_FILTER ? rows.filter((r) => r.slug === SLUG_FILTER) : rows;

// ─── Output ──────────────────────────────────────────────────────
if (SLUG_FILTER) {
  // Breakdown view: category + provider tables for the selected slug.
  // ── Provider tables (exclude tool-errors and user aborts — not upstream failures) ──
  const excludedCats = new Set(["tool-error", "aborted"]);
  const attrRows = filtered.filter((r) => !excludedCats.has(r.category));
  const byCategory = {};
  const byProvider = {};
  const byProviderAttempts = {};
  for (const r of filtered) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  }
  for (const r of attrRows) {
    byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
    const attempts = r.providerAttempts.length > 0
      ? r.providerAttempts
      : (r.provider && r.provider !== "openrouter" ? [r.provider] : []);
    for (const p of attempts) {
      byProviderAttempts[p] = (byProviderAttempts[p] || 0) + 1;
    }
  }
  const excludedTool = filtered.filter((r) => r.category === "tool-error").length;
  const excludedAbort = filtered.filter((r) => r.category === "aborted").length;
  if (excludedTool > 0) notices.push(`${excludedTool} tool-error(s) excluded from upstream attribution (local tool failure)`);
  if (excludedAbort > 0) notices.push(`${excludedAbort} abort(s) excluded from upstream attribution (user-initiated cancellation)`);
  const providerTotal = attrRows.length;
  const totalAttempts = slugAttempts.get(SLUG_FILTER) || 0;
  const totalFailures = filtered.length;

  console.log(
    buildBreakdownOutput({
      slug: SLUG_FILTER,
      totalFailures,
      totalAttempts,
      byCategory,
      byProvider,
      byProviderAttempts,
      providerTotal,
      SINCE_DAYS,
      cutoffTs,
      DIR,
      mode: FORCE_OFFLINE ? "offline" : "online",
      notices,
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
      mode: FORCE_OFFLINE ? "offline" : "online",
      notices,
    }).join("\n"),
  );
}
