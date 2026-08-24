/**
 * OpenRouter Metrics Extension
 *
 * Fetches Artificial Analysis indices (coding, agentic, intelligence) from
 * the OpenRouter models API on session start, computes ability-per-price
 * (IPP) metrics, snapshots for change detection, and exposes a /or-metrics
 * command plus a or_metrics tool for the LLM.
 *
 * Snapshots: keeps exactly 2 files in ~/.pi/or-metrics/snapshots/
 *   - latest.json   (current fetch)
 *   - previous.json (prior fetch, overwritten each time)
 *
 * Usage:
 *   /or-metrics           — full display (scoped models, notable, rankings)
 *   /or-metrics scoped    — just our 4 scoped models
 *   /or-metrics notable   — analytically interesting models
 *   /or-metrics top       — top 20 by blended IPP
 *   /or-metrics changes   — diff since last snapshot
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Config ────────────────────────────────────────────────────────────────────

const OR_API_BASE = "https://openrouter.ai/api/v1";
const SNAPSHOT_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/root",
  ".pi", "or-metrics", "snapshots"
);
const DEFAULT_CACHE_RATE = parseFloat(process.env.OR_CACHE_RATE || "0.7");

const SCOPED_SLUGS = [
  { slug: "inclusionai/ling-3.0-flash", label: "Ling 3.0 Flash" },
  { slug: "stealth/ox-alpha",            label: "Ox Alpha" },
  { slug: "inception/mercury-2",         label: "Mercury 2" },
  { slug: "deepseek/deepseek-v4-flash",  label: "DeepSeek V4 Flash" },
];

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

function analyzeModels(models: any[]) {
  const entries: any[] = [];

  for (const m of models) {
    const aa = m.benchmarks?.artificial_analysis;
    if (!aa) continue;

    const pricing = parsePricing(m.pricing);
    if (!pricing) continue;

    const blended = pricing.input * 0.8 + pricing.output * 0.2;
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
    const cachedIPP = (coding != null && agentic != null && blendedCached > 0)
      ? (coding * 0.5 + agentic * 0.5) / blendedCached : null;

    entries.push({
      slug: m.id,
      name: m.name || m.id,
      pricing: { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead, blended, blendedCached },
      indices: { intelligence, coding, agentic },
      ipp: { coding: codingIPP, agentic: agenticIPP, blended: blendedIPP, cached: cachedIPP },
    });
  }
  return entries;
}

function findScoped(entries: any[]) {
  return SCOPED_SLUGS.map((s) => {
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
  return analyzeModels(result.data);
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
      coding_ipp: e.ipp.coding,
      agentic_ipp: e.ipp.agentic,
      blended_ipp: e.ipp.blended,
      cached_ipp: e.ipp.cached,
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

  const byBlendedIPP = [...entries].filter((e) => e.ipp.blended != null)
    .sort((a, b) => (b.ipp.blended || 0) - (a.ipp.blended || 0));
  notable.push({ category: "💰 Best Blended IPP (ability-per-price)", models: byBlendedIPP.slice(0, 5).map((e) => ({ name: e.name, v: e.ipp.blended })) });

  const byCachedIPP = [...entries].filter((e) => e.ipp.cached != null)
    .sort((a, b) => (b.ipp.cached || 0) - (a.ipp.cached || 0));
  notable.push({ category: "🔄 Best Cached IPP (70% cache assumed)", models: byCachedIPP.slice(0, 5).map((e) => ({ name: e.name, v: e.ipp.cached })) });

  return notable;
}

// ─── Display Helpers ────────────────────────────────────────────────────────────

const FMT = {
  pct(v: number | null) { return v == null ? "—" : v.toFixed(1) + "%"; },
  cost(v: number | null) {
    if (v == null) return "—";
    const s = v.toFixed(v < 0.01 ? 5 : v < 1 ? 3 : v < 10 ? 2 : 1);
    return "$" + s.replace(/\.?0+$/, "");
  },
  ipp(v: number | null) {
    if (v == null) return "    —";
    return (v > 1000 ? v.toFixed(0) : v > 100 ? v.toFixed(1) : v.toFixed(2)).padStart(6);
  },
  pad(s: string, n: number) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); },
};

function renderScoped(scoped: any[]) {
  const lines: string[] = [];
  lines.push("┌─ Our Scoped Models ─────────────────────────────────────────────────────────────────────┐");
  lines.push("│ Model              Intel  Coding Agentic  Base$/M  CodIPP  AgtIPP  BlnIPP  CchIPP│");
  lines.push("│───────────────────┄──────┄───────┄───────┄────────┄───────┄───────┄───────┄───────│");
  for (const s of scoped) {
    const name = FMT.pad(s.label, 18);
    if (!s.entry) {
      lines.push(`│ ${name}  no data from OpenRouter                                          │`);
      continue;
    }
    const e = s.entry;
    const intel = e.indices.intelligence != null ? e.indices.intelligence.toFixed(1).padStart(5) : "  —  ";
    const coding = e.indices.coding != null ? e.indices.coding.toFixed(1).padStart(5) : "  —  ";
    const agentic = e.indices.agentic != null ? e.indices.agentic.toFixed(1).padStart(5) : "  —  ";
    const blended = FMT.cost(e.pricing.blended).padStart(8);
    const cIPP = FMT.ipp(e.ipp.coding).padStart(6);
    const aIPP = FMT.ipp(e.ipp.agentic).padStart(6);
    const bIPP = FMT.ipp(e.ipp.blended).padStart(6);
    const cachedIPP = FMT.ipp(e.ipp.cached).padStart(6);
    lines.push(`│ ${name} ${intel}  ${coding}  ${agentic}  ${blended}  ${cIPP}  ${aIPP}  ${bIPP}  ${cachedIPP} │`);
  }
  lines.push("└──────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

function renderNotable(notable: any[]) {
  const lines: string[] = [];
  lines.push("┌─ Notable ──────────────────────────────────────────────────────────────────────────────┐");
  for (const n of notable) {
    lines.push(`│ ${FMT.pad(n.category, 78)} │`);
    for (const m of n.models) {
      const name = FMT.pad(m.name || "", 22).slice(0, 22);
      const v = typeof m.v === "number" ? (m.v > 100 ? m.v.toFixed(1) : m.v.toFixed(2).padStart(6)) : String(m.v ?? "—");
      lines.push(`│   ${name}  ${v}${" ".repeat(Math.max(0, 46 - String(v).length))} │`);
    }
    lines.push(`│${"─".repeat(80)}│`);
  }
  lines.push("└──────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

function renderTop(entries: any[]) {
  const ranked = [...entries].filter((e) => e.ipp.blended != null)
    .sort((a, b) => (b.ipp.blended || 0) - (a.ipp.blended || 0));

  const lines: string[] = [];
  lines.push("┌─ Top 20 by Blended IPP ──────────────────────────────────────────────────────────────┐");
  lines.push("│Rank Model                     Intel Coding Agent  $/M    CodIPP AgtIPP BlnIPP CchIPP│");
  ranked.slice(0, 20).forEach((e, i) => {
    const rank = (i + 1).toString().padStart(2);
    const name = FMT.pad(e.name.length > 25 ? e.name.slice(0, 23) + "…" : e.name, 25);
    const intel = e.indices.intelligence != null ? e.indices.intelligence.toFixed(0).padStart(4) : "  — ";
    const coding = e.indices.coding != null ? e.indices.coding.toFixed(0).padStart(4) : "  — ";
    const agentic = e.indices.agentic != null ? e.indices.agentic.toFixed(0).padStart(4) : "  — ";
    const blended = FMT.cost(e.pricing.blended).padStart(6);
    const cIPP = FMT.ipp(e.ipp.coding).padStart(6);
    const aIPP = FMT.ipp(e.ipp.agentic).padStart(6);
    const bIPP = FMT.ipp(e.ipp.blended).padStart(6);
    const cachedIPP = FMT.ipp(e.ipp.cached).padStart(6);
    lines.push(`│ ${rank} ${name} ${intel} ${coding} ${agentic} ${blended} ${cIPP} ${aIPP} ${bIPP} ${cachedIPP} │`);
  });
  lines.push("└──────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

function renderChanges(data: any) {
  if (!data.priorDate) {
    return "No prior snapshot yet. Run /or-metrics a second time later to see changes.";
  }
  const lines: string[] = [];
  lines.push(`┌─ Changes since ${data.priorDate} ────────────────────────────────────────────────────────┐`);

  if (!data.added.length && !data.removed.length && !data.changes.length) {
    lines.push(`│ ✓ No changes. (${data.currentDate})`);
    lines.push("└──────────────────────────────────────────────────────────────────────────────────────┘");
    return lines.join("\n");
  }

  if (data.added.length > 0) {
    lines.push(`│ 🆕  New models (${data.added.length}):`);
    const names = data.added.slice(0, 12);
    for (let i = 0; i < names.length; i += 3) {
      const row = names.slice(i, i + 3).map((n: string) => n.padEnd(25).slice(0, 25)).join("");
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
      lines.push(`│    ${FMT.pad(c.name, 25)} ${val}`);
    }
    if (data.changes.length > 12) lines.push(`│    … and ${data.changes.length - 12} more`);
  }
  lines.push("└──────────────────────────────────────────────────────────────────────────────────────┘");
  return lines.join("\n");
}

// ─── Extension Entry Point ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ──
  let cachedEntries: any[] | null = null;
  let cachedScoped: any[] | null = null;
  let cachedChanges: any | null = null;

  // Shared fetch-and-analyze (interactive only)
  async function refresh(ctx: any) {
    if (!ctx.hasUI) return null;
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      ctx.ui.notify("No OPENROUTER_API_KEY set. OR metrics unavailable.", "warning");
      return null;
    }

    ctx.ui.setStatus("or-metrics", "Fetching OR metrics…");
    try {
      const entries = await fetchORData(apiKey);
      const scoped = findScoped(entries);
      const data = snapshotAndDiff(entries);
      cachedEntries = entries;
      cachedScoped = scoped;
      cachedChanges = data;
      ctx.ui.setStatus("or-metrics", `${entries.length} models tracked`);

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
      ctx.ui.setStatus("or-metrics", "fetch failed");
      ctx.ui.notify(`OR metrics fetch failed: ${e.message}`, "error");
      return null;
    }
  }

  // ── Auto-fetch on interactive session start ──
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return; // headless/print/json — skip
    refresh(ctx);
  });

  // ── Command: /or-metrics ──
  pi.registerCommand("or-metrics", {
    description: "Show OpenRouter ability-per-price metrics. Args: scoped | notable | top | changes",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["scoped", "notable", "top", "changes"];
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
        await refresh(ctx);
      }
      if (!cachedEntries) return; // refresh already notified

      const mode = args.trim().toLowerCase();
      const notable = findNotable(cachedEntries);
      const lines: string[] = [];
      const caption = `Models with AA data: ${cachedEntries.length} · cache rate: ${(DEFAULT_CACHE_RATE * 100).toFixed(0)}%`;

      if (mode === "scoped") {
        lines.push(renderScoped(cachedScoped!));
      } else if (mode === "notable") {
        lines.push(renderNotable(notable));
      } else if (mode === "top") {
        lines.push(renderTop(cachedEntries));
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
    description: "Query OpenRouter ability-per-price metrics for the scoped models or for any tracked model. Use mode='scoped' for our models, mode='top N' for top N by blended IPP, mode='find <query>' to search by name, or mode='notable' for analytical highlights.",
    parameters: Type.Object({
      mode: Type.String({ description: "scoped | top N | find <query> | notable" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!cachedEntries) {
        return {
          content: [{ type: "text", text: "OR metrics not loaded yet. Run /or-metrics first." }],
        };
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
          pricing: s.entry ? { blended: s.entry.pricing.blended, blended_cached: s.entry.pricing.blendedCached } : null,
        }));
      } else if (mode.startsWith("top")) {
        const n = parseInt(mode.replace("top", "").trim()) || 10;
        const ranked = [...cachedEntries].filter((e) => e.ipp.blended != null)
          .sort((a, b) => (b.ipp.blended || 0) - (a.ipp.blended || 0))
          .slice(0, Math.min(n, 50));
        result.rankings = ranked.map((e) => ({
          name: e.name,
          slug: e.slug,
          indices: e.indices,
          ipp: e.ipp,
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
          blended_cost: e.pricing.blended,
        }));
        if (matches.length === 0) result.note = `No matches for "${q}"`;
      } else if (mode === "notable") {
        result.notable = findNotable(cachedEntries);
      } else {
        result.error = `Unknown mode: ${mode}. Use: scoped, top N, find <query>, notable`;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  });
}