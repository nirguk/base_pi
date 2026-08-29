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
 *   /failures                        # providers × error-types cross-tab (default)
 *   /failures --clear                # dismiss/clear the report widget
 *   /failures --by provider|slug|session|day|category
 *   /failures --secondary provider|slug|session|day|category  # secondary crosstab dim
 *   /failures --since 3              # only failures in the last 3 days
 *   /failures --session 01a04da1     # failures from one session (prefix)
 *   /failures --json                 # machine-readable output
 *   /failures --detail --limit 30    # full entry rows, capped
 *
 * Provider lens (default primary): the primary grouping breaks failures down
 * by the OpenRouter upstream provider that actually served them (baidu,
 * digitalocean, novita, deepinfra, ...), parsed from the JSON error body
 * embedded in provider-error messages and falling back to the pinned route.
 * `--by slug` restores the per-model view.
 *
 * Cross-tabulation (`--secondary`): defaults to `--secondary category`, so
 * `/failures` shows providers as rows with error-type breakouts (429,
 * aborted, terminated/conn-error, …). Pick another secondary dim, or pass
 * `--by category --secondary provider` to invert it. A secondary equal to
 * the primary collapses back to a single-dimension summary. Ignored under
 * `--json` (use `--json` for full per-row fields).
 *
 * Requirements: node (bundled with pi).
 *
 * @version 1.0.0
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("failures", {
    description:
      "Analyze failed turns across past pi sessions (deterministic script). " +
      "Flags: --clear, --by provider|slug|session|day|category, " +
      "--secondary provider|slug|session|day|category, --since DAYS, " +
      "--session PREFIX, --kind all|assistant|tool, --json, --detail, " +
      "--limit N, --top N.",
    getArgumentCompletions: (prefix: string) => {
      const flags = ["--clear", "--by", "--secondary", "--since", "--session", "--kind", "--json", "--detail", "--limit", "--top"];
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
        }
        ctx.ui.notify("failures: report cleared", "info");
        return;
      }

      let out = "";
      ctx.ui.setStatus("failures", "analyzing...");
      try {
        await spawnScript(argv, (chunk) => {
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
        // Widget is the primary surface in the TUI (persistent report panel).
        ctx.ui.setWidget("failures", lines);
      } else {
        // RPC/print mode: notify works everywhere.
        ctx.ui.notify(lines.slice(0, 40).join("\n"), "info");
      }
    },
  });
}