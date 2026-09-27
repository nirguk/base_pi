/**
 * forge-models — image-model tracker for image_forge, v1.
 *
 * Mirrors the shape of or-live (coding metrics) without copying its contents:
 * - pulls the OpenRouter image-models catalog (`GET /api/v1/images/models`)
 * - keeps two snapshots (latest / previous) for change detection
 * - holds a pins file mapping each job to a model id + why + date
 * - renders a purpose-fit table (capability vs price), not ability-per-price
 *
 * Pricing is NOT unified upstream: endpoints bill per image, per token, per
 * megapixel, or per request. This extension records the native unit and also
 * computes one normalised number — effective USD for a reference 1K square —
 * so per-picture and per-token models sit in the same table.
 *
 * Storage:
 * - snapshots: ~/.pi/forge-models/snapshots/{latest,previous}.json
 * - pins: /workspaces/image_forge/models.pinned.json (shared tree, editable)
 *
 * USE: /forge-models [pins|list|changes|refresh]
 *
 * @version 0.1.0
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODELS_URL = "https://openrouter.ai/api/v1/images/models";
const SNAP_DIR = path.join(os.homedir(), ".pi", "forge-models", "snapshots");
const LATEST_PATH = path.join(SNAP_DIR, "latest.json");
const PREV_PATH = path.join(SNAP_DIR, "previous.json");
const PINS_PATH = "/workspaces/image_forge/models.pinned.json";

// Reference picture for normalisation: 1K 1:1 ≈ 1 megapixel.
const REF_MP = 1.0;
// Assumed output tokens for a 1K square when an endpoint bills per token.
// Gemini-class models emit ~1290 tokens per 1K image; keep explicit + adjustable.
const TOKENS_PER_REF_IMAGE = 1290;
const PRICING_CACHE_PATH = path.join(os.homedir(), ".pi", "forge-models", "pricing-cache.json");
const PRICING_TTL_MS = 24 * 3600 * 1000;
const COST_TIERS = [0.25, 1, 4];

type PinEntry = {
  model: string;
  why: string;
  pinned: string;
};

type SnapshotModel = {
  slug: string;
  name: string;
  input_modalities: string[];
  output_modalities: string[];
  resolutions: string[];
  aspects: string[];
  max_refs: number | null;
  max_n: number | null;
  pricing_note: string;
  endpoints_url: string;
};

type SnapshotPayload = {
  fetched_at: string;
  count: number;
  models: SnapshotModel[];
};

const DEFAULT_PINS: Record<string, PinEntry> = {
  "fast-draft": {
    model: "google/gemini-3.1-flash-lite-image",
    why: "Cheapest fast tries, ~4s a picture, 1K across 14 aspects.",
    pinned: "2026-09-27",
  },
  "photo-background": {
    model: "bytedance-seed/seedream-5-0-pro",
    why: "Lifelike scenes, $0.045/1K picture, precise edit control.",
    pinned: "2026-09-27",
  },
  "clean-text": {
    model: "google/gemini-3-pro-image",
    why: "Best text rendering in pictures, 2K/4K, keeps identity across takes.",
    pinned: "2026-09-27",
  },
  "edit-roundtrip": {
    model: "google/gemini-3.1-flash-image",
    why: "Pass prior winner back with new instruction, up to 14 references.",
    pinned: "2026-09-27",
  },
  "vector-logo": {
    model: "recraft/recraft-v4.1-vector",
    why: "Vector/SVG output for crisp logo and pixel-text masters.",
    pinned: "2026-09-27",
  },
};

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function loadJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function loadPins(): Record<string, PinEntry> {
  const existing = loadJson<Record<string, PinEntry>>(PINS_PATH);
  if (existing && Object.keys(existing).length > 0) return existing;
  try {
    ensureDir(path.dirname(PINS_PATH));
    fs.writeFileSync(PINS_PATH, JSON.stringify(DEFAULT_PINS, null, 2));
  } catch {
    // Shared tree may be unavailable; fall back to defaults in memory.
  }
  return { ...DEFAULT_PINS };
}

async function fetchCatalog(): Promise<SnapshotPayload> {
  const res = await fetch(MODELS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`images/models HTTP ${res.status}`);
  const data = (await res.json()) as any;
  const list: any[] = data?.data ?? [];
  const models: SnapshotModel[] = list.map((m: any) => {
    const sp = m?.supported_parameters ?? {};
    const refs = sp?.input_references;
    const n = sp?.n;
    return {
      slug: m.id,
      name: m.name ?? m.id,
      input_modalities: m?.architecture?.input_modalities ?? [],
      output_modalities: m?.architecture?.output_modalities ?? [],
      resolutions: sp?.resolution?.values ?? [],
      aspects: sp?.aspect_ratio?.values ?? [],
      max_refs: typeof refs?.max === "number" ? refs.max : null,
      max_n: typeof n?.max === "number" ? n.max : null,
      pricing_note: "see endpoint record",
      endpoints_url: `/api/v1/images/models/${m.id}/endpoints`,
    };
  });
  return { fetched_at: new Date().toISOString(), count: models.length, models };
}

function saveSnapshot(payload: SnapshotPayload): void {
  ensureDir(SNAP_DIR);
  const prev = loadJson<SnapshotPayload>(LATEST_PATH);
  if (prev) fs.writeFileSync(PREV_PATH, JSON.stringify(prev, null, 2));
  fs.writeFileSync(LATEST_PATH, JSON.stringify(payload, null, 2));
}

const YELLOW = "\x1b[33m";
const GREY = "\x1b[90m";
const DIMSEP = "\x1b[2m\x1b[90m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[39m";

function shortSlug(slug: string): string {
  const i = slug.indexOf("/");
  return i >= 0 ? slug.slice(i + 1) : slug;
}

// Minimal aligned box table (no deps): yellow headers, grey borders,
// left-aligned text columns, right-aligned numeric-ish ones.
// Cells may hold "\n" for wrapped lines; each visual row pads to the
// tallest cell in its logical row.
function boxTable(headers: string[], rows: string[][], aligns?: ("left" | "right")[]): string {
  const n = headers.length;
  const split = rows.map((r) => r.map((c) => (c ?? "").split("\n")));
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...split.flatMap((r) => r[c].map((l) => l.length))),
  );
  const pad = (s: string, w: number, a: "left" | "right") =>
    a === "right" ? s.padStart(w) : s.padEnd(w);
  const bar = (l: string, m: string, r: string) =>
    GREY + l + widths.map((w) => "─".repeat(w + 2)).join(m) + r + RESET;
  const head = GREY + "│" + RESET +
    headers.map((h, c) => ` ${YELLOW}${pad(h, widths[c], "left")}${RESET} `).join(GREY + "│" + RESET) +
    GREY + "│" + RESET;
  const body: string[] = [];
  // Soft low-contrast rule between entries (not between wrapped lines of
  // one entry): dim dotted line so the eye tracks across in dark mode.
  const rowSep =
    DIMSEP + "├" + widths.map((w) => "╌".repeat(w + 2)).join("┼") + "┤" + "\x1b[22m" + RESET;
  split.forEach((row, ri) => {
    if (ri > 0) body.push(rowSep);
    const height = Math.max(...row.map((c) => c.length));
    for (let ln = 0; ln < height; ln++) {
      body.push(
        GREY + "│" + RESET +
        row.map((cell, c) => ` ${pad(cell[ln] ?? "", widths[c], aligns?.[c] ?? "left")} `).join(GREY + "│" + RESET) +
        GREY + "│" + RESET,
      );
    }
  });
  return [bar("┌", "┬", "┐"), head, bar("├", "┼", "┤"), ...body, bar("└", "┴", "┘")].join("\n");
}

// Wrap text to width, at most maxLines visual lines; overflow ends with "…".
function wrap(text: string, width: number, maxLines: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length <= width) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1 && cur.length > width) {
        cur = cur.slice(0, width - 1) + "…";
      }
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  // If words remain unpacked, mark the cut.
  const used = lines.join(" ").length;
  if (used < text.length && !lines[lines.length - 1].endsWith("…")) {
    lines[lines.length - 1] += "…";
  }
  return lines.join("\n");
}

type PriceLine = { billable: string; unit: string; cost_usd: number; variant?: string };
type TierCosts = { q: string; one: string; four: string; note: string };

function fmtUsd(v: number): string {
  if (v >= 1) return "$" + v.toFixed(2);
  if (v >= 0.01) return "$" + v.toFixed(3);
  return "$" + v.toFixed(4);
}

function loadPricingCache(): Record<string, { at: string; costs: TierCosts }> {
  return loadJson<Record<string, { at: string; costs: TierCosts }>>(PRICING_CACHE_PATH) ?? {};
}

// Value of one output picture at mp megapixels from native price lines.
// Flat (image/request) repeats across sizes; per-MP and per-token scale.
// A high-resolution variant line, where one exists, prices the 4MP tier.
function tierValue(lines: PriceLine[], mp: number): number | null {
  const outs = lines.filter((l) => /output/i.test(l.billable || ""));
  if (!outs.length) return null;
  const base = outs.find((l) => !l.variant) ?? outs[0];
  const hi = outs.find((l) => /high|2k|4k|max/i.test(l.variant || ""));
  const line = mp >= 4 && hi ? hi : base;
  const rate = Number(line.cost_usd);
  const unit = (line.unit || "").toLowerCase();
  if (unit === "image" || unit === "request") return rate;
  if (unit === "megapixel") return rate * mp;
  if (unit === "token") return rate * TOKENS_PER_REF_IMAGE * mp;
  return null;
}

async function fetchTierCosts(slug: string): Promise<TierCosts> {
  const fail: TierCosts = { q: "—", one: "—", four: "—", note: "no price" };
  try {
    const cache = loadPricingCache();
    const hit = cache[slug];
    if (hit && Date.now() - Date.parse(hit.at) < PRICING_TTL_MS) return hit.costs;
    const res = await fetch(`${MODELS_URL}/${slug}/endpoints`, { headers: { accept: "application/json" } });
    if (!res.ok) return fail;
    const data = (await res.json()) as any;
    const eps: any[] = data?.endpoints ?? [];
    const perTier: number[][] = [[], [], []];
    let hiUsed = false;
    let provider = "";
    for (const ep of eps) {
      const lines: PriceLine[] = ep?.pricing ?? [];
      const vals = COST_TIERS.map((mp) => tierValue(lines, mp));
      if (vals.every((v) => v != null)) {
        vals.forEach((v, i) => perTier[i].push(v as number));
        if (!provider) provider = ep?.provider_name ?? "";
        if (lines.some((l) => l.variant && /high|2k|4k|max/i.test(l.variant))) hiUsed = true;
      }
    }
    if (!perTier[0].length) return fail;
    const costs: TierCosts = {
      q: fmtUsd(Math.min(...perTier[0])),
      one: fmtUsd(Math.min(...perTier[1])),
      four: fmtUsd(Math.min(...perTier[2])) + (hiUsed ? "*" : ""),
      note: provider,
    };
    cache[slug] = { at: new Date().toISOString(), costs };
    try {
      ensureDir(path.dirname(PRICING_CACHE_PATH));
      fs.writeFileSync(PRICING_CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch { /* cache is best-effort */ }
    return costs;
  } catch {
    return fail;
  }
}

function renderPins(pins: Record<string, PinEntry>, costs?: Record<string, TierCosts>): string {
  const rows = Object.entries(pins).map(([purpose, p]) => {
    const c = costs?.[p.model];
    return [
      purpose,
      shortSlug(p.model),
      c?.q ?? "…",
      c?.one ?? "…",
      c?.four ?? "…",
      wrap(p.why, 36, 4),
    ];
  });
  return boxTable(["purpose", "model", "\u00bcMP", "1MP", "4MP", "why"], rows, [
    "left", "left", "right", "right", "right", "left",
  ]);
}

function renderList(snap: SnapshotPayload, pins: Record<string, PinEntry>): string {
  const pinnedSlugs = new Set(Object.values(pins).map((p) => p.model));
  const pinned = snap.models.filter((m) => pinnedSlugs.has(m.slug));
  const rest = snap.models.filter((m) => !pinnedSlugs.has(m.slug)).slice(0, 12);
  const fmt = (m: SnapshotModel) => [
    (pinnedSlugs.has(m.slug) ? GREEN + "● " + RESET : "  ") + shortSlug(m.slug),
    (m.resolutions || []).join("/") || "-",
    m.max_refs != null ? String(m.max_refs) : "-",
    m.max_n != null ? String(m.max_n) : "-",
  ];
  const rows = [...pinned.map(fmt), ...rest.map(fmt)];
  const lines = [
    `Image models: ${snap.count} (fetched ${snap.fetched_at}) — ${GREEN}●${RESET} = pinned`,
    boxTable(["model", "res", "refs", "batch"], rows, ["left", "left", "right", "right"]),
  ];
  const shown = pinned.length + rest.length;
  if (snap.count > shown) lines.push(`… and ${snap.count - shown} more (see snapshot JSON)`);
  return lines.join("\n");
}

function renderChanges(cur: SnapshotPayload, prev: SnapshotPayload | null): string {
  if (!prev) return "No previous snapshot yet — run /forge-models refresh twice to diff.";
  const a = new Set(cur.models.map((m) => m.slug));
  const b = new Set(prev.models.map((m) => m.slug));
  const added = [...a].filter((s) => !b.has(s));
  const removed = [...b].filter((s) => !a.has(s));
  const lines = [`Models: ${prev.count} -> ${cur.count}`];
  lines.push(`Added (${added.length}): ${added.join(", ") || "none"}`);
  lines.push(`Removed (${removed.length}): ${removed.join(", ") || "none"}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("forge-models", {
    description:
      "Image-model tracker (OpenRouter Images API). Args: pins | list | changes | refresh. Snapshots catalog, diffs latest vs previous, keeps purpose pins in image_forge/models.pinned.json.",
    handler: async (args: string, ctx: any): Promise<void> => {
      const mode = (args || "pins").trim().toLowerCase().split(/\s+/)[0] || "pins";
      const pins = loadPins();
      if (mode === "pins") {
        ctx.ui.notify("forge-models: fetching endpoint prices…", "info");
        const slugs = [...new Set(Object.values(pins).map((p) => p.model))];
        const costs = Object.fromEntries(
          await Promise.all(slugs.map(async (s) => [s, await fetchTierCosts(s)] as const)),
        );
        ctx.ui.notify(
          renderPins(pins, costs) +
            "\n* 4MP carries the high-resolution variant price where one exists; flat models repeat.",
          "info",
        );
        return;
      }
      let snap = loadJson<SnapshotPayload>(LATEST_PATH);
      if (mode === "refresh" || !snap) {
        ctx.ui.notify("forge-models: fetching OpenRouter images catalog…", "info");
        try {
          snap = await fetchCatalog();
          saveSnapshot(snap);
        } catch (e: any) {
          ctx.ui.notify(`forge-models fetch failed: ${e?.message ?? e}`, "error");
          return;
        }
      }
      if (mode === "changes") {
        const prev = loadJson<SnapshotPayload>(PREV_PATH);
        ctx.ui.notify(renderChanges(snap!, prev), "info");
        return;
      }
      ctx.ui.notify("forge-models: fetching endpoint prices…", "info");
      const slugs = [...new Set(Object.values(pins).map((p) => p.model))];
      const costs = Object.fromEntries(
        await Promise.all(slugs.map(async (s) => [s, await fetchTierCosts(s)] as const)),
      );
      ctx.ui.notify(
        renderPins(pins, costs) + "\n\n" + renderList(snap!, pins) +
          `\n\n_Normalisation: 1K 1:1 ≈ ${REF_MP} MP; token-billed endpoints ≈ ${TOKENS_PER_REF_IMAGE} output tokens per reference picture._`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "forge_models_query",
    label: "forge-models query",
    description: "Query the image-model catalog snapshot and purpose pins. Modes: pins, list, changes.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "pins | list | changes (default pins)" })),
    }),
    async execute(_id: string, input: { mode?: string }) {
      const mode = (input?.mode || "pins").toLowerCase();
      const pins = loadPins();
      if (mode === "pins") return { pins, pins_path: PINS_PATH };
      const snap = loadJson<SnapshotPayload>(LATEST_PATH);
      if (!snap) return { error: "no snapshot yet; run /forge-models refresh", pins };
      if (mode === "changes") {
        const prev = loadJson<SnapshotPayload>(PREV_PATH);
        return { changes: renderChanges(snap, prev), count: snap.count };
      }
      return { count: snap.count, fetched_at: snap.fetched_at, models: snap.models.slice(0, 60), pins };
    },
  });
}
