/**
 * OpenRouter Metrics Extension
 *
 * Fetches Artificial Analysis indices (coding, agentic, intelligence) from
 * the OpenRouter models API on session start, computes ability-per-price
 * (IPP) metrics, snapshots for change detection, and exposes a /or-metrics
 * command plus a or_metrics tool for the LLM.
 *
 * Also fetches endpoint-level throughput data (p90 tokens/sec) from the
 * OpenRouter endpoints API. The model-level value is averaged across all
 * available upstream providers, each measured over a 30-minute window
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
 *   /or-metrics tps       — top models by provider-averaged p90 throughput (tokens/sec, 30m window)
 *   /or-metrics changes   — diff since last snapshot
 *   /or-metrics --all     — include free models (slug contains :free) in the display
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  averageEndpointThroughput,
  setModelBenchmarkTPS,
  setModelBenchmarkTPSMap,
  type ThroughputStats,
} from "./throughput";
import Table from "cli-table3";
import { renderTable } from "./table";

// ─── Types ────────────────────────────────────────────────────────────────

interface ModelBenchmark {
  coding_index: number | null;
  agentic_index: number | null;
  intelligence_index: number | null;
}

interface ModelPricing {
  prompt: string;
  completion: string;
  input_cache_read?: string | null;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  pricing: ModelPricing;
  benchmarks?: {
    artificial_analysis?: ModelBenchmark;
  };
}

export interface ParsedPricing {
  input: number;
  output: number;
  cacheRead: number | null;
}

export interface IPPMetrics {
  blndcod: number | null;
  blndagnt: number | null;
  cachcod: number | null;
  cachagt: number | null;
  blnd: number | null;
  cach: number | null;
}

export interface ModelEntry {
  slug: string;
  name: string;
  pricing: {
    input: number;
    output: number;
    cacheRead: number | null;
    blended: number;
    blendedCached: number;
  };
  indices: {
    intelligence: number | null;
    coding: number | null;
    agentic: number | null;
  };
  ipp: IPPMetrics;
  throughput_p90: number | null;
  throughput_p50: number | null;
  throughput_mean: number | null;
}

interface SnapshotModel {
  slug: string;
  name: string;
  coding_index: number | null;
  agentic_index: number | null;
  intelligence_index: number | null;
  blended_cost_per_m: number;
  blended_cached_per_m: number;
  blndcod: number | null;
  blndagnt: number | null;
  cachcod: number | null;
  cachagt: number | null;
  blnd: number | null;
  cach: number | null;
  throughput_p90: number | null;
  throughput_p50: number | null;
  throughput_mean: number | null;
}

interface SnapshotPayload {
  snapshot_date: string;
  fetched_at: string;
  n_models: number;
  models: SnapshotModel[];
}

interface DiffChange {
  slug: string;
  name: string;
  metric: string;
  old: number;
  new: number;
  delta: number;
}

interface DiffResult {
  priorDate: string | null;
  currentDate: string;
  added: string[];
  removed: string[];
  changes: DiffChange[];
}

// ─── Notable Types ─────────────────────────────────────────────────────

interface NotableModel {
  slug: string;
  name: string;
  v: number;
  blended_cost: number;
}

interface NotableSideBySide {
  kind: "sideBySide";
  title: string;
  leftTitle: string;
  rightTitle: string;
  leftModels: NotableModel[];
  rightModels: NotableModel[];
}

interface NotableVertical {
  kind: "vertical";
  category: string;
  models: NotableModel[];
}

type NotableEntry = NotableSideBySide | NotableVertical;

/** Context passed to the `or_metrics_query` tool execute handler. */
interface ToolExecuteContext {
  scopedModels?: { model: { id: string; name?: string } }[];
}

/** Result of a metrics refresh (fetch + analyze + snapshot). */
interface MetricsRefreshResult {
  priorDate: string | null;
  currentDate: string;
  added: string[];
  removed: string[];
  changes: DiffChange[];
  entries: ModelEntry[];
  entriesWithData: SnapshotModel[];
}

interface ScopedModelEntry {
  slug: string;
  label: string;
  entry: ModelEntry | null;
  found: boolean;
}

interface MetricsCommandCtx {
  hasUI: boolean;
  ui: { notify: (msg: string, level: string) => void; setStatus: (key: string, msg: string | undefined) => void };
  model?: { id: string };
  scopedModels?: { model: { id: string; name?: string } }[];
  /** Override display mode: "names" to show human-readable names, "slugs" (default) to show slugs. */
  displayModelNames?: boolean;
}

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

/**
 * When true, display human-readable model names instead of slugs.
 * Defaults to false (show slugs). Set OR_METRICS_DISPLAY_MODEL_NAMES=1
 * or OR_METRICS_DISPLAY_MODEL_NAMES=true to show names.
 */
const DISPLAY_MODEL_NAMES =
  process.env.OR_METRICS_DISPLAY_MODEL_NAMES === "1" ||
  process.env.OR_METRICS_DISPLAY_MODEL_NAMES === "true";

/** Return the display label for a model entry: slug (default) or name. */
function modelLabel(e: ModelEntry): string {
  return DISPLAY_MODEL_NAMES ? (e.name || e.slug) : e.slug;
}

/** Return true when the model slug contains `:free` (a free-tier model). */
function isFreeModel(e: ModelEntry): boolean {
  return e.slug.includes(":free");
}

/**
 * Return entries with free models excluded by default.
 * Pass `includeFree = true` to keep them.
 */
function filterModels(entries: ModelEntry[], includeFree: boolean): ModelEntry[] {
  return includeFree ? entries : entries.filter((e) => !isFreeModel(e));
}

// Populated from ctx.scopedModels at session start
let activeScopedSlugs: { slug: string; label: string }[] = [];



// ─── HTTP Fetch ────────────────────────────────────────────────────────────────

async function fetchJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

// ─── Pricing / Analysis ────────────────────────────────────────────────────────

export function parsePricing(p: ModelPricing | null | undefined): ParsedPricing | null {
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

export function analyzeModels(models: OpenRouterModel[], tpsData?: Record<string, ThroughputStats | null>): ModelEntry[] {
  const entries: ModelEntry[] = [];

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

export function findScoped(entries: ModelEntry[], slugs: { slug: string; label: string }[]): ScopedModelEntry[] {
  return slugs.map((s) => {
    const e = entries.find((x) => x.slug === s.slug);
    return { ...s, entry: e || null, found: !!e };
  });
}

// ─── Fetch from API ────────────────────────────────────────────────────────────

async function fetchORData(apiKey: string): Promise<ModelEntry[]> {
  const url = `${OR_API_BASE}/models?limit=400`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const result = await fetchJSON(url, headers);
  if (!result?.data) throw new Error("No data from OpenRouter");

  // No TPS data fetched here — call fetchTPSForSlugs separately for
  // scoped models or top-ranked models to avoid excessive API calls.
  return analyzeModels(result.data as OpenRouterModel[]);
}

/**
 * Fetch endpoint-level throughput data for a single model and average the
 * available provider endpoints. Returns p90, p50 and mean or null if unavailable.
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
    return averageEndpointThroughput(endpoints);
  } catch {
    return null;
  }
}

/**
 * Fetch provider-averaged p90 throughput for a set of model slugs in parallel.
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

function rotateSnapshots(): void {
  const latestPath = path.join(SNAPSHOT_DIR, "latest.json");
  const prevPath = path.join(SNAPSHOT_DIR, "previous.json");
  try {
    if (fs.existsSync(latestPath)) {
      if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
      fs.renameSync(latestPath, prevPath);
    }
  } catch { /* best-effort */ }
}

function saveSnapshot(payload: SnapshotPayload): void {
  ensureDir();
  const latestPath = path.join(SNAPSHOT_DIR, "latest.json");
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2));
}

function loadPriorSnapshot(): SnapshotPayload | null {
  const prevPath = path.join(SNAPSHOT_DIR, "previous.json");
  try {
    const raw = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    if (!raw?.snapshot_date || !raw?.models) return null;
    return raw as SnapshotPayload;
  } catch {
    return null;
  }
}

function buildSnapshotPayload(entries: ModelEntry[]): SnapshotPayload {
  return {
    snapshot_date: new Date().toISOString().slice(0, 10),
    fetched_at: new Date().toISOString(),
    n_models: entries.length,
    models: entries.map((e) => ({
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
}

function computeDiff(prior: SnapshotPayload, current: SnapshotPayload): DiffResult {
  const changes: DiffChange[] = [];
  let added: string[] = [];
  let removed: string[] = [];

  const priorIdx: Record<string, SnapshotModel> = {};
  (prior.models || []).forEach((m) => (priorIdx[m.slug] = m));
  const currIdx: Record<string, SnapshotModel> = {};
  (current.models || []).forEach((m) => (currIdx[m.slug] = m));

  added = current.models
    .filter((m) => !priorIdx[m.slug])
    .map((m) => DISPLAY_MODEL_NAMES ? m.name : m.slug);
  removed = (prior.models || [])
    .filter((m) => !currIdx[m.slug])
    .map((m) => DISPLAY_MODEL_NAMES ? m.name : m.slug);

  for (const slug of Object.keys(currIdx)) {
    if (!priorIdx[slug]) continue;
    const p = priorIdx[slug];
    const c = currIdx[slug];
    if (p.coding_index != null && c.coding_index != null) {
      const d = c.coding_index - p.coding_index;
      if (Math.abs(d) >= 0.5) changes.push({ slug: c.slug, name: c.name, metric: "coding", old: p.coding_index, new: c.coding_index, delta: d });
    }
    if (p.agentic_index != null && c.agentic_index != null) {
      const d = c.agentic_index - p.agentic_index;
      if (Math.abs(d) >= 0.5) changes.push({ slug: c.slug, name: c.name, metric: "agentic", old: p.agentic_index, new: c.agentic_index, delta: d });
    }
    if (p.blended_cost_per_m != null && c.blended_cost_per_m != null) {
      const d = ((c.blended_cost_per_m - p.blended_cost_per_m) / p.blended_cost_per_m) * 100;
      if (Math.abs(d) >= 5) changes.push({ slug: c.slug, name: c.name, metric: "price", old: p.blended_cost_per_m, new: c.blended_cost_per_m, delta: d });
    }
    if (p.throughput_p90 != null && c.throughput_p90 != null) {
      const d = c.throughput_p90 - p.throughput_p90;
      if (Math.abs(d) >= 5) changes.push({ slug: c.slug, name: c.name, metric: "throughput_p90", old: p.throughput_p90, new: c.throughput_p90, delta: d });
    }
    if (p.throughput_p50 != null && c.throughput_p50 != null) {
      const d = c.throughput_p50 - p.throughput_p50;
      if (Math.abs(d) >= 5) changes.push({ slug: c.slug, name: c.name, metric: "throughput_p50", old: p.throughput_p50, new: c.throughput_p50, delta: d });
    }
    if (p.throughput_mean != null && c.throughput_mean != null) {
      const d = c.throughput_mean - p.throughput_mean;
      if (Math.abs(d) >= 5) changes.push({ slug: c.slug, name: c.name, metric: "throughput_mean", old: p.throughput_mean, new: c.throughput_mean, delta: d });
    }
  }

  return { added, removed, changes };
}

export function snapshotAndDiff(entries: ModelEntry[]) {
  ensureDir();

  // Load prior snapshot
  const prior = loadPriorSnapshot();

  // Rotate: current latest becomes previous
  rotateSnapshots();

  // Save new snapshot
  const payload = buildSnapshotPayload(entries);
  saveSnapshot(payload);

  // Compute diff
  const diff = prior ? computeDiff(prior, payload) : { added: [] as string[], removed: [] as string[], changes: [] as DiffChange[] };

  return {
    priorDate: prior?.snapshot_date || null,
    currentDate: payload.snapshot_date,
    nEntries: entries.length,
    added: diff.added,
    removed: diff.removed,
    changes: diff.changes,
    entries,
    entriesWithData: payload.models,
  };
}

// ─── Notable Detection ──────────────────────────────────────────────────────────

/**
 * Compute notable model highlights from entries.
 *
 * Raw ability categories (agentic, coding) are returned as
 * side-by-side pairs: left column is the uncapped (legacy) top-5
 * and right column is the price-capped top-5.
 *
 * IPP categories (blended, cached) are price-affected by nature
 * and are returned as vertical entries.
 *
 * @param entries - full model entry list
 * @param cap - maximum blended cost per million tokens for the
 *   capped variation. Defaults to 1.
 */
export function findNotable(entries: ModelEntry[], cap = 1): NotableEntry[] {
  const result: NotableEntry[] = [];

  const byAgentic = [...entries].filter((e) => e.indices.agentic != null)
    .sort((a, b) => (b.indices.agentic || 0) - (a.indices.agentic || 0));
  const byAgenticCheap = byAgentic.filter((e) => e.pricing.blended < cap);
  result.push({
    kind: "sideBySide",
    title: "🏆 Agentic Ability",
    leftTitle: "Agentic (raw)",
    rightTitle: `Agentic <$${cap}>`,
    leftModels: byAgentic.slice(0, 5).map((e) => ({ slug: e.slug, name: e.name, v: e.indices.agentic, blended_cost: e.pricing.blended })),
    rightModels: byAgenticCheap.slice(0, 5).map((e) => ({ slug: e.slug, name: e.name, v: e.indices.agentic, blended_cost: e.pricing.blended })),
  });

  const byCoding = [...entries].filter((e) => e.indices.coding != null)
    .sort((a, b) => (b.indices.coding || 0) - (a.indices.coding || 0));
  const byCodingCheap = byCoding.filter((e) => e.pricing.blended < cap);
  result.push({
    kind: "sideBySide",
    title: "💻 Coding Ability",
    leftTitle: "Coding (raw)",
    rightTitle: `Coding <$${cap}>`,
    leftModels: byCoding.slice(0, 5).map((e) => ({ slug: e.slug, name: e.name, v: e.indices.coding, blended_cost: e.pricing.blended })),
    rightModels: byCodingCheap.slice(0, 5).map((e) => ({ slug: e.slug, name: e.name, v: e.indices.coding, blended_cost: e.pricing.blended })),
  });

  const byBlendedIPP = [...entries].filter((e) => e.ipp.blnd != null)
    .sort((a, b) => (b.ipp.blnd || 0) - (a.ipp.blnd || 0));
  result.push({
    kind: "vertical",
    category: "💰 Best Blended IPP (ability-per-price, blended costs)",
    models: byBlendedIPP.slice(0, 5).map((e) => ({ slug: e.slug, name: e.name, v: e.ipp.blnd, blended_cost: e.pricing.blended })),
  });

  const byCachedIPP = [...entries].filter((e) => e.ipp.cach != null)
    .sort((a, b) => (b.ipp.cach || 0) - (a.ipp.cach || 0));
  result.push({
    kind: "vertical",
    category: "🔄 Best Cached IPP (70% cache assumed)",
    models: byCachedIPP.slice(0, 5).map((e) => ({ slug: e.slug, name: e.name, v: e.ipp.cach, blended_cost: e.pricing.blended })),
  });

  return result;
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

/**
 * Render the scoped-models table using cli-table3.
 *
 * Produces the same box-drawing output as the previous hand-rolled
 * implementation but delegates all column-width computation, padding,
 * and alignment to cli-table3.
 */
export function renderScoped(scoped: ScopedModelEntry[]) {
  const COLS = [
    { label: "Model", align: "left" as const },
    { label: "Intel", align: "right" as const },
    { label: "Coding", align: "right" as const },
    { label: "Agentic", align: "right" as const },
    { label: "Base$/M", align: "right" as const },
    { label: "p90TPS", align: "right" as const },
    { label: "BlndCd", align: "right" as const },
    { label: "BlndAg", align: "right" as const },
    { label: "CachCd", align: "right" as const },
    { label: "CachAg", align: "right" as const },
  ];

  // Collect precision info from actual data values.
  const costVals: (number | null)[] = [];
  const tpsVals: (number | null)[] = [];
  const ipCols: (number | null)[][] = [[], [], [], []];
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
  const ipDecs = ipCols.map((c) => FMT.ippPrecision(c, 2));

  const head = COLS.map((c) => c.label);
  const rows: string[][] = [];

  for (const s of scoped) {
    if (!s.entry) {
      const name = FMT.pad(s.label, 40).slice(0, 40);
      rows.push([name, "  no data from OpenRouter", "", "", "", "", "", "", "", ""]);
      continue;
    }
    const e = s.entry;
    const intel = e.indices.intelligence != null ? e.indices.intelligence.toFixed(1) : "—";
    const coding = e.indices.coding != null ? e.indices.coding.toFixed(1) : "—";
    const agentic = e.indices.agentic != null ? e.indices.agentic.toFixed(1) : "—";
    const blended = FMT.cost(e.pricing.blended, costDec);
    const tps = e.throughput_p90 != null ? e.throughput_p90.toFixed(tpsDec) : "—";
    const bc = e.ipp.blndcod != null ? e.ipp.blndcod.toFixed(ipDecs[0]) : "—";
    const ba = e.ipp.blndagnt != null ? e.ipp.blndagnt.toFixed(ipDecs[1]) : "—";
    const cc = e.ipp.cachcod != null ? e.ipp.cachcod.toFixed(ipDecs[2]) : "—";
    const ca = e.ipp.cachagt != null ? e.ipp.cachagt.toFixed(ipDecs[3]) : "—";
    rows.push([s.label, intel, coding, agentic, blended, tps, bc, ba, cc, ca]);
  }

  const table = new Table({
    head,
    style: {
      border: ["─", "│", "┌", "┐", "└", "┘", "┬", "├", "┤", "┴", "┼"],
      paddingLeft: 1,
      paddingRight: 1,
      head: [],
    },
    colAligns: COLS.map((c) => c.align),
  } as any);

  for (const row of rows) {
    table.push(row);
  }

  let output = table.toString();

  // Replace the top border line with a titled version.
  const titlePrefix = "─ Our Scoped Models ─";
  const lines = output.split("\n");
  const topLine = lines[0];
  const titledTop = `┌${titlePrefix.padEnd(topLine.length - 2, "─")}┐`;
  output = [titledTop, ...lines.slice(1)].join("\n");

  return output;
}

/**
 * Render notable model highlights using cli-table3.
 *
 * Side-by-side entries (raw vs capped ability) are rendered as
 * a single 4-column table. Vertical entries (IPP rankings) are
 * rendered as a 3-column table.
 */
export function renderNotable(notable: NotableEntry[]) {
  const lines: string[] = [];

  // Title bar — same width as the widest table we produce.
  const titleBar = "┌─ Notable ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐";
  lines.push(titleBar);

  for (const n of notable) {
    if (n.kind === "sideBySide") {
      const head = [n.leftTitle, "Score ($/M)", n.rightTitle, "Score ($/M)"];
      const table = new Table({
        head,
        style: {
          border: ["─", "│", "┌", "┐", "└", "┘", "┬", "├", "┤", "┴", "┼"],
          paddingLeft: 1,
          paddingRight: 1,
          head: [],
        },
        colAligns: ["left", "right", "left", "right"],
      } as any);

      const maxRows = Math.max(n.leftModels.length, n.rightModels.length);
      for (let i = 0; i < maxRows; i++) {
        const lm = n.leftModels[i];
        const rm = n.rightModels[i];
        const leftName = lm ? (DISPLAY_MODEL_NAMES ? (lm.name || lm.slug) : lm.slug) : "";
        const leftScore = lm ? (lm.v > 100 ? lm.v.toFixed(1) : lm.v.toFixed(2)) + " " + FMT.cost(lm.blended_cost) + "/M" : "";
        const rightName = rm ? (DISPLAY_MODEL_NAMES ? (rm.name || rm.slug) : rm.slug) : "";
        const rightScore = rm ? (rm.v > 100 ? rm.v.toFixed(1) : rm.v.toFixed(2)) + " " + FMT.cost(rm.blended_cost) + "/M" : "";
        table.push([leftName, leftScore, rightName, rightScore]);
      }

      let output = table.toString();
      // Prepend the section title as the first line.
      const sectionLine = `│ ${n.title}`;
      output = [sectionLine, ...output.split("\n").slice(1)].join("\n");
      lines.push(output);
    } else {
      // Vertical entry
      const head = ["Model", "Score", "Cost/M"];
      const table = new Table({
        head,
        style: {
          border: ["─", "│", "┌", "┐", "└", "┘", "┬", "├", "┤", "┴", "┼"],
          paddingLeft: 1,
          paddingRight: 1,
          head: [],
        },
        colAligns: ["left", "right", "right"],
      } as any);

      for (const m of n.models) {
        const displayName = DISPLAY_MODEL_NAMES ? (m.name || "") : (m.slug || m.name || "");
        const v = typeof m.v === "number" ? (m.v > 100 ? m.v.toFixed(1) : m.v.toFixed(2)) : "—";
        const cost = FMT.cost(m.blended_cost);
        table.push([displayName, v, cost]);
      }

      let output = table.toString();
      const sectionLine = `│ ${n.category}`;
      output = [sectionLine, ...output.split("\n").slice(1)].join("\n");
      lines.push(output);

      // Separator line
      const sepLine = "│" + "─".repeat(112) + "│";
      lines.push(sepLine);
    }
  }

  lines.push("└" + "─".repeat(112) + "┘");
  return lines.join("\n");
}

export function renderTop(entries: ModelEntry[]) {
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

  const titlePrefix = "─ Top 20 by Blended IPP ─";
  return renderTable(
    [
      { label: "Rank",   format: (_, i) => String(i + 1).padStart(4), align: "right" },
      { label: "Model",  format: (e) => {
        const label = modelLabel(e);
        return label.length > 40 ? label.slice(0, 38) + "…" : label;
      } },
      { label: "Intel",  format: (e) => e.indices.intelligence != null ? e.indices.intelligence.toFixed(0) : "—" },
      { label: "Coding", format: (e) => e.indices.coding != null ? e.indices.coding.toFixed(0) : "—" },
      { label: "Agent",  format: (e) => e.indices.agentic != null ? e.indices.agentic.toFixed(0) : "—" },
      { label: "$M/M",   format: (e) => FMT.cost(e.pricing.blended, costDec) },
      { label: "p90TPS", format: (e) => e.throughput_p90 != null ? e.throughput_p90.toFixed(tpsDec) : "—" },
      { label: "BlndCd", format: (e) => e.ipp.blndcod != null ? e.ipp.blndcod.toFixed(bcDec) : "—" },
      { label: "BlndAg", format: (e) => e.ipp.blndagnt != null ? e.ipp.blndagnt.toFixed(baDec) : "—" },
      { label: "CachCd", format: (e) => e.ipp.cachcod != null ? e.ipp.cachcod.toFixed(ccDec) : "—" },
      { label: "CachAg", format: (e) => e.ipp.cachagt != null ? e.ipp.cachagt.toFixed(caDec) : "—" },
      { label: "BlndAv", format: (e) => e.ipp.blnd != null ? e.ipp.blnd.toFixed(bDec) : "—" },
      { label: "CachAv", format: (e) => e.ipp.cach != null ? e.ipp.cach.toFixed(cDec) : "—" },
    ],
    ranked.slice(0, 20),
    { sep: " ", titlePrefix }
  );
}

/**
 * Render snapshot diff using cli-table3 for the changes list.
 */
export function renderChanges(data: { priorDate: string | null; currentDate: string; added: string[]; removed: string[]; changes: DiffChange[]; } | null) {
  if (!data.priorDate) {
    return "No prior snapshot yet. Run /or-metrics a second time later to see changes.";
  }
  const lines: string[] = [];

  // Header
  const headerLine = `┌─ Changes since ${data.priorDate} ───────────────────────────────────────────────────────────────────────────────────┐`;
  lines.push(headerLine);

  if (!data.added.length && !data.removed.length && !data.changes.length) {
    lines.push(`│ ✓ No changes. (${data.currentDate})`);
    lines.push("└─────────────────────────────────────────────────────────────────────────────────────────────────────┘");
    return lines.join("\n");
  }

  if (data.added.length > 0) {
    lines.push(`│ 🆕  New models (${data.added.length}):`);
    // Use cli-table3 for the 3-column layout
    const table = new Table({
      head: [],
      style: {
        border: [" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " "],
        paddingLeft: 0,
        paddingRight: 0,
        head: [],
      },
      colWidths: [40, 40, 40],
    } as any);
    const names = data.added.slice(0, 12);
    for (let i = 0; i < names.length; i += 3) {
      const row = names.slice(i, i + 3);
      while (row.length < 3) row.push("");
      table.push(row);
    }
    // Prefix each data row with "│    "
    const tableOut = table.toString();
    for (const l of tableOut.split("\n")) {
      lines.push(`│    ${l}`);
    }
    if (data.added.length > 12) lines.push(`│    … and ${data.added.length - 12} more`);
  }
  if (data.removed.length > 0) {
    lines.push(`│ 🗑️  Gone (${data.removed.length}): ${data.removed.join(", ")}`);
  }
  if (data.changes.length > 0) {
    lines.push(`│ 📊  Changes (${data.changes.length}):`);
    const sorted = [...data.changes].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    // Use cli-table3 for the changes table
    const table = new Table({
      head: ["Model", "Change"],
      style: {
        border: ["─", "│", "┌", "┐", "└", "┘", "┬", "├", "┤", "┴", "┼"],
        paddingLeft: 1,
        paddingRight: 1,
        head: [],
      },
      colAligns: ["left", "left"],
    } as any);
    for (const c of sorted.slice(0, 12)) {
      const arrow = c.delta > 0 ? "↑" : "↓";
      const val = c.metric === "price"
        ? `${arrow}${Math.abs(c.delta).toFixed(1)}% (${FMT.cost(c.old)} → ${FMT.cost(c.new)})${c.metric === "price" ? "" : ""}`
        : `${arrow}${Math.abs(c.delta).toFixed(1)}pt (${c.old} → ${c.new})`;
      const displayLabel = DISPLAY_MODEL_NAMES ? c.name : c.slug;
      table.push([displayLabel, val]);
    }
    const tableOut = table.toString();
    for (const l of tableOut.split("\n")) {
      lines.push(`│ ${l}`);
    }
    if (data.changes.length > 12) lines.push(`│    … and ${data.changes.length - 12} more`);
  }
  lines.push("└─────────────────────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

export function renderTPS(entries: ModelEntry[]) {
  const ranked = [...entries]
    .filter((e) => e.throughput_p90 != null)
    .sort((a, b) => (b.throughput_p90 || 0) - (a.throughput_p90 || 0));

  const tpsVals = ranked.map((e) => e.throughput_p90);
  const tpsDec = columnPrecision(tpsVals, 1);
  const costVals = ranked.map((e) => e.pricing.blended);
  const costDec = columnPrecision(costVals, 4);
  const bVals = ranked.map((e) => e.ipp.blnd);
  const bDec = FMT.ippPrecision(bVals, 2);

  const titlePrefix = "─ Top Models by p90 Throughput (tokens/sec) ─";
  return renderTable(
    [
      { label: "Rank",       format: (_, i) => String(i + 1).padStart(2), align: "right" },
      { label: "Model",      format: (e) => {
        const label = modelLabel(e);
        return label.length > 40 ? label.slice(0, 38) + "…" : label;
      } },
      { label: "p90 TPS(30m)", format: (e) => e.throughput_p90 != null ? e.throughput_p90.toFixed(tpsDec) : "—" },
      { label: "Base$/M",    format: (e) => FMT.cost(e.pricing.blended, costDec) },
      { label: "BlndAv",     format: (e) => e.ipp.blnd != null ? e.ipp.blnd.toFixed(bDec) : "—" },
      { label: "Coding",     format: (e) => e.indices.coding != null ? e.indices.coding.toFixed(0) : "—" },
      { label: "Agentic",    format: (e) => e.indices.agentic != null ? e.indices.agentic.toFixed(0) : "—" },
      { label: "Intel",      format: (e) => e.indices.intelligence != null ? e.indices.intelligence.toFixed(0) : "—" },
    ],
    ranked.slice(0, 20),
    { sep: "  ", titlePrefix }
  );
}

// ─── Extension Entry Point ──────────────────────────────────────────────────────

export function setupMetrics(pi: ExtensionAPI) {
  // ── State ──
  let cachedEntries: ModelEntry[] | null = null;
  let cachedScoped: ScopedModelEntry[] | null = null;
  let cachedChanges: MetricsRefreshResult | null;
  let cachedTPSData: Record<string, number | null> = {};
  let tpsCacheDate: string | null = null;
  let tpsFetchInProgress: boolean = false;
  let tpsFetchPromise: Promise<void> | null = null;
  // Background work may outlive the session that started it. Once the session
  // is replaced, the captured context becomes stale and must not be touched.
  let sessionActive = true;

  function tryNotify(ctx: MetricsCommandCtx, msg: string, level: "info" | "warning" | "error"): void {
    if (!sessionActive) return;
    try {
      ctx.ui.notify(msg, level);
    } catch {
      // The context may have become stale between the active check and access.
    }
  }

  function trySetStatus(ctx: MetricsCommandCtx, key: string, msg: string | undefined): void {
    if (!sessionActive) return;
    try {
      ctx.ui.setStatus(key, msg);
    } catch {
      // The context may have become stale between the active check and access.
    }
  }

  /**
   * Fetch p90 throughput for all tracked models in parallel batches.
   * Uses the daily cache to avoid re-fetching already-known models.
   */
  async function fetchAllTPSAsync(apiKey: string, ctx: MetricsCommandCtx): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    tpsFetchInProgress = true;

    try {
      // Load daily cache if available for today.
      const dailyCache = loadDailyCache();
      if (dailyCache && dailyCache.date === today) {
        cachedTPSData = { ...dailyCache.data };
        setModelBenchmarkTPSMap(cachedTPSData);
        tpsCacheDate = today;
        const cachedCount = Object.keys(cachedTPSData).length;
        tryNotify(ctx, `OR-metrics TPS: loaded ${cachedCount} cached entries from today's cache`, "info");
      }

      const allSlugs = cachedEntries?.map((e: ModelEntry) => e.slug) ?? [];
      const remaining = allSlugs.filter((slug: string) => cachedTPSData[slug] == null);

      if (remaining.length === 0) {
        tryNotify(ctx, "OR-metrics TPS: all models already cached ✓", "info");
        return;
      }

      tryNotify(ctx, `OR-metrics TPS: fetching p90 for ${remaining.length} models…`, "info");

      let completed = 0;
      const total = remaining.length;
      let lastProgressAt = 0;

      for (let i = 0; i < remaining.length; i += TPS_CACHE_BATCH_SIZE) {
        const batch = remaining.slice(i, i + TPS_CACHE_BATCH_SIZE);

        await Promise.all(batch.map(async (slug: string) => {
          const tp = await fetchEndpointTPS(apiKey, slug);
          cachedTPSData[slug] = tp?.p90 ?? null;
          setModelBenchmarkTPS(slug, cachedTPSData[slug]);
          completed++;
        }));

        saveDailyCache(today, cachedTPSData);

        const now = Date.now();
        if (now - lastProgressAt >= TPS_CACHE_PROGRESS_INTERVAL) {
          lastProgressAt = now;
          tryNotify(ctx, `OR-metrics TPS: ${completed}/${total} models fetched…`, "info");
        }
      }

      saveDailyCache(today, cachedTPSData);
      tryNotify(ctx, "<<< OR-metrics TPS gathering complete — rerun for full stats >>>", "info");
    } catch (error: unknown) {
      // Background failures must not become unhandled promise rejections.
      tryNotify(ctx, `OR-metrics TPS gathering failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    } finally {
      tpsFetchInProgress = false;
      tpsFetchPromise = null;
    }
  }

  // Shared fetch-and-analyze (interactive only)
  async function refresh(ctx: MetricsCommandCtx): Promise<MetricsRefreshResult | null> {
    if (!sessionActive || !ctx.hasUI) return null;
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      tryNotify(ctx, "No OPENROUTER_API_KEY set. OR metrics unavailable.", "warning");
      return null;
    }

    trySetStatus(ctx, "or-metrics", "Pi metrics: fetching…");
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
        setModelBenchmarkTPSMap(cachedTPSData);
      }

      // Seed cachedTPSData from entries that already have throughput_p90
      // (from previous snapshots or partial fetches)
      for (const e of entries) {
        if (e.throughput_p90 != null && cachedTPSData[e.slug] == null) {
          cachedTPSData[e.slug] = e.throughput_p90;
        }
        setModelBenchmarkTPS(e.slug, cachedTPSData[e.slug] ?? null);
      }

      // Start background TPS fetch (don't await — let it run concurrently)
      tpsFetchPromise = fetchAllTPSAsync(apiKey, ctx);

      trySetStatus(ctx, "or-metrics", `Pi is tracking ${entries.length} models`);

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
          tryNotify(ctx, `OR metrics: ✓ no changes since ${data.priorDate}`, "info");
        } else {
          tryNotify(ctx, `OR metrics: ${parts.join(" · ")}`, "info");
        }
      }
      return data;
    } catch (e: unknown) {
      trySetStatus(ctx, "or-metrics", "Pi metrics: fetch failed");
      tryNotify(ctx, `OR metrics fetch failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      return null;
    }
  }

  // ── Auto-fetch on interactive session start ──
  pi.on("session_start", async (_event, ctx: MetricsCommandCtx): Promise<void> => {
    if (!ctx.hasUI) return; // headless/print/json — skip
    const useNames = ctx.displayModelNames ?? DISPLAY_MODEL_NAMES;
    activeScopedSlugs = ((ctx as { scopedModels?: { model: { id: string; name?: string } }[] }).scopedModels || []).map((sm) => ({
      slug: sm.model.id,
      label: useNames ? (sm.model.name || sm.model.id) : sm.model.id,
    }));
    refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
  });

  // ── Command: /or-metrics ──
  pi.registerCommand("or-metrics", {
    description: "Show OpenRouter ability-per-price and provider-averaged throughput metrics. Args: scoped | notable | top | tps | changes [--cap N] [--all] (default cap: $1). Free models (slug contains ':free') are excluded by default; use --all to include them. Notable raw ability categories display side-by-side: uncapped left vs price-capped right.",
    getArgumentCompletions: (prefix: string): { value: string; label: string }[] | null => {
      const opts = ["scoped", "notable", "top", "tps", "changes"];
      return opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
    },
    handler: async (args: string, ctx: MetricsCommandCtx): Promise<void> => {
      const apiKey = process.env.OPENROUTER_API_KEY || "";
      if (!apiKey) {
        ctx.ui.notify("Set OPENROUTER_API_KEY to use OR metrics", "warning");
        return;
      }

      // Refresh if stale
      if (!cachedEntries) {
        const useNames = (ctx as MetricsCommandCtx).displayModelNames ?? DISPLAY_MODEL_NAMES;
        activeScopedSlugs = ((ctx as any).scopedModels || []).map((sm: any) => ({
          slug: sm.model.id,
          label: useNames ? (sm.model.name || sm.model.id) : sm.model.id,
        }));
        await refresh(ctx);
      }
      if (!cachedEntries) return; // refresh already notified

      // Parse --cap N and --all from args (e.g. "/or-metrics notable --cap 3 --all")
      const capMatch = args.match(/--cap\s+(\d+(?:\.\d+)?)/);
      const cap = capMatch ? parseFloat(capMatch[1]) : 1;
      const includeFree = args.includes("--all");
      // Strip flags from args so the mode parsing is unaffected
      const mode = args.replace(/--cap\s+\S+\s*/, "").replace(/--all\s*/, "").trim().toLowerCase();

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
          setModelBenchmarkTPSMap(cachedTPSData);
          tpsCacheDate = today;
        }
      }

      // Sync cachedTPSData into cachedEntries for display
      for (const e of cachedEntries) {
        if (cachedTPSData[e.slug] != null) {
          e.throughput_p90 = cachedTPSData[e.slug];
        }
        setModelBenchmarkTPS(e.slug, cachedTPSData[e.slug] ?? null);
      }

      const displayEntries = filterModels(cachedEntries, includeFree);
      const freeCount = cachedEntries.filter(isFreeModel).length;
      const notable = findNotable(displayEntries, cap);
      const lines: string[] = [];
      const caption = cap === 1
        ? `Models with AA data: ${displayEntries.length} · cache rate: ${(DEFAULT_CACHE_RATE * 100).toFixed(0)}%`
        : `Models with AA data: ${displayEntries.length} · cache rate: ${(DEFAULT_CACHE_RATE * 100).toFixed(0)} · blend-cost cap: <$${cap}`;
      if (!includeFree && freeCount > 0) {
        lines.push(`💡 ${freeCount} free model(s) excluded by default. Run /or-metrics --all to include them.`);
        lines.push("");
      }

      if (mode === "scoped") {
        lines.push(renderScoped(cachedScoped!));
      } else if (mode === "notable") {
        lines.push(renderNotable(notable));
      } else if (mode === "top") {
        lines.push(renderTop(displayEntries));
      } else if (mode === "tps") {
        lines.push(renderTPS(displayEntries));
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
        lines.push(renderTop(displayEntries));
        lines.push("");
        lines.push(renderTPS(displayEntries));
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
    description: "Query OpenRouter ability-per-price metrics for the scoped models or for any tracked model. Use mode='scoped' for our models, mode='top N' for top N by blended IPP, mode='tps' for top models by provider-averaged p90 throughput, mode='find <query>' to search by name, or mode='notable' for analytical highlights. Notable raw ability categories (agentic, coding) are returned as side-by-side pairs with left=uncapped top-5 and right=price-capped top-5. IPP categories (blended, cached) are returned as vertical lists. Each entry includes v (ability score or IPP) and blended_cost ($/M tokens). IPP fields: blndcod (BlndCd), blndagnt (BlndAg), cachcod (CachCd), cachagt (CachAg), blnd (BlndAv), cach (CachAv). TPS field: throughput_p90 (provider-averaged p90 tokens/sec over last 30m). Display uses slugs by default (set OR_METRICS_DISPLAY_MODEL_NAMES=1 to show human-readable names). Optional cap parameter limits the price cap for the capped variation (default: 1). Free models (slug contains ':free') are excluded by default; set all=true to include them.",
    parameters: Type.Object({
      mode: Type.String({ description: "scoped | top N | tps | find <query> | notable" }),
      cap: Type.Optional(Type.Number({ description: "Blend-cost cap in dollars for the <$N supplementary categories (default: 1)" })),
      all: Type.Optional(Type.Boolean({ description: "Include free models (slug contains ':free') that are excluded by default" })),
    }),
    async execute(
      toolCallId: string,
      params: { mode: string; cap?: number },
      _signal: AbortSignal,
      _onUpdate: unknown,
      _ctx: ToolExecuteContext,
    ): Promise<{ content: { type: string; text: string }[] }> {
      if (!cachedEntries) {
        return {
          content: [{ type: "text", text: "OR metrics not loaded yet. Run /or-metrics first." }],
        };
      }
      // Also refresh scoped slugs from tool context if available
      const sm = (_ctx as { scopedModels?: { model: { id: string; name?: string } }[] })?.scopedModels;
      if (sm && sm.length > 0 && (!activeScopedSlugs || activeScopedSlugs.length === 0)) {
        activeScopedSlugs = sm.map((x: { model: { id: string; name?: string } }) => ({
          slug: x.model.id,
          label: x.model.id, // always use slug as the default label
        }));
      }

      const mode = (params.mode || "").toLowerCase().trim();
      const includeFree = params.all === true;
      const toolEntries = filterModels(cachedEntries, includeFree);
      const result: { n_tracked: number; timestamp: string; scoped?: unknown; rankings?: unknown; matches?: unknown; tps_rankings?: unknown; notable?: unknown; error?: string; note?: string } = { n_tracked: toolEntries.length, timestamp: new Date().toISOString() };

      if (mode === "scoped" || mode.startsWith("scoped")) {
        result.scoped = cachedScoped!.map((s) => {
          const entry = s.entry;
          return {
            slug: s.slug,
            name: entry?.name || s.label,
            label: DISPLAY_MODEL_NAMES ? (entry?.name || s.label) : s.slug,
            found: s.found,
            indices: entry?.indices || null,
            ipp: entry?.ipp || null,
            throughput_p90: cachedTPSData[s.slug] ?? null,
            pricing: entry ? { blended: entry.pricing.blended, blended_cached: entry.pricing.blendedCached } : null,
          };
        });
      } else if (mode.startsWith("top")) {
        const n = parseInt(mode.replace("top", "").trim()) || 10;
        const ranked = [...toolEntries].filter((e) => e.ipp.blnd != null)
          .sort((a, b) => (b.ipp.blnd || 0) - (a.ipp.blnd || 0))
          .slice(0, Math.min(n, 50));
        result.rankings = ranked.map((e) => ({
          slug: e.slug,
          name: e.name,
          display: DISPLAY_MODEL_NAMES ? e.name : e.slug,
          indices: e.indices,
          ipp: e.ipp,
          throughput_p90: cachedTPSData[e.slug] ?? null,
          blended_cost: e.pricing.blended,
        }));
      } else if (mode.startsWith("find")) {
        const q = mode.replace("find", "").trim().toLowerCase();
        const matches = toolEntries.filter((e) => e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q));
        result.matches = matches.slice(0, 10).map((e) => ({
          slug: e.slug,
          name: e.name,
          display: DISPLAY_MODEL_NAMES ? e.name : e.slug,
          indices: e.indices,
          ipp: e.ipp,
          throughput_p90: cachedTPSData[e.slug] ?? null,
          blended_cost: e.pricing.blended,
        }));
        if (matches.length === 0) result.note = `No matches for "${q}"`;
      } else if (mode === "tps") {
        const ranked = [...toolEntries]
          .map((e) => ({ ...e, _tps: cachedTPSData[e.slug] ?? null }))
          .filter((e) => e._tps != null)
          .sort((a, b) => (b._tps || 0) - (a._tps || 0))
          .slice(0, 20);
        result.tps_rankings = ranked.map((e) => ({
          slug: e.slug,
          name: e.name,
          display: DISPLAY_MODEL_NAMES ? e.name : e.slug,
          throughput_p90: e._tps,
          blended_cost: e.pricing.blended,
          ipp: e.ipp,
        }));
      } else if (mode === "notable") {
        result.notable = findNotable(toolEntries, params.cap ?? 1);
      } else {
        result.error = `Unknown mode: ${mode}. Use: scoped, top N, tps, find <query>, notable`;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  });
}