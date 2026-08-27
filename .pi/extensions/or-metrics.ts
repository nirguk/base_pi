/**
 * OpenRouter Metrics Extension
 *
 * Fetches Artificial Analysis indices (coding, agentic, intelligence) from
 * the OpenRouter models API on session start, computes ability-per-price
 * (IPP) metrics, snapshots for change detection, and exposes a /or-metrics
 * command plus a or_metrics tool for the LLM.
 *
 * Also fetches endpoint-level throughput data (p90 tokens/sec) from the
 * OpenRouter endpoints API. Throughput is averaged over a 30-minute window
 * (OpenRouter's `throughput_last_30m` field).
 *
 * Snapshots: keeps exactly 2 files in ~/.pi/or-metrics/snapshots/
 *   - latest.json   (current fetch)
 *   - previous.json (prior fetch, overwritten each time)
 *
 * Usage:
 *   /or-metrics           — full display (scoped models, notable, rankings, tps)
 *   /or-metrics scoped    — just our 4 scoped models
 *   /or-metrics notable   — analytically interesting models
 *   /or-metrics top       — top 20 by blended IPP
 *   /or-metrics tps       — top models by p90 throughput (tokens/sec, 30m window)
 *   /or-metrics changes   — diff since last snapshot
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Config ────────────────────────────────────────────────────────────────────

const OR_API_BASE = "https://openrouter.ai/api/v1";
const SNAPSHOT_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/root",
  ".pi", "or-metrics", "snapshots"
);
const TPS_CACHE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || os.homedir(),
  ".pi", "or-metrics"
);
const TPS_CACHE_FILE = path.join(TPS_CACHE_DIR, "tps-cache.json");
const TPS_CACHE_BATCH_SIZE = 20;
const TPS_CACHE_PROGRESS_INTERVAL = 1000;
const DEFAULT_CACHE_RATE = parseFloat(process.env.OR_CACHE_RATE || "0.7");

// Populated from ctx.scopedModels at session start
let activeScopedSlugs: { slug: string; label: string }[] = [];



// ─── HTTP Fetch ────────────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = { headers: headers as Record<string, string> };
    https.get(url, opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ─── Pricing / Analysis ────────────────────────────────────────────────────────

function parsePricing(p: any) {
  if (!p) return null;
  const input = parseFloat(p.prompt) * 1_000_000;
  const output = parseFloat(p.completion) * 1_000_000;
  const cacheRead = p.input_cache_read != null ? parseFloat(p.input_cache_read) * 1_000_000 : null;
  if (isNaN(input) || isNaN(output) || input < 0) return null;
  return {
    input,
    output,
    cacheRead: (cacheRead != null && !isNaN(cacheRead)) ? cacheRead : null,
  };
}

type ThroughputStats = {
  p90: number | null;
  p50: number | null;
  mean: number | null;
};

function analyzeModels(models: any[], tpsData?: Record<string, ThroughputStats | null>) {
  const entries: any[] = [];

  for (const m of models) {
    const aa = m.benchmarks?.artificial_analysis;

    const pricing = parsePricing(m.pricing);
    if (!pricing) continue;

    const blended = pricing.input * 0.8 + pricing.output * 0.2;
    const cacheEffInput = pricing.cacheRead != null
      ? pricing.cacheRead * DEFAULT_CACHE_RATE + pricing.input * (1 - DEFAULT_CACHE_RATE)
      : pricing.input;
    const blendedCached = cacheEffInput * 0.8 + pricing.output * 0.2;

    const coding = aa?.coding_index ?? null;
    const agentic = aa?.agentic_index ?? null;
    const intelligence = aa?.intelligence_index ?? null;

    const blndcod = coding != null && blended > 0 ? coding / blended : null;
    const blndagnt = agentic != null && blended > 0 ? agentic / blended : null;
    const cachcod = coding != null && blendedCached > 0 ? coding / blendedCached : null;
    const cachagt = agentic != null && blendedCached > 0 ? agentic / blendedCached : null;
    const blnd = (coding != null && agentic != null && blended > 0)
      ? (coding * 0.5 + agentic * 0.5) / blended : null;
    const cach = (coding != null && agentic != null && blendedCached > 0)
      ? (coding * 0.5 + agentic * 0.5) / blendedCached : null;

    const tps = tpsData?.[m.id] ?? null;
    entries.push({
      slug: m.id,
      name: m.name || m.id,
      pricing: { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead, blended, blendedCached },
      indices: { intelligence, coding, agentic },
      ipp: { blndcod, blndagnt, cachcod, cachagt, blnd, cach },
      throughput_p90: tps?.p90 ?? null,
      throughput_p50: tps?.p50 ?? null,
      throughput_mean: tps?.mean ?? null,
    });
  }
  return entries;
}

function findScoped(entries: any[], slugs: { slug: string; label: string }[]) {
  return slugs.map((s) => {
    const e = entries.find((x: any) => x.slug === s.slug);
    return { ...s, entry: e || null, found: !!e };
  });
}

// ─── Fetch from API ────────────────────────────────────────────────────────────

async function fetchORData(apiKey: string) {
  const url = `${OR_API_BASE}/models?limit=400`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const result = await fetchJSON(url, headers);
  if (!result?.data) throw new Error("No data from OpenRouter");

  // No TPS data fetched here — call fetchTPSForSlugs separately for
  // scoped models or top-ranked models to avoid excessive API calls.
  return analyzeModels(result.data);
}

/**
 * Fetch endpoint-level throughput data for a single model.
 * Returns the full throughput object (p90, p50, mean) or null if unavailable.
 */
async function fetchEndpointTPS(apiKey: string, slug: string): Promise<ThroughputStats | null> {
  const [author, modelSlug] = slug.split("/");
  if (!author || !modelSlug) return null;

  const url = `${OR_API_BASE}/models/${encodeURIComponent(author)}/${encodeURIComponent(modelSlug)}/endpoints`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const result = await fetchJSON(url, headers);
    const endpoints = result?.data?.endpoints ?? result?.endpoints ?? [];
    if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
    const tp = endpoints[0]?.throughput_last_30m;
    if (!tp) return null;
    return {
      p90: (tp.p90 != null && !isNaN(tp.p90)) ? tp.p90 : null,
      p50: (tp.p50 != null && !isNaN(tp.p50)) ? tp.p50 : null,
      mean: (tp.mean != null && !isNaN(tp.mean)) ? tp.mean : null,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch p90 throughput for a set of model slugs in parallel.
 * Returns a map of slug → p90 tokens/sec.
 */
async function fetchTPSForSlugs(apiKey: string, slugs: string[]): Promise<Record<string, number | null>> {
  const results: Record<string, number | null> = {};
  const uniqueSlugs = [...new Set(slugs)];

  await Promise.all(
    uniqueSlugs.map(async (slug) => {
      const tp = await fetchEndpointTPS(apiKey, slug);
      results[slug] = tp?.p90 ?? null;
    })
  );

  return results;
}

// ─── Daily TPS Cache ────────────────────────────────────────────────────

function loadDailyCache(): { date: string; data: Record<string, number | null> } | null {
  try {
    if (!fs.existsSync(TPS_CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(TPS_CACHE_FILE, "utf8"));
    if (!raw?.date || !raw?.data) return null;
    return { date: raw.date, data: raw.data };
  } catch {
    return null;
  }
}

function saveDailyCache(date: string, data: Record<string, number | null>) {
  try {
    fs.mkdirSync(TPS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(TPS_CACHE_FILE, JSON.stringify({ date, data }, null, 2));
  } catch { /* best-effort */ }
}

// ─── Snapshot ───────────────────────────────────────────────────────────────────

function ensureDir() { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); }

function snapshotAndDiff(entries: any[]) {
  ensureDir();
  const latestPath = path.join(SNAPSHOT_DIR, "latest.json");
  const prevPath = path.join(SNAPSHOT_DIR, "previous.json");

  // Load prior snapshot
  let prior: any = null;
  try { prior = JSON.parse(fs.readFileSync(prevPath, "utf8")); } catch { /* no prior */ }

  // Rotate: current latest becomes previous
  try {
    if (fs.existsSync(latestPath)) {
      // Remove old previous if exists, then rename latest -> previous
      if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
      fs.renameSync(latestPath, prevPath);
    }
  } catch { /* best-effort */ }

  // Save new snapshot
  const payload = {
    snapshot_date: new Date().toISOString().slice(0, 10),
    fetched_at: new Date().toISOString(),
    n_models: entries.length,
    models: entries.map((e: any) => ({
      slug: e.slug,
      name: e.name,
      coding_index: e.indices.coding,
      agentic_index: e.indices.agentic,
      intelligence_index: e.indices.intelligence,
      blended_cost_per_m: e.pricing.blended,
      blended_cached_per_m: e.pricing.blendedCached,
      blndcod: e.ipp.blndcod,
      blndagnt: e.ipp.blndagnt,
      cachcod: e.ipp.cachcod,
      cachagt: e.ipp.cachagt,
      blnd: e.ipp.blnd,
      cach: e.ipp.cach,
      throughput_p90: e.throughput_p90,
      throughput_p50: e.throughput_p50 ?? null,
      throughput_mean: e.throughput_mean ?? null,
    })),
  };
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2));

  // Compute diff
  const changes: any[] = [];
  let added: string[] = [];
  let removed: string[] = [];

  if (prior) {
    const priorIdx: Record<string, any> = {};
    (prior.models || []).forEach((m: any) => (priorIdx[m.slug] = m));
    const currIdx: Record<string, any> = {};
    (payload.models || []).forEach((m: any) => (currIdx[m.slug] = m));

    added = payload.models
      .filter((m: any) => !priorIdx[m.slug])
      .map((m: any) => m.name);
    removed = (prior.models || [])
      .filter((m: any) => !currIdx[m.slug])
      .map((m: any) => m.name);

    for (const slug of Object.keys(currIdx)) {
      if (!priorIdx[slug]) continue;
      const p = priorIdx[slug], c = currIdx[slug];
      if (p.coding_index != null && c.coding_index != null) {
        const d = c.coding_index - p.coding_index;
        if (Math.abs(d) >= 0.5) changes.push({ name: c.name, metric: "coding", old: p.coding_index, new: c.coding_index, delta: d });
      }
      if (p.agentic_index != null && c.agentic_index != null) {
        const d = c.agentic_index - p.agentic_index;
        if (Math.abs(d) >= 0.5) changes.push({ name: c.name, metric: "agentic", old: p.agentic_index, new: c.agentic_index, delta: d });
      }
      if (p.blended_cost_per_m != null && c.blended_cost_per_m != null) {
        const d = ((c.blended_cost_per_m - p.blended_cost_per_m) / p.blended_cost_per_m) * 100;
        if (Math.abs(d) >= 5) changes.push({ name: c.name, metric: "price", old: p.blended_cost_per_m, new: c.blended_cost_per_m, delta: d });
      }
      if (p.throughput_p90 != null && c.throughput_p90 != null) {
        const d = c.throughput_p90 - p.throughput_p90;
        if (Math.abs(d) >= 5) changes.push({ name: c.name, metric: "throughput_p90", old: p.throughput_p90, new: c.throughput_p90, delta: d });
      }
      if (p.throughput_p50 != null && c.throughput_p50 != null) {
        const d = c.throughput_p50 - p.throughput_p50;
        if (Math.abs(d) >= 5) changes.push({ name: c.name, metric: "throughput_p50", old: p.throughput_p50, new: c.throughput_p50, delta: d });
      }
      if (p.throughput_mean != null && c.throughput_mean != null) {
        const d = c.throughput_mean - p.throughput_mean;
        if (Math.abs(d) >= 5) changes.push({ name: c.name, metric: "throughput_mean", old: p.throughput_mean, new: c.throughput_mean, delta: d });
      }
    }
  }

  return {
    priorDate: prior?.snapshot_date || null,
    currentDate: payload.snapshot_date,
    nEntries: entries.length,
    added,
    removed,
    changes,
    entries,
    entriesWithData: payload.models,
  };
}

// ─── Notable Detection ──────────────────────────────────────────────────────────

function findNotable(entries: any[]) {
  const notable: any[] = [];

  const byAgentic = [...entries].filter((e) => e.indices.agentic != null)
    .sort((a, b) => (b.indices.agentic || 0) - (a.indices.agentic || 0));
  notable.push({ category: "🏆 Best Agentic Ability (raw)", models: byAgentic.slice(0, 5).map((e) => ({ name: e.name, v: e.indices.agentic })) });

  const byCoding = [...entries].filter((e) => e.indices.coding != null)
    .sort((a, b) => (b.indices.coding || 0) - (a.indices.coding || 0));
  notable.push({ category: "💻 Best Coding Ability (raw)", models: byCoding.slice(0, 5).map((e) => ({ name: e.name, v: e.indices.coding })) });

  const byBlendedIPP = [...entries].filter((e) => e.ipp.blnd != null)
    .sort((a, b) => (b.ipp.blnd || 0) - (a.ipp.blnd || 0));
  notable.push({ category: "💰 Best Blended IPP (ability-per-price, blended costs)", models: byBlendedIPP.slice(0, 5).map((e) => ({ name: e.name, v: e.ipp.blnd })) });

  const byCachedIPP = [...entries].filter((e) => e.ipp.cach != null)
    .sort((a, b) => (b.ipp.cach || 0) - (a.ipp.cach || 0));
  notable.push({ category: "🔄 Best Cached IPP (70% cache assumed)", models: byCachedIPP.slice(0, 5).map((e) => ({ name: e.name, v: e.ipp.cach })) });

  return notable;
}

// ─── Display Helpers ────────────────────────────────────────────────────────────

function columnPrecision(values: (number | null)[], fallback = 4): number {
  let max = fallback;
  for (const v of values) {
    if (v == null) continue;
    const abs = Math.abs(v);
    if (abs === 0) continue;
    if (abs < 0.01) { if (6 > max) max = 6; }
    else if (abs < 1) { if (4 > max) max = 4; }
    else if (abs < 10) { if (3 > max) max = 3; }
    else if (abs < 100) { if (2 > max) max = 2; }
    else if (1 > max) max = 1;
  }
  return max;
}

const FMT = {
  pct(v: number | null) { return v == null ? "—" : v.toFixed(1) + "%"; },
  cost(v: number | null, dec?: number) {
    if (v == null) return "—";
    if (dec != null) return "$" + v.toFixed(dec);
    const s = v.toFixed(v < 0.01 ? 5 : v < 1 ? 3 : v < 10 ? 2 : 1);
    return "$" + s.replace(/\.?0+$/, "");
  },
  ipp(v: number | null, dec?: number) {
    if (v == null) return "    —";
    if (dec != null) return v.toFixed(dec).padStart(6);
    return (v > 1000 ? v.toFixed(0) : v > 100 ? v.toFixed(1) : v.toFixed(2)).padStart(6);
  },
  pad(s: string, n: number) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); },
  costPrecision: columnPrecision,
  ippPrecision(values: (number | null)[], fallback = 2): number {
    let max = fallback;
    for (const v of values) {
      if (v == null) continue;
      const abs = Math.abs(v);
      if (abs === 0) continue;
      if (abs < 0.1) { if (4 > max) max = 4; }
      else if (abs < 1) { if (3 > max) max = 3; }
      else if (abs < 10) { if (2 > max) max = 2; }
      else if (1 > max) max = 1;
    }
    return max;
  },
};

function renderScoped(scoped: any[]) {
  const lines: string[] = [];

  // Collect column values for precision alignment
  const costVals: (number | null)[] = [];
  const tpsVals: (number | null)[] = [];
  const ipCols: (number | null)[][] = [[], [], [], []]; // blndcod, blndagnt, cachcod, cachagt
  for (const s of scoped) {
    if (!s.entry) continue;
    const e = s.entry;
    costVals.push(e.pricing.blended);
    tpsVals.push(e.throughput_p90);
    ipCols[0].push(e.ipp.blndcod);
    ipCols[1].push(e.ipp.blndagnt);
    ipCols[2].push(e.ipp.cachcod);
    ipCols[3].push(e.ipp.cachagt);
  }
  const costDec = columnPrecision(costVals, 4);
  const tpsDec = columnPrecision(tpsVals.filter((v): v is number => v != null), 1);
  const ippDec = FMT.ippPrecision(costVals.map(_ => 0).concat(...ipCols.filter(c => c.length > 0)), 2);
  const ipDecs = ipCols.map(c => FMT.ippPrecision(c, 2));

  lines.push("┌─ Our Scoped Models ───────────────────────────────────────────────────────────────────────────────────────────────────┐");
  lines.push("│ Model                                        Intel  Coding Agentic  Base$/M    p90TPS  BlndCd  BlndAg  CachCd  CachAg│ ");
  lines.push("│───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────│");
  for (const s of scoped) {
    const name = FMT.pad(s.label, 40);
    if (!s.entry) {
      lines.push(`│ ${name}  no data from OpenRouter                                                     │`);
      continue;
    }
    const e = s.entry;
    const intel = e.indices.intelligence != null ? e.indices.intelligence.toFixed(1).padStart(5) : "  —  ";
    const coding = e.indices.coding != null ? e.indices.coding.toFixed(1).padStart(5) : "  —  ";
    const agentic = e.indices.agentic != null ? e.indices.agentic.toFixed(1).padStart(5) : "  —  ";
    const blended = FMT.cost(e.pricing.blended, costDec).padStart(10);
    const tps = e.throughput_p90 != null ? e.throughput_p90.toFixed(tpsDec).padStart(7) : "      —";
    const bc = FMT.ipp(e.ipp.blndcod, ipDecs[0]).padStart(7);
    const ba = FMT.ipp(e.ipp.blndagnt, ipDecs[1]).padStart(7);
    const cc = FMT.ipp(e.ipp.cachcod, ipDecs[2]).padStart(7);
    const ca = FMT.ipp(e.ipp.cachagt, ipDecs[3]).padStart(7);
    lines.push(`│ ${name} ${intel}  ${coding}  ${agentic}  ${blended}  ${tps}  ${bc}  ${ba}  ${cc}  ${ca} │`);
  }
  lines.push("└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

function renderNotable(notable: any[]) {
  const lines: string[] = [];
  lines.push("┌─ Notable ───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐");
  for (const n of notable) {
    lines.push(`│ ${FMT.pad(n.category, 112)} │`);
    for (const m of n.models) {
      const name = FMT.pad(m.name || "", 40).slice(0, 40);
      const v = typeof m.v === "number" ? (m.v > 100 ? m.v.toFixed(1) : m.v.toFixed(2).padStart(6)) : String(m.v ?? "—");
      lines.push(`│   ${name}  ${v}${" ".repeat(Math.max(0, 74 - String(v).length))} │`);
    }
    lines.push(`│─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────│`);
  }
  lines.push("└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

function renderTop(entries: any[]) {
  const ranked = [...entries].filter((e) => e.ipp.blnd != null)
    .sort((a, b) => (b.ipp.blnd || 0) - (a.ipp.blnd || 0));

  // Column precision
  const costVals = ranked.map(e => e.pricing.blended);
  const costDec = columnPrecision(costVals, 4);
  const bcVals = ranked.map(e => e.ipp.blndcod);
  const baVals = ranked.map(e => e.ipp.blndagnt);
  const ccVals = ranked.map(e => e.ipp.cachcod);
  const caVals = ranked.map(e => e.ipp.cachagt);
  const bVals = ranked.map(e => e.ipp.blnd);
  const cVals = ranked.map(e => e.ipp.cach);
  const tpsVals = ranked.map(e => e.throughput_p90);
  const bcDec = FMT.ippPrecision(bcVals, 2);
  const baDec = FMT.ippPrecision(baVals, 2);
  const ccDec = FMT.ippPrecision(ccVals, 2);
  const caDec = FMT.ippPrecision(caVals, 2);
  const bDec = FMT.ippPrecision(bVals, 2);
  const cDec = FMT.ippPrecision(cVals, 2);
  const tpsDec = columnPrecision(tpsVals.filter((v): v is number => v != null), 1);

  const lines: string[] = [];
  lines.push("┌─ Top 20 by Blended IPP ───────────────────────────────────────────────────────────────────────────────────────────────────────────┐");
  lines.push("│Rank Model                                        Intel Coding Agent  $M/M  p90TPS BlndCd BlndAg CachCd CachAg BlndAv CachAv       │");
  ranked.slice(0, 20).forEach((e, i) => {
    const rank = (i + 1).toString().padStart(2);
    const name = FMT.pad(e.name.length > 40 ? e.name.slice(0, 38) + "…" : e.name, 40);
    const intel = e.indices.intelligence != null ? e.indices.intelligence.toFixed(0).padStart(4) : "  — ";
    const coding = e.indices.coding != null ? e.indices.coding.toFixed(0).padStart(4) : "  — ";
    const agentic = e.indices.agentic != null ? e.indices.agentic.toFixed(0).padStart(4) : "  — ";
    const blended = FMT.cost(e.pricing.blended, costDec).padStart(6);
    const tps = e.throughput_p90 != null ? e.throughput_p90.toFixed(tpsDec).padStart(6) : "    —";
    const bc = FMT.ipp(e.ipp.blndcod, bcDec).padStart(6);
    const ba = FMT.ipp(e.ipp.blndagnt, baDec).padStart(6);
    const cc = FMT.ipp(e.ipp.cachcod, ccDec).padStart(6);
    const ca = FMT.ipp(e.ipp.cachagt, caDec).padStart(6);
    const ba_ = FMT.ipp(e.ipp.blnd, bDec).padStart(7);
    const ca_ = FMT.ipp(e.ipp.cach, cDec).padStart(7);
    lines.push(`│ ${rank} ${name} ${intel} ${coding} ${agentic} ${blended} ${tps} ${bc} ${ba} ${cc} ${ca} ${ba_} ${ca_}  │`);
  });
  lines.push("└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

function renderChanges(data: any) {
  if (!data.priorDate) {
    return "No prior snapshot yet. Run /or-metrics a second time later to see changes.";
  }
  const lines: string[] = [];
  lines.push(`┌─ Changes since ${data.priorDate} ───────────────────────────────────────────────────────────────────────────────────┐`);

  if (!data.added.length && !data.removed.length && !data.changes.length) {
    lines.push(`│ ✓ No changes. (${data.currentDate})`);
    lines.push("└─────────────────────────────────────────────────────────────────────────────────────────────────────┘");
    return lines.join("\n");
  }

  if (data.added.length > 0) {
    lines.push(`│ 🆕  New models (${data.added.length}):`);
    const names = data.added.slice(0, 12);
    for (let i = 0; i < names.length; i += 3) {
      const row = names.slice(i, i + 3).map((n: string) => n.padEnd(40).slice(0, 40)).join("");
      lines.push(`│    ${row}`);
    }
    if (data.added.length > 12) lines.push(`│    … and ${data.added.length - 12} more`);
  }
  if (data.removed.length > 0) {
    lines.push(`│ 🗑️  Gone (${data.removed.length}): ${data.removed.join(", ")}`);
  }
  if (data.changes.length > 0) {
    lines.push(`│ 📊  Changes (${data.changes.length}):`);
    const sorted = [...data.changes].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    for (const c of sorted.slice(0, 12)) {
      const arrow = c.delta > 0 ? "↑" : "↓";
      const val = c.metric === "price" 
        ? `${arrow}${Math.abs(c.delta).toFixed(1)}% (${FMT.cost(c.old)} → ${FMT.cost(c.new)})`
        : `${arrow}${Math.abs(c.delta).toFixed(1)}pt (${c.old} → ${c.new})`;
      lines.push(`│    ${FMT.pad(c.name, 40)} ${val}`);
    }
    if (data.changes.length > 12) lines.push(`│    … and ${data.changes.length - 12} more`);
  }
  lines.push("└─────────────────────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

function renderTPS(entries: any[]) {
  const ranked = [...entries]
    .filter((e) => e.throughput_p90 != null)
    .sort((a, b) => (b.throughput_p90 || 0) - (a.throughput_p90 || 0));

  const tpsVals = ranked.map((e) => e.throughput_p90);
  const tpsDec = columnPrecision(tpsVals, 1);
  const costVals = ranked.map((e) => e.pricing.blended);
  const costDec = columnPrecision(costVals, 4);
  const bVals = ranked.map((e) => e.ipp.blnd);
  const bDec = FMT.ippPrecision(bVals, 2);

  const lines: string[] = [];
  lines.push("┌─ Top Models by p90 Throughput (tokens/sec) ──────────────────────────────────────────────────────┐");
  lines.push("│Rank Model                                     p90 TPS(30m) Base$/M  BlndAv  Coding  Agentic Intel│");
  ranked.slice(0, 20).forEach((e, i) => {
    const rank = (i + 1).toString().padStart(2);
    const name = FMT.pad(e.name.length > 40 ? e.name.slice(0, 38) + "…" : e.name, 40);
    const tps = e.throughput_p90 != null ? e.throughput_p90.toFixed(tpsDec).padStart(7) : "      —";
    const blended = FMT.cost(e.pricing.blended, costDec).padStart(6);
    const ba_ = FMT.ipp(e.ipp.blnd, bDec).padStart(7);
    const coding = e.indices.coding != null ? e.indices.coding.toFixed(0).padStart(5) : "    —";
    const agentic = e.indices.agentic != null ? e.indices.agentic.toFixed(0).padStart(5) : "    —";
    const intel = e.indices.intelligence != null ? e.indices.intelligence.toFixed(0).padStart(5) : "    —";
    lines.push(`│ ${rank} ${name} ${tps}  ${blended}  ${ba_}  ${coding}  ${agentic}  ${intel}    │`);
  });
  lines.push("└──────────────────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

// ─── Extension Entry Point ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ──
  let cachedEntries: any[] | null = null;
  let cachedScoped: any[] | null = null;
  let cachedChanges: any | null = null;
  let cachedTPSData: Record<string, number | null> = {};
  let tpsCacheDate: string | null = null;
  let tpsFetchInProgress: boolean = false;
  let tpsFetchPromise: Promise<void> | null = null;

  /**
   * Fetch p90 throughput for all tracked models in parallel batches.
   * Uses the daily cache to avoid re-fetching already-known models.
   */
  async function fetchAllTPSAsync(apiKey: string, ctx: any): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    tpsFetchInProgress = true;

    try {
      // Load daily cache if available for today.
      const dailyCache = loadDailyCache();
      if (dailyCache && dailyCache.date === today) {
        cachedTPSData = { ...dailyCache.data };
        tpsCacheDate = today;
        const cachedCount = Object.keys(cachedTPSData).length;
        ctx.ui.notify(`OR-metrics TPS: loaded ${cachedCount} cached entries from today's cache`, "info");
      }

      const allSlugs = cachedEntries?.map((e: any) => e.slug) ?? [];
      const remaining = allSlugs.filter((slug: string) => cachedTPSData[slug] == null);

      if (remaining.length === 0) {
        ctx.ui.notify("OR-metrics TPS: all models already cached ✓", "info");
        return;
      }

      ctx.ui.notify(`OR-metrics TPS: fetching p90 for ${remaining.length} models…`, "info");

      let completed = 0;
      const total = remaining.length;
      let lastProgressAt = 0;

      for (let i = 0; i < remaining.length; i += TPS_CACHE_BATCH_SIZE) {
        const batch = remaining.slice(i, i + TPS_CACHE_BATCH_SIZE);

        await Promise.all(batch.map(async (slug: string) => {
          const tp = await fetchEndpointTPS(apiKey, slug);
          cachedTPSData[slug] = tp?.p90 ?? null;
          completed++;
        }));

        saveDailyCache(today, cachedTPSData);

        const now = Date.now();
        if (now - lastProgressAt >= TPS_CACHE_PROGRESS_INTERVAL) {
          lastProgressAt = now;
          ctx.ui.notify(`OR-metrics TPS: ${completed}/${total} models fetched…`, "info");
        }
      }

      saveDailyCache(today, cachedTPSData);
      ctx.ui.notify("<<< OR-metrics TPS gathering complete — rerun for full stats >>>", "info");
    } catch (error: any) {
      // Background failures must not become unhandled promise rejections.
      ctx.ui.notify(`OR-metrics TPS gathering failed: ${error?.message || error}`, "warning");
    } finally {
      tpsFetchInProgress = false;
      tpsFetchPromise = null;
    }
  }

  // Shared fetch-and-analyze (interactive only)
  async function refresh(ctx: any) {
    if (!ctx.hasUI) return null;
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      ctx.ui.notify("No OPENROUTER_API_KEY set. OR metrics unavailable.", "warning");
      return null;
    }

    ctx.ui.setStatus("or-metrics", "Pi metrics: fetching…");
    try {
      const entries = await fetchORData(apiKey);
      const scoped = findScoped(entries, activeScopedSlugs);
      const data = snapshotAndDiff(entries);
      cachedEntries = entries;
      cachedScoped = scoped;
      cachedChanges = data;

      // Reset TPS data — will be populated from cache or background fetch
      cachedTPSData = {};

      // Load daily cache immediately for instant display
      const today = new Date().toISOString().slice(0, 10);
      tpsCacheDate = today;
      const dailyCache = loadDailyCache();
      if (dailyCache && dailyCache.date === today) {
        cachedTPSData = { ...dailyCache.data };
      }

      // Seed cachedTPSData from entries that already have throughput_p90
      // (from previous snapshots or partial fetches)
      for (const e of entries) {
        if (e.throughput_p90 != null && cachedTPSData[e.slug] == null) {
          cachedTPSData[e.slug] = e.throughput_p90;
        }
      }

      // Start background TPS fetch (don't await — let it run concurrently)
      tpsFetchPromise = fetchAllTPSAsync(apiKey, ctx);

      ctx.ui.setStatus("or-metrics", `Pi is tracking ${entries.length} models`);

      // Notify on changes — rich color-coded summary
      if (data.priorDate) {
        const parts: string[] = [];
        if (data.added.length > 0) {
          const names = data.added.slice(0, 3).join(", ");
          const etc = data.added.length > 3 ? ` +${data.added.length - 3} more` : "";
          parts.push(`🆕 ${names}${etc}`);
        }
        if (data.changes.length > 0) {
          // Top 3 changes by absolute delta
          const top = [...data.changes].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
          for (const c of top) {
            const arrow = c.delta > 0 ? "↑" : "↓";
            parts.push(`${arrow} ${c.name} ${c.metric} ${Math.abs(c.delta).toFixed(1)}${c.metric === "price" ? "%" : "pt"}`);
          }
          if (data.changes.length > 3) parts.push(`… ${data.changes.length - 3} more`);
        }
        if (data.removed.length > 0) {
          parts.push(`🗑️ ${data.removed.join(", ")} (gone)`);
        }
        if (parts.length === 0) {
          ctx.ui.notify(`OR metrics: ✓ no changes since ${data.priorDate}`, "info");
        } else {
          ctx.ui.notify(`OR metrics: ${parts.join(" · ")}`, "info");
        }
      }
      return data;
    } catch (e: any) {
      ctx.ui.setStatus("or-metrics", "Pi metrics: fetch failed");
      ctx.ui.notify(`OR metrics fetch failed: ${e.message}`, "error");
      return null;
    }
  }

  // ── Auto-fetch on interactive session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return; // headless/print/json — skip
    activeScopedSlugs = ((ctx as any).scopedModels || []).map((sm: any) => ({
      slug: sm.model.id,
      label: sm.model.name || sm.model.id,
    }));
    refresh(ctx);
  });

  // ── Command: /or-metrics ──
  pi.registerCommand("or-metrics", {
    description: "Show OpenRouter ability-per-price metrics. Args: scoped | notable | top | tps | changes",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["scoped", "notable", "top", "tps", "changes"];
      return opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
    },
    handler: async (args, ctx) => {
      const apiKey = process.env.OPENROUTER_API_KEY || "";
      if (!apiKey) {
        ctx.ui.notify("Set OPENROUTER_API_KEY to use OR metrics", "warning");
        return;
      }

      // Refresh if stale
      if (!cachedEntries) {
        activeScopedSlugs = ((ctx as any).scopedModels || []).map((sm: any) => ({
          slug: sm.model.id,
          label: sm.model.name || sm.model.id,
        }));
        await refresh(ctx);
      }
      if (!cachedEntries) return; // refresh already notified

      const mode = args.trim().toLowerCase();

      // For tps mode, wait for background fetch to complete if running
      if (mode === "tps" && tpsFetchInProgress && tpsFetchPromise) {
        ctx.ui.notify("OR-metrics TPS: waiting for background fetch to complete…", "info");
        await tpsFetchPromise;
      }

      // Reload daily cache before display to pick up any new results
      const today = new Date().toISOString().slice(0, 10);
      if (tpsCacheDate !== today) {
        const dailyCache = loadDailyCache();
        if (dailyCache && dailyCache.date === today) {
          cachedTPSData = { ...dailyCache.data };
          tpsCacheDate = today;
        }
      }

      // Sync cachedTPSData into cachedEntries for display
      for (const e of cachedEntries) {
        if (cachedTPSData[e.slug] != null) {
          e.throughput_p90 = cachedTPSData[e.slug];
        }
      }

      const notable = findNotable(cachedEntries);
      const lines: string[] = [];
      const caption = `Models with AA data: ${cachedEntries.length} · cache rate: ${(DEFAULT_CACHE_RATE * 100).toFixed(0)}%`;

      if (mode === "scoped") {
        lines.push(renderScoped(cachedScoped!));
      } else if (mode === "notable") {
        lines.push(renderNotable(notable));
      } else if (mode === "top") {
        lines.push(renderTop(cachedEntries));
      } else if (mode === "tps") {
        lines.push(renderTPS(cachedEntries));
      } else if (mode === "changes") {
        lines.push(renderChanges(cachedChanges!));
      } else {
        lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
        lines.push(`║  OpenRouter Metrics — ${caption.padEnd(53)}║`);
        lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);
        lines.push("");
        lines.push(renderScoped(cachedScoped!));
        lines.push("");
        lines.push(renderNotable(notable));
        lines.push("");
        lines.push(renderTop(cachedEntries));
        lines.push("");
        lines.push(renderTPS(cachedEntries));
        if (cachedChanges?.priorDate) {
          lines.push("");
          lines.push(renderChanges(cachedChanges));
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Tool: or_metrics_query (for LLM use) ──
  pi.registerTool({
    name: "or_metrics_query",
    label: "OR Metrics Query",
    description: "Query OpenRouter ability-per-price metrics for the scoped models or for any tracked model. Use mode='scoped' for our models, mode='top N' for top N by blended IPP, mode='tps' for top models by p90 throughput, mode='find <query>' to search by name, or mode='notable' for analytical highlights. IPP fields: blndcod (BlndCd), blndagnt (BlndAg), cachcod (CachCd), cachagt (CachAg), blnd (BlndAv), cach (CachAv). TPS field: throughput_p90 (p90 tokens/sec over last 30m).",
    parameters: Type.Object({
      mode: Type.String({ description: "scoped | top N | tps | find <query> | notable" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!cachedEntries) {
        return {
          content: [{ type: "text", text: "OR metrics not loaded yet. Run /or-metrics first." }],
        };
      }
      // Also refresh scoped slugs from tool context if available
      const sm = (_ctx as any)?.scopedModels;
      if (sm && sm.length > 0 && (!activeScopedSlugs || activeScopedSlugs.length === 0)) {
        activeScopedSlugs = sm.map((x: any) => ({
          slug: x.model.id,
          label: x.model.name || x.model.id,
        }));
      }

      const mode = (params.mode || "").toLowerCase().trim();
      const result: any = { n_tracked: cachedEntries.length, timestamp: new Date().toISOString() };

      if (mode === "scoped" || mode.startsWith("scoped")) {
        result.scoped = cachedScoped!.map((s) => ({
          label: s.label,
          slug: s.slug,
          found: s.found,
          indices: s.entry?.indices || null,
          ipp: s.entry?.ipp || null,
          throughput_p90: cachedTPSData[s.slug] ?? null,
          pricing: s.entry ? { blended: s.entry.pricing.blended, blended_cached: s.entry.pricing.blendedCached } : null,
        }));
      } else if (mode.startsWith("top")) {
        const n = parseInt(mode.replace("top", "").trim()) || 10;
        const ranked = [...cachedEntries].filter((e) => e.ipp.blnd != null)
          .sort((a, b) => (b.ipp.blnd || 0) - (a.ipp.blnd || 0))
          .slice(0, Math.min(n, 50));
        result.rankings = ranked.map((e) => ({
          name: e.name,
          slug: e.slug,
          indices: e.indices,
          ipp: e.ipp,
          throughput_p90: cachedTPSData[e.slug] ?? null,
          blended_cost: e.pricing.blended,
        }));
      } else if (mode.startsWith("find")) {
        const q = mode.replace("find", "").trim().toLowerCase();
        const matches = cachedEntries.filter((e) => e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q));
        result.matches = matches.slice(0, 10).map((e) => ({
          name: e.name,
          slug: e.slug,
          indices: e.indices,
          ipp: e.ipp,
          throughput_p90: cachedTPSData[e.slug] ?? null,
          blended_cost: e.pricing.blended,
        }));
        if (matches.length === 0) result.note = `No matches for "${q}"`;
      } else if (mode === "tps") {
        const ranked = [...cachedEntries]
          .map((e) => ({ ...e, _tps: cachedTPSData[e.slug] ?? null }))
          .filter((e) => e._tps != null)
          .sort((a, b) => (b._tps || 0) - (a._tps || 0))
          .slice(0, 20);
        result.tps_rankings = ranked.map((e) => ({
          name: e.name,
          slug: e.slug,
          throughput_p90: e._tps,
          blended_cost: e.pricing.blended,
          ipp: e.ipp,
        }));
      } else if (mode === "notable") {
        result.notable = findNotable(cachedEntries);
      } else {
        result.error = `Unknown mode: ${mode}. Use: scoped, top N, tps, find <query>, notable`;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  });
}