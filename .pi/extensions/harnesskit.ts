/**
 * fuzzy_edit — code edits with fuzzy matching tolerance (harnesskit).
 *
 * Wraps the harness venv's `harnesskit` (`hk apply`) as a pi tool. The
 * model supplies `old_text`/`new_text` pairs; hk locates the old text even
 * when its whitespace/indentation drifts from the file's actual bytes
 * (4-stage cascade: exact, whitespace-normalised, difflib, line-level),
 * then reports the match type, confidence and the text it actually matched
 * so the agent can verify what changed. Edits apply atomically: all or
 * nothing, with hk's undo backup store.
 *
 * Two deliberate guards, both learned from measuring hk against our real
 * workload:
 *
 * 1. Large-block fail-fast. hk's difflib stages are O(window x positions);
 *    a ~500-char old_text that matches nowhere ground hk for 60s+. So any
 *    old_text longer than GATE_LEN is pre-checked with the cheap stages
 *    only (exact, then whitespace-normalised) and refused instantly if
 *    neither hits — a large block that does not match even so is a
 *    wrong-block/stale-context signal, not drift, and the right answer is
 *    "re-read the file", not a long fuzzy search.
 * 2. Bound the subprocess. Every hk invocation runs under a hard timeout
 *    (HK_TIMEOUT_MS) so even an unexpected pathological input degrades to
 *    a clear "timed out" rather than a hung turn.
 *
 * Usage (LLM): fuzzy_edit {file, edits:[{oldText, newText}], ...} — same
 * parameter shape as the built-in `edit` tool (snake_case old_text/new_text
 * still accepted). Exact matches apply in-process with no subprocess; only
 * misses fall through to hk. The pre-call file bytes are retained and
 * restored on any abnormal end (timeout/kill), because hk's --atomic only
 * covers failures hk itself survives.
 *
 * @version 0.2.0
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

// ── Schema ──────────────────────────────────────────────────────────
const fuzzyEditSchema = Type.Object({
    file: Type.String({
        description: "Target file path, absolute or relative to the working directory.",
    }),
    edits: Type.Array(
        Type.Object({
            old_text: Type.Optional(Type.String({
                description:
                    "Text to find in the file. Keep it exact, unique and compact (under ~300 chars); " +
                    "whitespace/indentation may drift from the file, the content must be right. " +
                    "Snake_case spelling; oldText (edit-compatible camelCase) is also accepted.",
            })),
            new_text: Type.Optional(Type.String({ description: "Replacement for the matched text. newText also accepted." })),
            oldText: Type.Optional(Type.String({ description: "Alias for old_text — same spelling as the built-in edit tool." })),
            newText: Type.Optional(Type.String({ description: "Alias for new_text." })),
        }),
        { minItems: 1, description: "One or more replacements; applied atomically (all or nothing)." },
    ),
    threshold: Type.Optional(
        Type.Number({ description: "Fuzzy-match threshold 0-1 (default 0.8).", default: 0.8 }),
    ),
    dry_run: Type.Optional(
        Type.Boolean({
            description: "Preview only: report what would change, write nothing (default false).",
            default: false,
        }),
    ),
});

// ── Constants ─────────────────────────────────────────────────────────
// Old_text longer than this only runs hk's cheap stages (exact, then
// whitespace-normalised): hk's difflib stages are quadratic — measured
// grinding 60s+ on a ~500-char no-match in a mid-size file — and the
// remaining work at ~300 chars is already right around HK_TIMEOUT_MS, so
// above it a miss would degrade to a slow, vague timeout instead of an
// instant, precise refusal. Large exact or whitespace-drifted blocks still
// apply fine (stages 1-2); only content drift in big blocks is refused.
const GATE_LEN = 300;
const HK_TIMEOUT_MS = 20_000;
const DEFAULT_THRESHOLD = 0.8;

type HkRun = { code: number; out: string; error?: "timeout" | "enoent" | "other" };

// ── Helpers ──────────────────────────────────────────────────────────
function basePiRoot(): string {
    try {
        // This file: <root>/.pi/extensions/harnesskit.ts
        return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    } catch {
        // jiti/CJS fallback: the harness pins PI_CODING_AGENT_DIR=<root>/.pi
        const dotPi = process.env.PI_CODING_AGENT_DIR;
        if (dotPi) return resolve(dotPi, "..");
        return process.cwd();
    }
}

function hkBinary(): string {
    return resolve(basePiRoot(), ".venv", "bin", "hk");
}

// The cheap presence check, mirroring hk stages 1-2: exact, then a
// whitespace-tolerant comparison (per-line trim + whitespace-run collapse)
// so indentation or trailing-space drift still hits.
function normaliseForMatch(s: string): string {
    return s
        .split("\n")
        .map((line) => line.trim().replace(/[ \t]+/g, " "))
        .join("\n");
}

function cheapPresence(content: string, oldText: string): "exact" | "normalised" | null {
    if (content.includes(oldText)) return "exact";
    if (normaliseForMatch(content).includes(normaliseForMatch(oldText))) return "normalised";
    return null;
}

function runHk(args: string[], input: string, signal?: AbortSignal): Promise<HkRun> {
    // spawn + explicit stdin.end() rather than execFile's `input` option: the
    // latter left hk blocked in sys.stdin.read() (half-open pipe) — measured
    // hanging until the timeout kill, where the same command via a bash pipe
    // finished instantly. stdin.end() closes the pipe deterministically.
    return new Promise((resolveRun) => {
        const child = spawn(hkBinary(), args, { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let errOut = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolveRun({ code: -1, out: "", error: "timeout" });
        }, HK_TIMEOUT_MS);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolveRun({ code: -1, out: "", error: "timeout" });
        });
        child.stdout.on("data", (d: Buffer) => {
            out += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
            errOut += d.toString();
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            const ne = e as NodeJS.ErrnoException;
            resolveRun(ne.code === "ENOENT"
                ? { code: -1, out: "", error: "enoent" }
                : { code: -1, out: errOut || (e as Error).message, error: "other" });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === null) return; // killed by the timeout; already resolved
            resolveRun({ code: code ?? -1, out });
        });
        child.stdin.end(input);
    });
}

type HkResult = {
    status?: string;
    file?: string;
    match_type?: string;
    confidence?: number;
    matched_text?: string;
    error?: string;
};

function summarise(parsed: unknown, filePath: string, dryRun: boolean, nEdits: number) {
    const lines: string[] = [];
    const results: HkResult[] = [];
    let allApplied = true;

    const entries: HkResult[] = Array.isArray(parsed)
        ? (parsed as HkResult[])
        : parsed && typeof parsed === "object" && "status" in (parsed as object)
          ? [(parsed as HkResult)]
          : [];

    for (const r of entries) {
        results.push(r);
        const where = r.match_type ? `${r.match_type}@${r.confidence?.toFixed(2) ?? "?"}` : "";
        switch (r.status) {
            case "applied":
                lines.push(`  ${r.match_type ?? "applied"} (${where}): matched ${JSON.stringify(r.matched_text ?? "")}`);
                break;
            case "ambiguous":
                allApplied = false;
                lines.push(`  AMBIGUOUS — ${r.error ?? "old_text matches in several places"}; add surrounding context to old_text.`);
                break;
            case "no_match":
                allApplied = false;
                lines.push(`  NO MATCH — ${r.error ?? "old_text not found"}; re-read the file and resubmit with exact text.`);
                break;
            default:
                allApplied = false;
                lines.push(`  ${r.status ?? "error"}: ${r.error ?? "unknown failure"}`);
        }
    }

    const headline = dryRun
        ? `DRY RUN — would change ${entries.length}/${nEdits} edit${nEdits === 1 ? "" : "s"} in ${filePath}:`
        : allApplied
          ? `applied ${results.length}/${nEdits} edit${nEdits === 1 ? "" : "s"} to ${filePath} (atomic):`
          : `stopped — ${results.length}/${nEdits} edits processed, ${results.filter((r) => r.status !== "applied").length} failed, nothing written (atomic):`;

    return {
        content: [{ type: "text" as const, text: headline + "\n" + lines.join("\n") }],
        details: { results, ok: allApplied, dry_run: dryRun },
    };
}

// ── Tool Definition ─────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
    const definition: ToolDefinition<typeof fuzzyEditSchema> = {
        name: "fuzzy_edit",
        label: "fuzzy_edit",
        description:
            "Edit a code file: exact text replacement first, fuzzy matching fallback. " +
            "Same parameter shape as the built-in `edit` tool ({file, edits:[{oldText, newText}]}; " +
            "snake_case old_text/new_text also accepted), so this tool supersedes `edit` for edits " +
            "under ~300 chars per block. Each oldText is tried exactly first (in-process, no subprocess); " +
            "only misses fall through to harnesskit's tolerant stages (whitespace-normalised, difflib, " +
            "line-level), which locate oldText even when its whitespace or indentation drifted. " +
            "Edits apply atomically (all or nothing) — the pre-call file bytes are restored on any " +
            "abnormal end including timeout — and report match type + confidence + the matched text " +
            "so you can verify what changed (--dry_run preview available). Keep oldText exact, " +
            "unique and compact; beyond ~300 chars only whitespace drift is healed — content drift " +
            "in a large block is refused fast with a re-read instruction rather than exhaustively searched.",
        parameters: fuzzyEditSchema,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const filePath = resolve(ctx?.cwd ?? process.cwd(), params.file);
            const threshold = params.threshold ?? DEFAULT_THRESHOLD;
            const dryRun = params.dry_run ?? false;
            const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
            // Accept both spellings so calls written for `edit` work unchanged.
            const edits = params.edits.map((e) => ({
                old_text: e.oldText ?? e.old_text ?? "",
                new_text: e.newText ?? e.new_text ?? "",
            }));
            const missing = edits.findIndex((e) => !e.old_text || !e.new_text);
            if (missing !== -1) {
                return fail(`edit ${missing + 1}: supply old_text/new_text (or the edit-style oldText/newText).`);
            }

            const hk = hkBinary();
            if (!existsSync(hk)) {
                return fail(
                    `fuzzy_edit unavailable: harnesskit is not installed in the harness venv ` +
                    `(expected ${hk}). Run \`uv sync\` from the base_pi harness root, or its ` +
                    `.devcontainer setup, and retry.`,
                );
            }

            let content: string;
            try {
                content = readFileSync(filePath, "utf8");
            } catch (e) {
                return fail(`cannot read ${filePath}: ${(e as Error).message}`);
            }

            // Exact-first fast path: every block present exactly once needs no
            // subprocess — apply in-process with a single write (atomic by
            // construction). Anything else (miss or repeated block) goes to hk.
            const exactOnce = edits.every((e) =>
                content.includes(e.old_text) &&
                content.indexOf(e.old_text) === content.lastIndexOf(e.old_text));
            if (exactOnce) {
                const applied = edits.map((e) => ({
                    status: "applied",
                    match_type: "exact",
                    confidence: 1,
                    matched_text: e.old_text,
                }));
                if (!dryRun) {
                    let updated = content;
                    for (const e of edits) updated = updated.replace(e.old_text, e.new_text);
                    try {
                        writeFileSync(filePath, updated, "utf8");
                    } catch (e) {
                        return fail(`fuzzy_edit exact path could not write ${filePath}: ${(e as Error).message}`);
                    }
                }
                return summarise(applied, filePath, dryRun, edits.length);
            }

            // Large-block fail-fast gate.
            const blocked: string[] = [];
            const gate: { index: number; how: string }[] = [];
            edits.forEach((e, i) => {
                if (e.old_text.length <= GATE_LEN) return;
                const how = cheapPresence(content, e.old_text);
                gate.push({ index: i, how: how ?? "none" });
                if (how === null) {
                    blocked.push(
                        `  edit ${i + 1}: old_text is ${e.old_text.length} chars and matches nowhere ` +
                        `(not even whitespace-tolerant) — re-read ${params.file} and resubmit a smaller, exact block`,
                    );
                }
            });
            if (blocked.length) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "fuzzy_edit refused before touching the file — no changes applied:\n" + blocked.join("\n"),
                    }],
                    details: { gate, note: "old_text beyond the size gate is only matched via exact/whitespace-normalised stages" },
                };
            }

            const payload = {
                edits: edits.map((e) => ({ file: filePath, old_text: e.old_text, new_text: e.new_text })),
            };
            const args = ["apply", "--stdin", "--format", "json", "--atomic", "--threshold", String(threshold)];
            if (dryRun) args.push("--dry-run");

            // Bytes held for restore: hk's --atomic only rolls back failures hk itself
            // survives, so an externally-killed (timeout) process can leave partial
            // writes behind. On any abnormal end we write the original bytes back first.
            const original = content;
            const restore = (): boolean => {
                if (dryRun) return false;
                try {
                    writeFileSync(filePath, original, "utf8");
                    return true;
                } catch {
                    return false;
                }
            };

            const run = await runHk(args, JSON.stringify(payload), signal);
            if (run.error === "timeout") {
                const restored = restore();
                return fail(
                    `fuzzy_edit timed out after ${HK_TIMEOUT_MS / 1000}s. ` +
                    (restored
                        ? `${params.file} was restored to its pre-call bytes (nothing applied). `
                        : `WARNING: could not restore ${params.file} — verify its contents. `) +
                    `Re-read ${params.file} and resubmit with smaller blocks.`,
                );
            }
            if (run.error === "enoent") {
                return fail(`fuzzy_edit unavailable: harnesskit binary missing (${hk}). Run \`uv sync\` in the base_pi harness.`);
            }
            if (run.error === "other" || !run.out.trim()) {
                const restored = restore();
                return fail(
                    `fuzzy_edit failed unexpectedly (rc ${run.code}): ${run.out.slice(0, 400)}` +
                    (restored ? ` File restored to pre-call bytes.` : ``),
                );
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(run.out);
            } catch {
                const restored = restore();
                return fail(
                    `fuzzy_edit: unexpected output from harnesskit:\n${run.out.slice(0, 400)}` +
                    (restored ? ` File restored to pre-call bytes.` : ``),
                );
            }

            // Atomic rollback shape: {"status":"rolled_back","failed_edit_index":...,"failed_edit":...}
            if (
                parsed && typeof parsed === "object" &&
                (parsed as HkResult).status === "rolled_back"
            ) {
                const rb = parsed as HkResult & { failed_edit_index?: number; failed_edit?: HkResult };
                const failed = rb.failed_edit;
                return fail(
                    `fuzzy_edit rolled back — no changes applied: edit ${(rb.failed_edit_index ?? 0) + 1} ` +
                    `failed (${failed?.status ?? "unknown"}${failed?.error ? `: ${failed.error}` : ""}). ` +
                    `Re-read ${params.file} and resubmit.`,
                );
            }

            return summarise(parsed, filePath, dryRun, edits.length);
        },
    };

    pi.registerTool(definition);
}