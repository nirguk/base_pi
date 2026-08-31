/**
 * pi-failures — deterministic failed-turn analysis for past pi sessions.
 *
 * Registers `/failures` (user command) and `session_failures` (LLM tool? no —
 * command only, deterministic by delegating to the standalone script).
 *
 * The actual analysis lives in .pi/scripts/session-failures.mjs (zero deps,
 * no network). This extension is a thin wrapper: it spawns the script and
 * relays stdout to the terminal. This keeps the analysis fully deterministic
 * and testable outside pi.
 *
 * Usage:
 *   /failures                        # per-model breakdown (default, --by slug)
 *   /failures --clear                # dismiss/clear the report widget
 *   /failures --by provider|slug|session|day|category
 *   /failures --secondary provider|slug|session|day|category  # secondary crosstab dim
 *   /failures --since 7              # only failures in the last 7 days (default)
 *   /failures --since 3              # only failures in the last 3 days
 *   /failures --session 01a04da1     # failures from one session (prefix)
 *   /failures --json                 # machine-readable output
 *   /failures --detail --limit 30    # full entry rows, capped
 *
 * Keyboard shortcuts when the failures widget is visible:
 *   Ctrl+Shift+]   cycle to the next model slug
 *   Ctrl+Shift+[   cycle to the previous model slug
 *
 * The cycling goes through the actual model slugs that appear in the
 * failure data (e.g. "anthropic/claude-3-opus", "openai/gpt-4o"),
 * not through abstract dimension modes.
 *
 * Provider lens (--by provider): the primary grouping breaks failures
 * down by the OpenRouter upstream provider that actually served them
 * (baidu, digitalocean, novita, deepinfra, ...), parsed from the JSON
 * error body embedded in provider-error messages and falling back to
 * the pinned route.  `--by slug` restores the per-model view.
 *
 * Cross-tabulation (`--secondary`): defaults to `--secondary category`,
 * so `/failures` shows providers as rows with error-type breakouts
 * (429, aborted, terminated/conn-error, …).  Pick another secondary
 * dim, or pass `--by category --secondary provider` to invert it.  A
 * secondary equal to the primary collapses back to a single-dimension
 * summary.  Ignored under `--json` (use `--json` for full per-row
 * fields).
 *
 * Requirements: node (bundled with pi).
 *
 * @version 3.0.0
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, type Theme, type TUI } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The script lives next to this extension (extension in .pi/extensions/,
// script in .pi/extensions/scripts/, or script in .pi/scripts/).
const here = fileURLToPath(new URL(".", import.meta.url));
const candidates = [
  resolve(here, "..", "scripts", "session-failures.mjs"),
  resolve(here, "scripts", "session-failures.mjs"),
  resolve(here, "session-failures.mjs"),
];

function findScript(): string | null {
  return candidates.find((p) => existsSync(p)) ?? null;
}

function spawnScript(args: string[], onData: (chunk: string) => void) {
  return new Promise<number>((resolveExit, reject) => {
    const script = findScript();
    if (!script) {
      reject(new Error(`session-failures.mjs not found; looked in: ${candidates.join(", ")}`));
      return;
    }
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => onData(d));
    let errBuf = "";
    child.stderr.on("data", (d: string) => {
      errBuf += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && errBuf) onData(`\n[stderr] ${errBuf.trim()}\n`);
      resolveExit(code ?? 0);
    });
  });
}

// ─── Slug-based cycling state ──────────────────────────────────────

/** Current raw args (without --by / --slug) so we can re-run with a different slug. */
let currentArgs: string[] = [];
/** Whether the failures widget is currently visible in the TUI. */
let widgetVisible = false;
/** Whether we've already notified the user about keyboard shortcuts. */
let widgetNotified = false;
/** Ordered list of unique model slugs extracted from the last output. */
let availableSlugs: string[] = [];
/** Current position in the availableSlugs list. */
let currentSlugIndex = 0;

/**
 * Extract unique model slugs from the failures widget output.
 * Parses lines that look like slug entries in the summary table
 * (lines with a leading count like "   5 (12%)  anthropic/claude-3-opus").
 * Returns the list of slugs in display order.
 */
function extractSlugsFromOutput(output: string): string[] {
  const slugs = new Set<string>();
  for (const line of output.split("\n")) {
    // Strip ANSI color codes before matching so that red-highlighted
    // count/pct cells don't break the slug extraction regex.
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
    // Match summary lines: "<count> (<pct>%)  <slug>"  or  "<count>  <slug>"
    const m = clean.match(/^\s*\d+\s*(?:\(\d+%\))?\s+(.+)$/);
    if (m) {
      const candidate = m[1].trim();
      // Skip header/dimension labels and section dividers.
      if (candidate && !candidate.startsWith("──") && candidate !== "provider" && candidate !== "slug" && candidate !== "session" && candidate !== "day" && candidate !== "category") {
        slugs.add(candidate);
      }
    }
  }
  return [...slugs];
}

/**
 * Build the arg array for a re-run filtered to a specific slug.
 * Replaces any existing `--slug <slug>` in currentArgs, or appends
 * `--by slug --slug <slug>` if --by slug is not already present.
 */
function argsWithSlug(slug: string): string[] {
  const out = [...currentArgs];
  // Remove any existing --slug and its value.
  const sidx = out.indexOf("--slug");
  if (sidx !== -1) {
    out.splice(sidx, 2);
  }
  // Ensure --by slug is present.
  const byIdx = out.indexOf("--by");
  if (byIdx !== -1) {
    // Replace the existing --by value with "slug".
    out.splice(byIdx, 2, "--by", "slug");
  } else {
    out.push("--by", "slug");
  }
  out.push("--slug", slug);
  return out;
}

/**
 * Create a widget component that renders all lines without truncation.
 * pi's default string-array widget caps at MAX_WIDGET_LINES=10; using a
 * component factory bypasses that limit so the full output is visible.
 */
function failuresWidget(lines: string[]) {
  return (_tui: TUI, theme: Theme) => {
    const container = new Container();
    for (const line of lines) {
      container.addChild(new Text(line, 1, 0));
    }
    return {
      render(width: number): string[] {
        return container.render(width);
      },
      invalidate(): void {
        container.invalidate();
      },
      dispose(): void {
        container.clear();
      },
    };
  };
}

/** Run the analysis script and update the widget (or notify in RPC mode). */
async function runAndDisplay(
  pi: ExtensionAPI,
  args: string[],
  ctx: { mode: string; ui: { setWidget: (k: string, v: string[] | undefined) => void; notify: (m: string, l: string) => void; setStatus: (k: string, v: string | undefined) => void } },
): Promise<void> {
  let out = "";
  ctx.ui.setStatus("failures", "analyzing...");
  try {
    await spawnScript(args, (chunk) => {
      out += chunk;
    });
  } catch (err) {
    ctx.ui.setStatus("failures", undefined);
    throw err;
  } finally {
    ctx.ui.setStatus("failures", undefined);
  }
  const trimmed = out.trim();
  if (!trimmed) {
    ctx.ui.notify("session-failures: no output (script may have errored upstream)", "error");
    return;
  }
  const lines = trimmed.split("\n");
  if (ctx.mode === "tui") {
    ctx.ui.setWidget("failures", failuresWidget(lines));
    widgetVisible = true;
    // Extract slugs from the output for cycling.
    availableSlugs = extractSlugsFromOutput(trimmed);
    currentSlugIndex = availableSlugs.length > 0 ? 0 : -1;
    if (!widgetNotified && availableSlugs.length > 0) {
      ctx.ui.notify(`failures: Ctrl+Shift+] / Ctrl+Shift+[ to cycle ${availableSlugs.length} model slug(s)`, "info");
      widgetNotified = true;
    }
    if (lines.length > 10) {
      ctx.ui.notify("failures: widget shows all rows; use --detail for full per-row output", "info");
    }
  } else {
    ctx.ui.notify(lines.slice(0, 40).join("\n"), "info");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("failures", {
    description:
      "Analyze failed turns across past pi sessions (deterministic script). " +
      "Flags: --clear, --by provider|slug|session|day|category, " +
      "--secondary provider|slug|session|day|category, --since DAYS (default 7), " +
      "--session PREFIX, --kind all|assistant|tool, --slug MODEL-SLUG, " +
      "--json, --detail, --limit N, --top N. " +
      "When the widget is visible, use Ctrl+Shift+] / Ctrl+Shift+[ to cycle model slugs.",
    getArgumentCompletions: (prefix: string) => {
      const flags = ["--clear", "--by", "--secondary", "--since", "--session", "--kind", "--slug", "--json", "--detail", "--limit", "--top"];
      const items = flags
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ value: f, label: f }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);

      // `--clear` is a pure UI action: dismiss the report widget without
      // running the analysis. Handled here so it works even when the
      // script is missing/unrunnable.
      if (argv.includes("--clear")) {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget("failures", undefined);
          widgetVisible = false;
        }
        ctx.ui.notify("failures: report cleared", "info");
        return;
      }

      // Track the current args (without --by or --slug) so shortcuts can
      // re-run with a different slug while preserving all other flags.
      const byIdx = argv.indexOf("--by");
      if (byIdx !== -1 && byIdx + 1 < argv.length) {
        // Remove --by <dim> from stored args; we'll re-add --by slug
        // when cycling slugs.
        currentArgs = [...argv];
        currentArgs.splice(byIdx, 2);
      } else {
        currentArgs = [...argv];
      }
      // Remove any existing --slug from stored args so we can re-add it.
      const slugIdx = currentArgs.indexOf("--slug");
      if (slugIdx !== -1 && slugIdx + 1 < currentArgs.length) {
        currentArgs.splice(slugIdx, 2);
      }

      // Ensure --since defaults to 7 when not provided.
      if (!argv.includes("--since")) {
        currentArgs.push("--since", "7");
      }

      await runAndDisplay(pi, [...currentArgs, "--by", "slug"], ctx);
    },
  });

  // ── Keyboard shortcuts for cycling model slugs ──

  pi.registerShortcut(Key.ctrlShift("]"), {
    description: "Cycle failures to the next model slug (forward)",
    handler: async (ctx) => {
      if (!widgetVisible) {
        ctx.ui.notify("failures: run /failures first to show the widget", "info");
        return;
      }
      if (availableSlugs.length === 0) {
        ctx.ui.notify("failures: no model slugs found in the current output", "info");
        return;
      }
      currentSlugIndex = (currentSlugIndex + 1) % availableSlugs.length;
      await runAndDisplay(pi, argsWithSlug(availableSlugs[currentSlugIndex]), ctx);
    },
  });

  pi.registerShortcut(Key.ctrlShift("["), {
    description: "Cycle failures to the previous model slug (backward)",
    handler: async (ctx) => {
      if (!widgetVisible) {
        ctx.ui.notify("failures: run /failures first to show the widget", "info");
        return;
      }
      if (availableSlugs.length === 0) {
        ctx.ui.notify("failures: no model slugs found in the current output", "info");
        return;
      }
      currentSlugIndex = (currentSlugIndex - 1 + availableSlugs.length) % availableSlugs.length;
      await runAndDisplay(pi, argsWithSlug(availableSlugs[currentSlugIndex]), ctx);
    },
  });
}
