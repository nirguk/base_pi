#!/usr/bin/env node
/**
 * OpenRouter Metrics — Ability-Per-Price Analyzer
 *
 * Uses OpenRouter's models API (Artificial Analysis indices embedded inline)
 * to compute ability-per-price for every scoped/available model.
 *
 * Indices (0–100 scale):
 *   • intelligence_index — general reasoning
 *   • coding_index       — coding ability
 *   • agentic_index      — agentic/tool-use ability
 *
 * Derived measures (higher = more ability per dollar):
 *   • BlndCd (blndcod)  = coding_index / blended_cost  (Coding, blended pricing)
 *   • BlndAg (blndagnt)  = agentic_index / blended_cost  (Agentic, blended pricing)
 *   • CachCd (cachcod)   = coding_index / cached_blended_cost  (Coding, cached pricing)
 *   • CachAg (cachagt)   = agentic_index / cached_blended_cost  (Agentic, cached pricing)
 *   • BlndAv (blnd)      = (BlndCd + BlndAg) / 2  (combined w/ blended costs)
 *   • CachAv (cach)      = (CachCd + CachAg) / 2  (combined w/ cached costs)
 *
 * Set OR_CACHE_RATE env var to override the cache-hit assumption (default 0.7).
 *
 * Daily snapshots stored at ~/.pi/or-metrics/snapshots/ for change detection.
 *
 * Usage:
 *   node .pi/or-metrics/or-metrics.js                # Full display
 *   node .pi/or-metrics/or-metrics.js --scoped       # Our scoped models only
 *   node .pi/or-metrics/or-metrics.js --notable      # Analytically interesting
 *   node .pi/or-metrics/or-metrics.js --snapshot     # Save snapshot + display
 *   node .pi/or-metrics/or-metrics.js --diff         # Diff vs prior snapshot
 *   node .pi/or-metrics/or-metrics.js --json         # Machine-readable JSON
 *   node .pi/or-metrics/or-metrics.js --help         # This help
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────

const SNAPSHOT_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '/root',
  '.pi', 'or-metrics', 'snapshots'
);

// Default cache-hit assumption (user can override via env var)
// In practice many workloads hit 70%+ cache on repetitive inputs
const DEFAULT_CACHE_RATE = parseFloat(process.env.OR_CACHE_RATE || '0.7');

// Scoped models we track specifically
const SCOPED_IDS = [
  { slug: 'inclusionai/ling-3.0-flash', label: 'Ling 3.0 Flash' },
  { slug: 'stealth/ox-alpha',           label: 'Ox Alpha' },
  { slug: 'inception/mercury-2',        label: 'Mercury 2' },
  { slug: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON error ${url.slice(0,80)}: ${e.message}`)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function columnPrecision(values, fallback) {
  fallback = fallback || 4;
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

function ippPrecision(values, fallback) {
  fallback = fallback || 2;
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
}

const fmt = {
  pct(v) { return v == null ? '—' : (v).toFixed(1) + '%'; },
  cost(v, dec) {
    if (v == null) return '—';
    if (dec != null) return '$' + v.toFixed(dec);
    const s = v.toFixed(v < 0.01 ? 5 : v < 1 ? 3 : v < 10 ? 2 : 1);
    return '$' + s.replace(/\.?0+$/, '');
  },
  ipp(v, dec) {
    if (v == null) return '  —  ';
    if (dec != null) return v.toFixed(dec).padStart(6);
    return (v > 1000 ? v.toFixed(0) : v > 100 ? v.toFixed(1) : v.toFixed(2)).padStart(6);
  },
  pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); },
  padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; },
  columnPrecision,
  ippPrecision,
};

// ─── Data Fetching ─────────────────────────────────────────────────────────────

async function fetchAllModels(apiKey) {
  // Fetch all models with AA indices in one go. Sort by intelligence to get top-tier first.
  const url = 'https://openrouter.ai/api/v1/models?limit=400';
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const result = await fetchJSON(url, headers);

  if (!result || !result.data) {
    throw new Error('Failed to fetch models from OpenRouter API');
  }

  // Filter to models with Artificial Analysis indices we can price
  const models = result.data.filter(m => {
    if (!m.benchmarks) return false;
    const aa = m.benchmarks['artificial_analysis'];
    if (!aa) return false;
    return (aa.coding_index != null || aa.agentic_index != null);
  });

  return models;
}

// ─── Model Analysis ────────────────────────────────────────────────────────────

function analyzeModels(models) {
  const entries = [];

  models.forEach(m => {
    const aa = m.benchmarks['artificial_analysis'];
    const pricing = parsePricing(m.pricing);
    if (!pricing) return;

    const blended = pricing.input * 0.8 + pricing.output * 0.2;
    // Cached blended: cache_rate × cache_read + (1−cache_rate) × base_input
    const cacheEffInput = pricing.cacheRead != null
      ? pricing.cacheRead * DEFAULT_CACHE_RATE + pricing.input * (1 - DEFAULT_CACHE_RATE)
      : pricing.input;
    const blendedCached = cacheEffInput * 0.8 + pricing.output * 0.2;

    const coding = aa.coding_index;
    const agentic = aa.agentic_index;
    const intelligence = aa.intelligence_index;

    const blndcod = coding != null && blended > 0 ? coding / blended : null;
    const blndagnt = agentic != null && blended > 0 ? agentic / blended : null;
    const cachcod = coding != null && blendedCached > 0 ? coding / blendedCached : null;
    const cachagt = agentic != null && blendedCached > 0 ? agentic / blendedCached : null;
    const blnd = (coding != null && agentic != null && blended > 0)
      ? (coding * 0.5 + agentic * 0.5) / blended : null;
    const cach = (coding != null && agentic != null && blendedCached > 0)
      ? (coding * 0.5 + agentic * 0.5) / blendedCached : null;

    entries.push({
      slug: m.id,
      name: m.name || m.id,
      pricing: {
        input: pricing.input,
        output: pricing.output,
        cacheRead: pricing.cacheRead,
        blended,
        blendedCached,
      },
      indices: {
        intelligence,
        coding,
        agentic,
      },
      ipp: {
        blndcod,
        blndagnt,
        cachcod,
        cachagt,
        blnd,
        cach,
      },
      context_length: m.context_length || null,
      created: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : null,
    });
  });

  return entries;
}

function parsePricing(p) {
  if (!p) return null;
  const input = parseFloat(p.prompt) * 1_000_000;
  const output = parseFloat(p.completion) * 1_000_000;
  const cacheRead = p.input_cache_read != null ? parseFloat(p.input_cache_read) * 1_000_000 : null;
  if (isNaN(input) || isNaN(output) || input < 0) return null;
  return { input, output, cacheRead: (cacheRead != null && !isNaN(cacheRead)) ? cacheRead : null };
}

// ─── Scoped Model Resolution ───────────────────────────────────────────────────

function findScoped(entries) {
  return SCOPED_IDS.map(s => {
    const e = entries.find(x => x.slug === s.slug);
    return { ...s, entry: e || null, found: !!e };
  });
}

// ─── Notable Detection ─────────────────────────────────────────────────────────

function findNotable(entries) {
  const notable = [];

  // --- Best absolute ability ---
  const byAgentic = [...entries].filter(e => e.indices.agentic != null)
    .sort((a, b) => (b.indices.agentic || 0) - (a.indices.agentic || 0));
  notable.push({
    category: '🏆 Best Agentic Ability (raw)',
    models: byAgentic.slice(0, 5).map(e => ({
      name: e.name, agentic: e.indices.agentic, coding: e.indices.coding,
    })),
  });

  const byCoding = [...entries].filter(e => e.indices.coding != null)
    .sort((a, b) => (b.indices.coding || 0) - (a.indices.coding || 0));
  notable.push({
    category: '💻 Best Coding Ability (raw)',
    models: byCoding.slice(0, 5).map(e => ({
      name: e.name, coding: e.indices.coding, agentic: e.indices.agentic,
    })),
  });

  // --- Best ability-per-price ---
  const byCodingIPP = [...entries].filter(e => e.ipp.blndcod != null)
    .sort((a, b) => (b.ipp.blndcod || 0) - (a.ipp.blndcod || 0));
  notable.push({
    category: '💰 Best Coding Ability-Per-Price (Blended base, BlndCd)',
    models: byCodingIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.blndcod, coding: e.indices.coding, blended: e.pricing.blended,
    })),
  });

  const byAgenticIPP = [...entries].filter(e => e.ipp.blndagnt != null)
    .sort((a, b) => (b.ipp.blndagnt || 0) - (a.ipp.blndagnt || 0));
  notable.push({
    category: '🤖 Best Agentic Ability-Per-Price (Blended base, BlndAg)',
    models: byAgenticIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.blndagnt, agentic: e.indices.agentic, blended: e.pricing.blended,
    })),
  });

  // --- Best cached IPP ---
  const byCachedCodIPP = [...entries].filter(e => e.ipp.cachcod != null)
    .sort((a, b) => (b.ipp.cachcod || 0) - (a.ipp.cachcod || 0));
  notable.push({
    category: '🔄 Best Cached Coding IPP (70% cache-hit assumed, CachCd)',
    models: byCachedCodIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.cachcod, coding: e.indices.coding, cached_blended: e.pricing.blendedCached,
    })),
  });

  const byCachedAgtIPP = [...entries].filter(e => e.ipp.cachagt != null)
    .sort((a, b) => (b.ipp.cachagt || 0) - (a.ipp.cachagt || 0));
  notable.push({
    category: '🔄 Best Cached Agentic IPP (70% cache-hit assumed, CachAg)',
    models: byCachedAgtIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.cachagt, agentic: e.indices.agentic, cached_blended: e.pricing.blendedCached,
    })),
  });

  const byBlendedIPP = [...entries].filter(e => e.ipp.blnd != null)
    .sort((a, b) => (b.ipp.blnd || 0) - (a.ipp.blnd || 0));
  notable.push({
    category: '⚖️ Best Combined Ability-Per-Price (Blended, 50/50, BlndAv)',
    models: byBlendedIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.blnd, coding: e.indices.coding, agentic: e.indices.agentic, blended: e.pricing.blended,
    })),
  });

  // --- Worst value among models with meaningful ability ---
  const meaningful = entries.filter(e =>
    (e.indices.coding != null && e.indices.coding >= 15) &&
    e.ipp.blnd != null
  );
  const worstValue = [...meaningful].sort((a, b) => (a.ipp.blnd || 999) - (b.ipp.blnd || 999));
  notable.push({
    category: '⚠️ Worst Value Among Usable Models (lowest BlndAv, ≥15 coding)',
    models: worstValue.slice(0, 3).map(e => ({
      name: e.name, ipp: e.ipp.blnd, coding: e.indices.coding, blended: e.pricing.blended,
    })),
  });

  // --- Cheapest per blended cost with ≥50 agentic ---
  const highAgentic = entries.filter(e => e.indices.agentic != null && e.indices.agentic >= 50);
  highAgentic.sort((a, b) => a.pricing.blended - b.pricing.blended);
  notable.push({
    category: '💵 Cheapest Models with Strong Agentic Ability (agentic ≥50)',
    models: highAgentic.slice(0, 5).map(e => ({
      name: e.name, agentic: e.indices.agentic, blended: e.pricing.blended, ipp: e.ipp.blndagnt,
    })),
  });

  // --- Cheapest with strong coding (≥60) ---
  const highCoding = entries.filter(e => e.indices.coding != null && e.indices.coding >= 60);
  highCoding.sort((a, b) => a.pricing.blended - b.pricing.blended);
  notable.push({
    category: '💵 Cheapest Models with Strong Coding Ability (coding ≥60)',
    models: highCoding.slice(0, 5).map(e => ({
      name: e.name, coding: e.indices.coding, blended: e.pricing.blended, ipp: e.ipp.blndcod,
    })),
  });

  return notable;
}

// ─── Snapshot ───────────────────────────────────────────────────────────────────

function snapshot(entries) {
  const ts = new Date().toISOString().slice(0, 10);
  const dir = SNAPSHOT_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    snapshot_date: ts,
    fetched_at: new Date().toISOString(),
    n_models: entries.length,
    models: entries.map(e => ({
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
    })),
  };

  fs.writeFileSync(path.join(dir, `${ts}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));
  return { file: path.join(dir, `${ts}.json`), date: ts };
}

function diffSnapshots() {
  const dir = SNAPSHOT_DIR;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'latest.json')
    .sort();
  if (files.length < 2) return null;

  const prev = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 2]), 'utf8'));
  const curr = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));

  const prevIdx = {}, currIdx = {};
  (prev.models || []).forEach(m => prevIdx[m.slug] = m);
  (curr.models || []).forEach(m => currIdx[m.slug] = m);

  const prevSlugs = new Set(Object.keys(prevIdx));
  const currSlugs = new Set(Object.keys(currIdx));

  const added = [...currSlugs].filter(s => !prevSlugs.has(s)).map(s => currIdx[s].name);
  const removed = [...prevSlugs].filter(s => !currSlugs.has(s)).map(s => prevIdx[s].name);

  const changes = [];
  [...currSlugs].filter(s => prevSlugs.has(s)).forEach(slug => {
    const p = prevIdx[slug], c = currIdx[slug];
    if (p.coding_index != null && c.coding_index != null) {
      const delta = c.coding_index - p.coding_index;
      if (Math.abs(delta) >= 0.5) changes.push({ name: c.name, metric: 'coding_index', old: p.coding_index, new: c.coding_index, delta });
    }
    if (p.agentic_index != null && c.agentic_index != null) {
      const delta = c.agentic_index - p.agentic_index;
      if (Math.abs(delta) >= 0.5) changes.push({ name: c.name, metric: 'agentic_index', old: p.agentic_index, new: c.agentic_index, delta });
    }
    if (p.blended_cost_per_m != null && c.blended_cost_per_m != null) {
      const delta = ((c.blended_cost_per_m - p.blended_cost_per_m) / p.blended_cost_per_m) * 100;
      if (Math.abs(delta) >= 5) changes.push({ name: c.name, metric: 'price_change', old: p.blended_cost_per_m, new: c.blended_cost_per_m, delta });
    }
  });

  return { added, removed, changes, prevDate: prev.snapshot_date, currDate: curr.snapshot_date };
}

// ─── Display ────────────────────────────────────────────────────────────────────

function renderScoped(scoped) {
  const lines = [];

  // Column precision
  const costVals = [];
  const ipCols = [[], [], [], []]; // blndcod, blndagnt, cachcod, cachagt
  scoped.forEach(s => {
    if (!s.entry) return;
    costVals.push(s.entry.pricing.blended);
    ipCols[0].push(s.entry.ipp.blndcod);
    ipCols[1].push(s.entry.ipp.blndagnt);
    ipCols[2].push(s.entry.ipp.cachcod);
    ipCols[3].push(s.entry.ipp.cachagt);
  });
  const costDec = columnPrecision(costVals, 4);
  const ipDecs = ipCols.map(c => ippPrecision(c, 2));

  lines.push('┌─ Our Scoped Models — OR Metrics ─────────────────────────────────────────────────────────┐');
  lines.push('│ Model              Intel  Coding Agentic  Base$/M    BlndCd  BlndAg  CachCd  CachAg│');
  lines.push('│───────────────────┄──────┄───────┄───────┄──────────┄────────┄───────┄───────┄───────│');

  scoped.forEach(s => {
    const name = fmt.pad(s.label, 18);
    if (!s.entry) {
      lines.push(`│ ${name} — no data from OpenRouter                           │`);
      return;
    }
    const e = s.entry;
    const intel = e.indices.intelligence != null ? fmt.padL(e.indices.intelligence.toFixed(1), 5) : '  —  ';
    const coding = e.indices.coding != null ? fmt.padL(e.indices.coding.toFixed(1), 5) : '  —  ';
    const agentic = e.indices.agentic != null ? fmt.padL(e.indices.agentic.toFixed(1), 5) : '  —  ';
    const blended = fmt.cost(e.pricing.blended, costDec).padStart(10);
    const bc = fmt.ipp(e.ipp.blndcod, ipDecs[0]).padStart(7);
    const ba = fmt.ipp(e.ipp.blndagnt, ipDecs[1]).padStart(7);
    const cc = fmt.ipp(e.ipp.cachcod, ipDecs[2]).padStart(7);
    const ca = fmt.ipp(e.ipp.cachagt, ipDecs[3]).padStart(7);
    lines.push(`│ ${name} ${intel}  ${coding}  ${agentic}  ${blended}  ${bc}  ${ba}  ${cc}  ${ca} │`);
  });
  lines.push('└──────────────────────────────────────────────────────────────────────────────┘');
  return lines.join('\n');
}

function renderNotable(notable) {
  const lines = [];
  lines.push('┌─ Notable Models (Analytical) ───────────────────────────────────────────────────┐');
  notable.forEach(n => {
    lines.push(`│ ${n.category.padEnd(80)} │`);
    n.models.forEach(m => {
      const name = fmt.pad(m.name || '', 22).slice(0, 22);
      const parts = [];
      if (m.ipp != null) parts.push(`IPP=${fmt.ipp(m.ipp)}`);
      if (m.agentic != null) parts.push(`Agentic=${m.agentic}`);
      if (m.coding != null) parts.push(`Coding=${m.coding}`);
      if (m.blended != null) parts.push(fmt.cost(m.blended) + '/M');
      lines.push(`│   ${name}  ${parts.join(', ')} ${' '.repeat(Math.max(0, 40 - parts.join(', ').length))} │`);
    });
    lines.push(`│${'─'.repeat(80)}│`);
  });
  lines.push('└──────────────────────────────────────────────────────────────────────────────────┘');
  return lines.join('\n');
}

function renderFull(entries, scoped, notable) {
  const lines = [];

  lines.push('');
  lines.push(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  lines.push(`║     OpenRouter Metrics — Ability-Per-Price (Artificial Analysis Indices)   ║`);
  lines.push(`║     Models with AA data: ${entries.length} · ${new Date().toISOString().slice(0,10)}         ║`);
  lines.push(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  lines.push('');
  lines.push('Measures:  BlndCd = coding_index ÷ blended_80/20 $/M  |  BlndAg = agentic_index ÷ blended');
  lines.push('           CachCd = coding_index ÷ cached_80/20 $/M    |  CachAg = agentic_index ÷ cached');
  lines.push('           BlndAv = (BlndCd + BlndAg)/2  |  CachAv = (CachCd + CachAg)/2  (combined 50/50 averages)');
  lines.push(`           Cache rate: ${(DEFAULT_CACHE_RATE * 100).toFixed(0)}% hit (set OR_CACHE_RATE env to tune)`);
  lines.push('');

  lines.push(renderScoped(scoped));
  lines.push('');
  lines.push(renderNotable(notable));
  lines.push('');

  // Full rankings — Top 20 by blended IPP
  const ranked = [...entries].filter(e => e.ipp.blnd != null)
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
  const bcDec = ippPrecision(bcVals, 2);
  const baDec = ippPrecision(baVals, 2);
  const ccDec = ippPrecision(ccVals, 2);
  const caDec = ippPrecision(caVals, 2);
  const bDec = ippPrecision(bVals, 2);
  const cDec = ippPrecision(cVals, 2);

  lines.push('┌─ Top 30 by Blended Ability-Per-Price (BlndAv = BlndCd/BlndAg 50/50) ────────────┐');
  lines.push('│Rank Model                     Intel Coding Agent  $M/M    BlndCd BlndAg CachCd CachAg BlndAv CachAv│');
  ranked.slice(0, 30).forEach((e, i) => {
    const rank = (i + 1).toString().padStart(2);
    const name = fmt.pad(e.name.length > 25 ? e.name.slice(0, 23) + '…' : e.name, 25);
    const intel = e.indices.intelligence != null ? fmt.padL(e.indices.intelligence.toFixed(0), 4) : '  — ';
    const coding = e.indices.coding != null ? fmt.padL(e.indices.coding.toFixed(0), 4) : '  — ';
    const agentic = e.indices.agentic != null ? fmt.padL(e.indices.agentic.toFixed(0), 4) : '  — ';
    const blended = fmt.cost(e.pricing.blended, costDec).padStart(6);
    const bc = fmt.ipp(e.ipp.blndcod, bcDec).padStart(6);
    const ba = fmt.ipp(e.ipp.blndagnt, baDec).padStart(6);
    const cc = fmt.ipp(e.ipp.cachcod, ccDec).padStart(6);
    const ca = fmt.ipp(e.ipp.cachagt, caDec).padStart(6);
    const ba_ = fmt.ipp(e.ipp.blnd, bDec).padStart(7);
    const ca_ = fmt.ipp(e.ipp.cach, cDec).padStart(7);
    lines.push(`│ ${rank} ${name} ${intel} ${coding} ${agentic} ${blended} ${bc} ${ba} ${cc} ${ca} ${ba_} ${ca_} │`);
  });
  lines.push('└──────────────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Also show bottom
  const bottom = ranked.slice(-10).reverse();
  lines.push('┌─ Bottom 10 by Blended IPP (lowest ability-per-price) ─────────────────────────┐');
  lines.push('│ Model                     Intel Coding Agent  $M/M    BlndCd BlndAg CachCd CachAg BlndAv CachAv│');
  bottom.forEach(e => {
    const name = fmt.pad(e.name.length > 25 ? e.name.slice(0, 23) + '…' : e.name, 25);
    const intel = e.indices.intelligence != null ? fmt.padL(e.indices.intelligence.toFixed(0), 4) : '  — ';
    const coding = e.indices.coding != null ? fmt.padL(e.indices.coding.toFixed(0), 4) : '  — ';
    const agentic = e.indices.agentic != null ? fmt.padL(e.indices.agentic.toFixed(0), 4) : '  — ';
    const blended = fmt.cost(e.pricing.blended, costDec).padStart(6);
    const bc = fmt.ipp(e.ipp.blndcod, bcDec).padStart(6);
    const ba = fmt.ipp(e.ipp.blndagnt, baDec).padStart(6);
    const cc = fmt.ipp(e.ipp.cachcod, ccDec).padStart(6);
    const ca = fmt.ipp(e.ipp.cachagt, caDec).padStart(6);
    const ba_ = fmt.ipp(e.ipp.blnd, bDec).padStart(7);
    const ca_ = fmt.ipp(e.ipp.cach, cDec).padStart(7);
    lines.push(`│ ${name} ${intel} ${coding} ${agentic} ${blended} ${bc} ${ba} ${cc} ${ca} ${ba_} ${ca_} │`);
  });
  lines.push('└──────────────────────────────────────────────────────────────────────────────┘');

  return lines.join('\n');
}

function renderDiff(diff) {
  if (!diff) return 'No prior snapshot for comparison.';
  const lines = [];
  lines.push('┌─ OR-Metrics Snapshot Diff ───────────────────────────────────────────────────┐');
  lines.push(`│ Previous: ${diff.prevDate}  |  Current: ${diff.currDate}`);
  if (diff.added.length) {
    lines.push(`│ 🆕 New models tracked: ${diff.added.join(', ')}`);
  }
  if (diff.removed.length) {
    lines.push(`│ 🗑️ Removed: ${diff.removed.join(', ')}`);
  }
  if (diff.changes.length) {
    lines.push('│ 📊 Changes:');
    diff.changes.slice(0, 10).forEach(c => {
      const arrow = c.delta > 0 ? '↑' : '↓';
      if (c.metric === 'price_change') {
        lines.push(`│   ${c.name.padEnd(25)} price ${arrow}${Math.abs(c.delta).toFixed(1)}% (${fmt.cost(c.old)} → ${fmt.cost(c.new)})`);
      } else {
        lines.push(`│   ${c.name.padEnd(25)} ${c.metric} ${arrow}${Math.abs(c.delta).toFixed(1)}pt (${c.old} → ${c.new})`);
      }
    });
  }
  if (!diff.added.length && !diff.removed.length && !diff.changes.length) {
    lines.push('│ No changes detected. ✓');
  }
  lines.push('└──────────────────────────────────────────────────────────────────────────────┘');
  return lines.join('\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    const help = fs.readFileSync(__filename, 'utf8').split('Usage:\n')[1].split('\nconst https')[0];
    console.log('Usage:\n' + help);
    return;
  }

  const doScoped = args.includes('--scoped');
  const doNotable = args.includes('--notable');
  const doSnapshot = args.includes('--snapshot');
  const doDiff = args.includes('--diff');
  const doJSON = args.includes('--json');

  const apiKey = process.env.OPENROUTER_API_KEY || '';

  // Fetch
  let models;
  try {
    models = await fetchAllModels(apiKey);
  } catch (e) {
    console.error('Error fetching OpenRouter models:', e.message);
    process.exit(1);
  }

  // Analyze
  const entries = analyzeModels(models);
  const scoped = findScoped(entries);
  const notable = findNotable(entries);

  // Snapshot
  if (doSnapshot) {
    const snap = snapshot(entries);
    console.error(`Snapshot saved: ${snap.file} (${entries.length} models)`);
  }

  // Diff
  let diff = null;
  try {
    if (doDiff || !doScoped) diff = diffSnapshots();
  } catch (e) {
    // No prior snapshot is fine
  }

  // Output
  if (doJSON) {
    console.log(JSON.stringify({
      fetched_at: new Date().toISOString(),
      n_models: entries.length,
      scoped_models: scoped.map(s => ({
        label: s.label,
        slug: s.id,
        found: s.found,
        indices: s.entry?.indices || null,
        pricing: s.entry?.pricing || null,
        ipp: s.entry?.ipp || null,
      })),
      notable: notable.map(n => ({
        category: n.category,
        models: n.models,
      })),
      top_by_blended_ipp: entries.filter(e => e.ipp.blnd != null)
        .sort((a, b) => (b.ipp.blnd || 0) - (a.ipp.blnd || 0))
        .slice(0, 20)
        .map(e => ({
          name: e.name,
          slug: e.slug,
          coding: e.indices.coding,
          agentic: e.indices.agentic,
          blended_cost: e.pricing.blended,
          blended_cached_cost: e.pricing.blendedCached,
          blndcod: e.ipp.blndcod,
          blndagnt: e.ipp.blndagnt,
          cachcod: e.ipp.cachcod,
          cachagt: e.ipp.cachagt,
          blnd: e.ipp.blnd,
          cach: e.ipp.cach,
        })),
      diff: diff ? {
        added: diff.added,
        removed: diff.removed,
        changes: diff.changes,
      } : null,
    }, null, 2));
    return;
  }

  // Text
  if (doScoped) {
    console.log(renderScoped(scoped));
  } else if (doNotable) {
    console.log(renderNotable(notable));
  } else {
    console.log(renderFull(entries, scoped, notable));
  }

  if (diff) {
    console.log('\n' + renderDiff(diff));
  }
}

main().catch(e => { console.error(e); process.exit(1); });