/**
 * session-failures-display.mjs — pure display/formatting module for session-failures.
 *
 * Owns ALL text alignment and column rendering. Imported by session-failures.mjs
 * so the analysis script stays focused on data collection and the display module
 * owns the visual layout.
 *
 * Two output modes:
 *   buildSummaryOutput() — default per-model summary table
 *   buildBreakdownOutput() — slug drill-down with category + provider tables
 */

// ─── ANSI helpers ──────────────────────────────────────────────

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Strip ANSI escape sequences so we can measure visible text width. */
export function visibleLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad a string to a *visible* width `n`, leaving ANSI codes intact. */
export function padVisible(s, n) {
  const vis = visibleLen(s);
  if (vis >= n) return s;
  return s + " ".repeat(n - vis);
}

/** Left-pad a string to a *visible* width `n`. */
export function padVisibleStart(s, n) {
  const vis = visibleLen(s);
  if (vis >= n) return s;
  return " ".repeat(n - vis) + s;
}

/** Standard padEnd (for non-ANSI text). */
export function pad(s, n) {
  return String(s).padEnd(n);
}

/** Wrap text in red ANSI codes. */
export function redWrap(text) {
  return `${RED}${text}${RESET}`;
}

/**
 * Display label for a provider key. The bare `openrouter` key means the
 * router itself with no upstream attribution available — label it so it
 * is not read as "OpenRouter's own infrastructure failed".
 */
export function providerLabel(p) {
  return p === "openrouter" ? "openrouter (unknown upstream)" : String(p);
}

/** Emit the shared header (title, dirs, cutoff, mode, notices). */
function pushHeader(out, { first, SINCE_DAYS, cutoffTs, DIR, mode, notices }) {
  out.push(first);
  out.push(`Sessions dir: ${DIR}`);
  if (cutoffTs) {
    out.push(`Cutoff: last ${SINCE_DAYS} day(s) (files newer than ${new Date(cutoffTs).toISOString().slice(0, 19)}Z)`);
  }
  out.push(`Attribution mode: ${mode}`);
  for (const n of notices ?? []) {
    out.push(`[notice] ${n}`);
  }
  out.push("");
}

// ─── Rate cell ─────────────────────────────────────────────────

/**
 * Build a fixed-format rate cell `f/attempts (pct%)`.
 * When `attempts` is 0, renders the raw failure count with an em-dash rate.
 * Red-wrapping is applied when pct > 10.
 */
export function renderRate(failures, attempts, w) {
  const a = attempts || 0;
  const f = failures || 0;
  let core;
  if (a === 0) {
    core = `${f} (--%)`;
  } else {
    const pct = Math.round((100 * f) / a);
    core = `${String(f).padStart(String(a).length)}/${a} (${String(pct).padStart(2)}%)`;
    if (pct > 10) core = redWrap(core);
  }
  return w ? padVisibleStart(core, w) : core;
}

/** Visible width of the rate cell for a given (failures, attempts) pair. */
export function rateCellWidth(failures, attempts) {
  const a = attempts || 0;
  const f = failures || 0;
  if (a === 0) return `${f} (--%)`.length;
  const pct = Math.round((100 * f) / a);
  return `${String(f).padStart(String(a).length)}/${a} (${String(pct).padStart(2)}%)`.length;
}

// ─── Summary output ────────────────────────────────────────────

/**
 * Build the default per-model summary table.
 *
 * Data shape:
 *   { groups, topKeys, slugAttempts, totalFailures, SINCE_DAYS, cutoffTs, DIR }
 */
export function buildSummaryOutput({ groups, topKeys, slugAttempts, totalFailures, SINCE_DAYS, cutoffTs, DIR, mode = "offline", notices = [] }) {
  const out = [];
  pushHeader(out, { first: `Failed turns: ${totalFailures} — grouped by slug`, SINCE_DAYS, cutoffTs, DIR, mode, notices });

  const hasRate = slugAttempts && slugAttempts.size > 0;
  const countW = Math.max(...topKeys.map((k) => String(groups[k]?.length ?? 0).length), 1);

  let rateW = 0;
  if (hasRate) {
    for (const key of topKeys) {
      const g = groups[key] || [];
      const attempts = slugAttempts.get(key) || 0;
      rateW = Math.max(rateW, rateCellWidth(g.length, attempts));
    }
  }

  const headerDims = hasRate ? `${pad("failures", countW)}  rate  slug` : `${pad("failures", countW)}  slug`;
  out.push(headerDims);
  out.push("-".repeat(Math.max(60, headerDims.length)));

  for (const key of topKeys) {
    const g = groups[key] || [];
    const countPart = pad(g.length, countW);
    if (hasRate) {
      const attempts = slugAttempts.get(key) || 0;
      const rate = renderRate(g.length, attempts, rateW);
      out.push(`${countPart}  ${rate}  ${key}`);
    } else {
      out.push(`${countPart}  ${key}`);
    }
  }
  out.push("");

  return out;
}

// ─── Breakdown output ──────────────────────────────────────────

/**
 * Build the slug drill-down view with failure type and provider tables.
 *
 * Data shape:
 *   { slug, totalFailures, totalAttempts, byCategory, byProvider, SINCE_DAYS, cutoffTs, DIR }
 */
export function buildBreakdownOutput({ slug, totalFailures, totalAttempts, byCategory, byProvider, byProviderAttempts, providerTotal, SINCE_DAYS, cutoffTs, DIR, mode = "offline", notices = [] }) {
  const out = [];
  pushHeader(out, { first: `Failed turns: ${totalFailures} — breakdown for ${slug}`, SINCE_DAYS, cutoffTs, DIR, mode, notices });

  if (totalFailures === 0) {
    out.push(`No failures found for slug ${slug}, or slug not recognised.`);
    out.push("");
    return out;
  }

  // ── Failure types ──────────────────────────────────────
  const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const catCountW = Math.max(...catEntries.map(([, c]) => String(c).length), 1);
  const catRateW = rateCellWidth(totalFailures, totalFailures);

  out.push("Failure types:");
  out.push(`${pad("failures", catCountW)}  rate  category`);
  out.push("-".repeat(60));

  for (const [cat, count] of catEntries) {
    const countPart = pad(count, catCountW);
    const rate = renderRate(count, totalFailures, catRateW);
    out.push(`${countPart}  ${rate}  ${cat}`);
  }
  out.push("");

  // ── Upstream providers ──────────────────────────────────
  const provEntries = Object.entries(byProvider).sort((a, b) => b[1] - a[1]);
  const provCountW = Math.max(...provEntries.map(([, c]) => String(c).length), 1);
  const provRateW = rateCellWidth(totalFailures, providerTotal ?? totalFailures);

  out.push("Upstream providers (final attempt):");
  out.push(`${pad("failures", provCountW)}  rate  provider`);
  out.push("-".repeat(60));

  for (const [prov, count] of provEntries) {
    const countPart = pad(count, provCountW);
    const rate = renderRate(count, providerTotal ?? totalFailures, provRateW);
    out.push(`${countPart}  ${rate}  ${providerLabel(prov)}`);
  }
  out.push("");

  // Providers involved (incl. routed-around fallbacks).
  if (byProviderAttempts) {
    const attEntries = Object.entries(byProviderAttempts).sort((a, b) => b[1] - a[1]);
    if (attEntries.length > 0) {
      const attCountW = Math.max(...attEntries.map(([, c]) => String(c).length), 1);
      const attRateW = rateCellWidth(totalFailures, providerTotal ?? totalFailures);

      out.push("Providers involved (incl. fallbacks routed around):");
      out.push(`${pad("failures", attCountW)}  rate  provider`);
      out.push("-".repeat(60));

      for (const [prov, count] of attEntries) {
        const countPart = pad(count, attCountW);
        const rate = renderRate(count, providerTotal ?? totalFailures, attRateW);
        out.push(`${countPart}  ${rate}  ${providerLabel(prov)}`);
      }
      out.push("");
    }
  }

  // ── Total line ──────────────────────────────────────────
  const totalPct = totalAttempts > 0 ? Math.round((100 * totalFailures) / totalAttempts) : 0;
  let totalRate = `${totalPct}%`;
  if (totalPct > 10) totalRate = redWrap(totalRate);
  out.push(`TOTAL: ${totalFailures} failures / ${totalAttempts} attempts (${totalRate})`);
  out.push("");

  return out;
}
