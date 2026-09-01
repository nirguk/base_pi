/**
 * pi-failures — deterministic failed-turn analysis for past pi sessions.
 *
 * Registers `/failures` (user command). The actual analysis lives in
 * .pi/scripts/session-failures.mjs (zero deps, no network). This
 * extension is a thin wrapper: it spawns the script and relays stdout
 * to the terminal.
 *
 * Usage:
 *   /failures                        # per-model summary (default)
 *   /failures --clear                # dismiss the report widget
 *   /failures --since 7              # only failures in the last 7 days (default)
 *   /failures --since 3              # only failures in the last 3 days
 *   /failures --slug MODEL-SLUG      # drill-down: failure types + providers
 *
 * Keyboard shortcuts when the failures widget is visible:
 *   Ctrl+Shift+]   cycle to the next model slug (summary view only)
 *   Ctrl+Shift+[   cycle to the previous model slug (summary view only)
 *
 * Requirements: node (bundled with pi).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, type Theme, type TUI } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    child.stderr.on("data", (d: string) => { errBuf += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && errBuf) onData(`\n[stderr] ${errBuf.trim()}\n`);
      resolveExit(code ?? 0);
    });
  });
}

// ─── Slug cycling state ────────────────────────────────────

/** Current args (without --slug) so we can re-run with a different slug. */
let currentArgs: string[] = [];
/** Whether the failures widget is currently visible in the TUI. */
let widgetVisible = false;
/** Whether we've already notified the user about keyboard shortcuts. */
let widgetNotified = false;
/** Ordered list of unique model slugs extracted from the last summary output. */
let availableSlugs: string[] = [];
/** Current position in the availableSlugs list. */
let currentSlugIndex = 0;
/** Whether the current view is a breakdown (slug drill-down) — cycling disabled. */
let isBreakdown = false;

/**
 * Extract unique model slugs from the summary table output.
 * Parses lines like "   18  18/42 (43%)  openrouter/upstage/solar-pro4".
 */
function extractSlugsFromOutput(output: string): string[] {
  const slugs = new Set<string>();
  for (const line of output.split("\n")) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
    const m = clean.match(/^\s*\d+\s+\S+\s+\(.+%\)\s+(.+)$/);
    if (m) {
      const candidate = m[1].trim();
      if (candidate && !candidate.startsWith("──") && !["provider", "slug", "session", "day", "category"].includes(candidate)) {
        slugs.add(candidate);
      }
    }
  }
  return [...slugs];
}

async function resolveSlugCompletions(prefix: string): Promise<string[]> {
  if (availableSlugs.length === 0) return [];
  if (prefix) {
    const lower = prefix.toLowerCase();
    return availableSlugs.filter((s) => s.toLowerCase().includes(lower));
  }
  return availableSlugs;
}

/** Build args for a re-run with a different slug, preserving --since. */
function argsWithSlug(slug: string): string[] {
  const out = [...currentArgs];
  const sidx = out.indexOf("--slug");
  if (sidx !== -1) out.splice(sidx, 2);
  out.push("--slug", slug);
  return out;
}

/**
 * Create a widget component that renders all lines without truncation.
 * pi's default string-array widget caps at MAX_WIDGET_LINES=10.
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
    await spawnScript(args, (chunk) => { out += chunk; });
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
    isBreakdown = trimmed.includes("breakdown for");
    // Extract slugs from summary output for cycling.
    availableSlugs = trimmed.includes("grouped by slug") ? extractSlugsFromOutput(trimmed) : [];
    currentSlugIndex = availableSlugs.length > 0 ? 0 : -1;
    if (!widgetNotified && availableSlugs.length > 0 && !isBreakdown) {
      ctx.ui.notify(`failures: Ctrl+Shift+] / Ctrl+Shift+[ to cycle ${availableSlugs.length} model slug(s)`, "info");
      widgetNotified = true;
    }
  } else {
    ctx.ui.notify(lines.slice(0, 40).join("\n"), "info");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("failures", {
    description:
      "Analyze failed turns across past pi sessions (deterministic script). " +
      "Flags: --slug MODEL-SLUG (drill-down), --since DAYS (default 7), --clear. " +
      "Default view shows per-model failure rates. " +
      "Use --slug to see failure types and upstream providers for a specific model. " +
      "When the widget is visible, use Ctrl+Shift+] / Ctrl+Shift+[ to cycle slugs (summary view only).",
    getArgumentCompletions: async (prefix: string) => {
      const flags = ["--clear", "--since", "--slug"];
      const valueFlags = new Set(["--since", "--slug"]);
      const commonNumbers = ["1", "3", "7", "14", "30"];

      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      const hasTrailingSpace = prefix.endsWith(" ");
      const activeToken = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
      const baseTokens = hasTrailingSpace ? tokens : tokens.slice(0, -1);
      const rebuild = (completed: string) => [...baseTokens, completed].join(" ");

      // Case 1: active token is a flag (or empty → starting a new flag)
      if (activeToken.startsWith("--")) {
        const matches = flags.filter((f) => f.startsWith(activeToken));
        if (matches.length === 0) return null;
        return matches.map((f) => ({
          value: rebuild(f),
          label: f,
          description: valueFlags.has(f) ? "flag (takes a value)" : "flag",
        }));
      }

      // Case 2: previous token is a value-taking flag
      const prevToken = baseTokens.length > 0 ? baseTokens[baseTokens.length - 1] : null;

      if (prevToken === "--slug") {
        const slugs = await resolveSlugCompletions(activeToken);
        if (slugs.length === 0) return null;
        return slugs.map((s) => ({ value: rebuild(s), label: s, description: "model slug" }));
      }

      if (prevToken === "--since") {
        const matches = commonNumbers.filter((n) => n.startsWith(activeToken));
        if (matches.length === 0) return null;
        return matches.map((n) => ({
          value: rebuild(n),
          label: n,
          description: "days",
        }));
      }

      return null;
    },
    handler: async (args: string, ctx) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);

      // `--clear` is a pure UI action: dismiss the report widget.
      if (argv.includes("--clear")) {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget("failures", undefined);
          widgetVisible = false;
          isBreakdown = false;
        }
        ctx.ui.notify("failures: report cleared", "info");
        return;
      }

      // Extract --slug and --since from args, store the rest for cycling.
      const slugIdx = argv.indexOf("--slug");
      const userSlug = slugIdx !== -1 && slugIdx + 1 < argv.length ? argv[slugIdx + 1] : undefined;

      // Store current args without --slug for cycling.
      currentArgs = [...argv];
      if (slugIdx !== -1) currentArgs.splice(slugIdx, 2);

      // Ensure --since defaults to 7 when not provided.
      if (!argv.includes("--since")) {
        currentArgs.push("--since", "7");
      }

      const runArgs = [...currentArgs];
      if (userSlug) {
        runArgs.push("--slug", userSlug);
      }
      await runAndDisplay(pi, runArgs, ctx);
    },
  });

  // ── Keyboard shortcuts for cycling model slugs ──

  pi.registerShortcut(Key.ctrlShift("]"), {
    description: "Cycle failures to the next model slug (summary view only)",
    handler: async (ctx) => {
      if (!widgetVisible) {
        ctx.ui.notify("failures: run /failures first to show the widget", "info");
        return;
      }
      if (isBreakdown) {
        ctx.ui.notify("failures: slug cycling is disabled in drill-down view", "info");
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
    description: "Cycle failures to the previous model slug (summary view only)",
    handler: async (ctx) => {
      if (!widgetVisible) {
        ctx.ui.notify("failures: run /failures first to show the widget", "info");
        return;
      }
      if (isBreakdown) {
        ctx.ui.notify("failures: slug cycling is disabled in drill-down view", "info");
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
