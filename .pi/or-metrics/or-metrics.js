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
 *   • coding-IPP  = coding_index / blended_cost
 *   • agentic-IPP = agentic_index / blended_cost
 *   • blended-IPP = (coding×0.5 + agentic×0.5) / blended_cost
 *   • cached-IPP  = blended-IPP using cached blended cost (70% cache-hit default)
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

const fmt = {
  pct(v) { return v == null ? '—' : (v).toFixed(1) + '%'; },
  cost(v) {
    if (v == null) return '—';
    const s = v.toFixed(v < 0.01 ? 5 : v < 1 ? 3 : v < 10 ? 2 : 1);
    return '$' + s.replace(/\.?0+$/, '');
  },
  ipp(v) {
    if (v == null) return '  —  ';
    return (v > 1000 ? v.toFixed(0) : v > 100 ? v.toFixed(1) : v.toFixed(2)).padStart(6);
  },
  pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); },
  padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; },
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

    const codingIPP = coding != null && blended > 0 ? coding / blended : null;
    const agenticIPP = agentic != null && blended > 0 ? agentic / blended : null;
    const blendedIPP = (coding != null && agentic != null && blended > 0)
      ? (coding * 0.5 + agentic * 0.5) / blended : null;
    const blendedIPPcached = (coding != null && agentic != null && blendedCached > 0)
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
        coding: codingIPP,
        agentic: agenticIPP,
        blended: blendedIPP,
        cached: blendedIPPcached,
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
  const byCodingIPP = [...entries].filter(e => e.ipp.coding != null)
    .sort((a, b) => (b.ipp.coding || 0) - (a.ipp.coding || 0));
  notable.push({
    category: '💰 Best Coding Ability-Per-Price (Coding IPP)',
    models: byCodingIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.coding, coding: e.indices.coding, blended: e.pricing.blended,
    })),
  });

  const byAgenticIPP = [...entries].filter(e => e.ipp.agentic != null)
    .sort((a, b) => (b.ipp.agentic || 0) - (a.ipp.agentic || 0));
  notable.push({
    category: '🤖 Best Agentic Ability-Per-Price (Agentic IPP)',
    models: byAgenticIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.agentic, agentic: e.indices.agentic, blended: e.pricing.blended,
    })),
  });

  // --- Best cached IPP ---
  const byCachedIPP = [...entries].filter(e => e.ipp.cached != null)
    .sort((a, b) => (b.ipp.cached || 0) - (a.ipp.cached || 0));
  notable.push({
    category: '🔄 Best Cached IPP (70% cache-hit assumed) — export OR_CACHE_RATE to tune',
    models: byCachedIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.cached, coding: e.indices.coding, agentic: e.indices.agentic,
      cached_blended: e.pricing.blendedCached,
    })),
  });

  const byBlendedIPP = [...entries].filter(e => e.ipp.blended != null)
    .sort((a, b) => (b.ipp.blended || 0) - (a.ipp.blended || 0));
  notable.push({
    category: '⚖️ Best Combined Ability-Per-Price (Blended IPP, 50/50)',
    models: byBlendedIPP.slice(0, 5).map(e => ({
      name: e.name, ipp: e.ipp.blended, coding: e.indices.coding, agentic: e.indices.agentic, blended: e.pricing.blended,
    })),
  });

  // --- Worst value among models with meaningful ability ---
  const meaningful = entries.filter(e =>
    (e.indices.coding != null && e.indices.coding >= 15) &&
    e.ipp.blended != null
  );
  const worstValue = [...meaningful].sort((a, b) => (a.ipp.blended || 999) - (b.ipp.blended || 999));
  notable.push({
    category: '⚠️ Worst Value Among Usable Models (lowest Blended IPP, ≥15 coding)',
    models: worstValue.slice(0, 3).map(e => ({
      name: e.name, ipp: e.ipp.blended, coding: e.indices.coding, blended: e.pricing.blended,
    })),
  });

  // --- Cheapest per blended cost with ≥50 agentic ---
  const highAgentic = entries.filter(e => e.indices.agentic != null && e.indices.agentic >= 50);
  highAgentic.sort((a, b) => a.pricing.blended - b.pricing.blended);
  notable.push({
    category: '💵 Cheapest Models with Strong Agentic Ability (agentic ≥50)',
    models: highAgentic.slice(0, 5).map(e => ({
      name: e.name, agentic: e.indices.agentic, blended: e.pricing.blended, ipp: e.ipp.agentic,
    })),
  });

  // --- Cheapest with strong coding (≥60) ---
  const highCoding = entries.filter(e => e.indices.coding != null && e.indices.coding >= 60);
  highCoding.sort((a, b) => a.pricing.blended - b.pricing.blended);
  notable.push({
    category: '💵 Cheapest Models with Strong Coding Ability (coding ≥60)',
    models: highCoding.slice(0, 5).map(e => ({
      name: e.name, coding: e.indices.coding, blended: e.pricing.blended, ipp: e.ipp.coding,
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
      coding_ipp: e.ipp.coding,
      agentic_ipp: e.ipp.agentic,
      blended_ipp: e.ipp.blended,
      cached_ipp: e.ipp.cached,
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
  lines.push('┌─ Our Scoped Models — OR Metrics ────────────────────────────────────────────────────┐');
  lines.push('│ Model              Intel  Coding Agentic  Base$/M  CodIPP  AgtIPP  BlnIPP  CchIPP│');
  lines.push('│───────────────────┄──────┄───────┄───────┄────────┄──────┄───────┄───────┄───────│');

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
    const blended = fmt.cost(e.pricing.blended).padStart(8);
    const cIPP = fmt.ipp(e.ipp.coding).padStart(6);
    const aIPP = fmt.ipp(e.ipp.agentic).padStart(7);
    const bIPP = fmt.ipp(e.ipp.blended).padStart(7);
    const cachedIPP = fmt.ipp(e.ipp.cached).padStart(7);
    lines.push(`│ ${name} ${intel}  ${coding}  ${agentic}  ${blended}  ${cIPP}  ${aIPP}  ${bIPP}  ${cachedIPP} │`);
  });
  lines.push('└────────────────────────────────────────────────────────────────────────────┘');
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
  lines.push('Measures:  Coding-IPP = coding_index ÷ blended_80/20 $/M  |  Agentic-IPP = agentic_index ÷ blended');
  lines.push('           Blended-IPP = (coding×0.5 + agentic×0.5) ÷ blended  |  Cached-IPP = blended-IPP using cached pricing');
  lines.push(`           Cache rate: ${(DEFAULT_CACHE_RATE * 100).toFixed(0)}% hit (set OR_CACHE_RATE env to tune)`);
  lines.push('');

  lines.push(renderScoped(scoped));
  lines.push('');
  lines.push(renderNotable(notable));
  lines.push('');

  // Full rankings — Top 20 by blended IPP
  const ranked = [...entries].filter(e => e.ipp.blended != null)
    .sort((a, b) => (b.ipp.blended || 0) - (a.ipp.blended || 0));

  lines.push('┌─ Top 30 by Blended Ability-Per-Price (Coding/Agentic 50/50) ─────────────────┐');
  lines.push('│Rank Model                     Intel Coding Agent  $/M    CodIPP AgtIPP BlnIPP CchIPP│');
  ranked.slice(0, 30).forEach((e, i) => {
    const rank = (i + 1).toString().padStart(2);
    const name = fmt.pad(e.name.length > 25 ? e.name.slice(0, 23) + '…' : e.name, 25);
    const intel = e.indices.intelligence != null ? fmt.padL(e.indices.intelligence.toFixed(0), 4) : '  — ';
    const coding = e.indices.coding != null ? fmt.padL(e.indices.coding.toFixed(0), 4) : '  — ';
    const agentic = e.indices.agentic != null ? fmt.padL(e.indices.agentic.toFixed(0), 4) : '  — ';
    const blended = fmt.cost(e.pricing.blended).padStart(6);
    const cIPP = fmt.ipp(e.ipp.coding).padStart(6);
    const aIPP = fmt.ipp(e.ipp.agentic).padStart(6);
    const bIPP = fmt.ipp(e.ipp.blended).padStart(6);
    const cchIPP = fmt.ipp(e.ipp.cached).padStart(6);
    lines.push(`│ ${rank} ${name} ${intel} ${coding} ${agentic} ${blended} ${cIPP} ${aIPP} ${bIPP} ${cchIPP} │`);
  });
  lines.push('└──────────────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // Also show bottom
  const bottom = ranked.slice(-10).reverse();
  lines.push('┌─ Bottom 10 by Blended IPP (lowest ability-per-price) ─────────────────────────┐');
  lines.push('│ Model                     Intel Coding Agent  $/M    CodIPP AgtIPP BlnIPP CchIPP│');
  bottom.forEach(e => {
    const name = fmt.pad(e.name.length > 25 ? e.name.slice(0, 23) + '…' : e.name, 25);
    const intel = e.indices.intelligence != null ? fmt.padL(e.indices.intelligence.toFixed(0), 4) : '  — ';
    const coding = e.indices.coding != null ? fmt.padL(e.indices.coding.toFixed(0), 4) : '  — ';
    const agentic = e.indices.agentic != null ? fmt.padL(e.indices.agentic.toFixed(0), 4) : '  — ';
    const blended = fmt.cost(e.pricing.blended).padStart(6);
    const cIPP = fmt.ipp(e.ipp.coding).padStart(6);
    const aIPP = fmt.ipp(e.ipp.agentic).padStart(6);
    const bIPP = fmt.ipp(e.ipp.blended).padStart(6);
    const cchIPP = fmt.ipp(e.ipp.cached).padStart(6);
    lines.push(`│ ${name} ${intel} ${coding} ${agentic} ${blended} ${cIPP} ${aIPP} ${bIPP} ${cchIPP} │`);
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
      top_by_blended_ipp: entries.filter(e => e.ipp.blended != null)
        .sort((a, b) => (b.ipp.blended || 0) - (a.ipp.blended || 0))
        .slice(0, 20)
        .map(e => ({
          name: e.name,
          slug: e.slug,
          coding: e.indices.coding,
          agentic: e.indices.agentic,
          blended_cost: e.pricing.blended,
          blended_cached_cost: e.pricing.blendedCached,
          coding_ipp: e.ipp.coding,
          agentic_ipp: e.ipp.agentic,
          blended_ipp: e.ipp.blended,
          cached_ipp: e.ipp.cached,
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