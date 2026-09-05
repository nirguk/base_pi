/**
 * findtree — search with `find`, display results as a compact ASCII tree.
 *
 * Token-efficient alternative to the built-in `find` tool for broad searches
 * spanning many subdirectories: `tree --fromfile` collapses repeated parent
 * prefixes into a single hierarchy, producing far fewer tokens.
 *
 * Paging is applied at the input level: `tail | head` limit the find results
 * fed to `tree` so only the current page's paths are processed, bounding
 * memory and CPU. Each page shows a self-contained subtree for those paths.
 *
 * Usage (LLM):  findtree path [expressions...]
 * Usage (user): /findtree . -type f -name "*.ts"
 *
 * Requirements: `find` (findutils), `tail`, `head`, and `tree` installed on the system.
 *
 * @version 1.3.0
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { access as fsAccess } from "node:fs/promises";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";

// ── Schema ──────────────────────────────────────────────────────────
const findtreeSchema = Type.Object({
    path: Type.Optional(
        Type.String({ description: "Directory to search in (default: current directory '.')" }),
    ),
    expressions: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "Find expressions as individual argument strings, e.g. ['-type', 'f', '-name', '*.ts', '-not', '-path', '*/node_modules/*']",
        }),
    ),
    from: Type.Optional(
        Type.Number({
            description:
                "Skip the first N find result paths before building the tree. Default: 0",
        }),
    ),
    lines: Type.Optional(
        Type.Number({
            description:
                "Maximum number of find result paths per page. Default: 100. Max: 500.",
        }),
    ),
});

type FindTreeInput = Static<typeof findtreeSchema>;

// ── Constants ─────────────────────────────────────────────────────────
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const PREVIEW_LINES = 20;

// ── Tool Definition ─────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
    const definition: ToolDefinition<typeof findtreeSchema> = {
        name: "findtree",
        label: "findtree",
        description:
            "Search for files with `find` and display results as a compact ASCII tree. " +
            "More token-efficient than the built-in `find` tool for searches spanning many " +
            "subdirectories: `tree --fromfile` collapses repeated parent-directory prefixes " +
            "into a single hierarchy. Accepts the same expressions as `find`. " +
            "Requires the `tree` command to be installed.",
        parameters: findtreeSchema,

        async execute(
            _toolCallId: string,
            { path: searchDir, expressions, from, lines }: FindTreeInput,
            signal?: AbortSignal,
            _onUpdate?: unknown,
            _ctx?: unknown,
        ) {
            const startTime = Date.now();

            // Resolve the search path to an absolute path for cwd.
            // We always run `find .` from within the search directory so that
            // find outputs `./path/to/file` — which `sed` then strips to
            // `path/to/file` for `tree --fromfile`. This avoids tree --fromfile's
            // poor handling of absolute or multi-component relative paths.
            const rawPath = searchDir?.trim() || ".";
            const resolvedPath = resolve(rawPath);

            // Verify the resolved path exists before spawning
            try {
                await fsAccess(resolvedPath);
            } catch {
                return {
                    content: [{ type: "text" as const, text: `Path not found: ${rawPath}` }],
                    details: {},
                };
            }

            if (signal?.aborted) throw new Error("Operation aborted");

            const pageSize = Math.min(lines ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
            const skip = from ?? 0;

            // Build find arguments: always from `.` (cwd handles the directory)
            const findArgs = ["."];
            if (expressions && expressions.length > 0) {
                findArgs.push(...expressions);
            }

            return new Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }>(
                (resolve, reject) => {
                    let done = false;
                    let findChild: ReturnType<typeof spawn> | null = null;
                    let tailChild: ReturnType<typeof spawn> | null = null;
                    let headChild: ReturnType<typeof spawn> | null = null;
                    let sedChild: ReturnType<typeof spawn> | null = null;
                    let treeChild: ReturnType<typeof spawn> | null = null;
                    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

                    const abortHandler = () => {
                        if (done) return;
                        done = true;
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        if (sedChild && !sedChild.killed) sedChild.kill();
                        if (headChild && !headChild.killed) headChild.kill();
                        if (tailChild && !tailChild.killed) tailChild.kill();
                        if (findChild && !findChild.killed) findChild.kill();
                        reject(new Error("Operation aborted"));
                    };
                    signal?.addEventListener("abort", abortHandler, { once: true });

                    // ── Spawn pipeline: find | [tail | head] | sed | tree --fromfile ──
                    // `find .` outputs paths prefixed with './', but `tree --fromfile`
                    // only handles bare relative paths (e.g., '.pi/file' not './.pi/file').
                    findChild = spawn("find", findArgs, {
                        cwd: resolvedPath,
                        stdio: ["ignore", "pipe", "pipe"],
                    });

                    // Input-level paging: skip and limit paths BEFORE they reach tree.
                    // This bounds memory and CPU — tree only processes the current page.
                    // When from=0 and lines=default, we still use head to cap input.
                    const useTail = skip > 0;
                    const useHead = true; // always cap input to bound memory

                    if (useTail) {
                        tailChild = spawn("tail", ["-n", `+${skip + 1}`], {
                            cwd: resolvedPath,
                            stdio: ["pipe", "pipe", "pipe"],
                        });
                    }

                    headChild = spawn("head", ["-n", String(pageSize)], {
                        cwd: resolvedPath,
                        stdio: ["pipe", "pipe", "pipe"],
                    });

                    sedChild = spawn("sed", ["s|^\\./||"], {
                        cwd: resolvedPath,
                        stdio: ["pipe", "pipe", "pipe"],
                    });

                    treeChild = spawn("tree", ["--fromfile", "-A", "--noreport"], {
                        cwd: resolvedPath,
                        stdio: ["pipe", "pipe", "pipe"],
                    });

                    // Pipe find's stdout into the paging stage(s), then into sed, then into tree
                    if (useTail) {
                        findChild.stdout.pipe(tailChild.stdin);
                        tailChild.stdout.pipe(headChild.stdin);
                    } else {
                        findChild.stdout.pipe(headChild.stdin);
                    }
                    headChild.stdout.pipe(sedChild.stdin);
                    sedChild.stdout.pipe(treeChild.stdin);

                    // 30-second timeout
                    timeoutHandle = setTimeout(() => {
                        if (done) return;
                        done = true;
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        if (sedChild && !sedChild.killed) sedChild.kill();
                        if (headChild && !headChild.killed) headChild.kill();
                        if (tailChild && !tailChild.killed) tailChild.kill();
                        if (findChild && !findChild.killed) findChild.kill();
                        reject(new Error("findtree timed out after 30 seconds"));
                    }, 30_000);

                    // Accumulate tree's stdout
                    let output = "";
                    treeChild.stdout.on("data", (chunk: Buffer) => {
                        output += chunk.toString();
                    });

                    // Accumulate stderr for diagnostics
                    let stderr = "";
                    treeChild.stderr?.on("data", (chunk: Buffer) => {
                        stderr += chunk.toString();
                    });
                    sedChild.stderr?.on("data", (chunk: Buffer) => {
                        stderr += chunk.toString();
                    });
                    findChild.stderr?.on("data", (chunk: Buffer) => {
                        stderr += chunk.toString();
                    });

                    const finish = () => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);

                        const trimmed = output.trim();
                        const elapsedMs = Date.now() - startTime;
                        const elapsedSec = (elapsedMs / 1000).toFixed(2);

                        // If tree produced no output:
                        // - skip > 0 means we paginated beyond the last page
                        // - skip === 0 means there were no results at all
                        if (!trimmed || trimmed === ".") {
                            const err = stderr.trim();
                            if (err) {
                                reject(new Error(err));
                                return;
                            }
                            if (skip > 0) {
                                resolve({
                                    content: [{ type: "text", text: `(no more results — end of output, took ${elapsedSec}s)` }],
                                    details: { skip, pageSize, remaining: 0 },
                                });
                            } else {
                                resolve({
                                    content: [{ type: "text", text: `(no results, took ${elapsedSec}s)` }],
                                    details: {},
                                });
                            }
                            return;
                        }

                        const resultText = trimmed;
                        const footerParts: string[] = [];

                        if (skip > 0) {
                            footerParts.push(`(showing paths ${skip + 1}–${skip + pageSize})`);
                        } else {
                            footerParts.push(`(showing up to ${pageSize} paths)`);
                        }

                        footerParts.push(`└─ more results — use --from ${skip + pageSize} for the next page`);
                        footerParts.push(`(took ${elapsedSec}s)`);

                        if (footerParts.length > 0) {
                            resultText += "\n" + footerParts.join(" ");
                        }

                        resolve({
                            content: [{ type: "text", text: resultText }],
                            details: { skip, pageSize },
                        });
                    };

                    treeChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (sedChild && !sedChild.killed) sedChild.kill();
                        if (headChild && !headChild.killed) headChild.kill();
                        if (tailChild && !tailChild.killed) tailChild.kill();
                        if (findChild && !findChild.killed) findChild.kill();

                        const msg = err.message.includes("spawn tree ENOENT")
                            ? "`tree` command is required. Install with: apt install tree, brew install tree, or choco install tree"
                            : err.message;
                        reject(new Error(msg));
                    });

                    findChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (sedChild && !sedChild.killed) sedChild.kill();
                        if (headChild && !headChild.killed) headChild.kill();
                        if (tailChild && !tailChild.killed) tailChild.kill();
                        if (treeChild && !treeChild.killed) treeChild.kill();

                        const msg = err.message.includes("spawn find ENOENT")
                            ? "`find` command is required (part of GNU findutils)"
                            : err.message;
                        reject(new Error(msg));
                    });

                    if (tailChild) {
                        tailChild.on("error", (err: Error) => {
                            if (done) return;
                            done = true;
                            signal?.removeEventListener("abort", abortHandler);
                            if (timeoutHandle) clearTimeout(timeoutHandle);
                            if (headChild && !headChild.killed) headChild.kill();
                            if (sedChild && !sedChild.killed) sedChild.kill();
                            if (findChild && !findChild.killed) findChild.kill();
                            if (treeChild && !treeChild.killed) treeChild.kill();
                            reject(new Error(err.message));
                        });
                    }

                    headChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (sedChild && !sedChild.killed) sedChild.kill();
                        if (tailChild && !tailChild.killed) tailChild.kill();
                        if (findChild && !findChild.killed) findChild.kill();
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        reject(new Error(err.message));
                    });

                    sedChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (headChild && !headChild.killed) headChild.kill();
                        if (tailChild && !tailChild.killed) tailChild.kill();
                        if (findChild && !findChild.killed) findChild.kill();
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        reject(new Error(err.message));
                    });

                    // Track all process exits to prevent pipeline deadlocks.
                    // Each finished process closes the stdin of its downstream stage
                    // so no process hangs waiting for input that will never come.
                    let findClosed = false;
                    let tailClosed = false;
                    let headClosed = false;
                    let sedClosed = false;
                    let treeClosed = false;
                    const maybeFinish = () => {
                        if (findClosed && tailClosed && headClosed && sedClosed && treeClosed) finish();
                    };

                    findChild.on("close", () => {
                        findClosed = true;
                        if (tailChild && !tailChild.killed) tailChild.stdin.end();
                        else if (headChild && !headChild.killed) headChild.stdin.end();
                        else if (sedChild && !sedChild.killed) sedChild.stdin.end();
                        maybeFinish();
                    });
                    if (tailChild) {
                        tailChild.on("close", () => {
                            tailClosed = true;
                            if (headChild && !headChild.killed) headChild.stdin.end();
                            else if (sedChild && !sedChild.killed) sedChild.stdin.end();
                            maybeFinish();
                        });
                    }
                    headChild.on("close", () => {
                        headClosed = true;
                        if (sedChild && !sedChild.killed) sedChild.stdin.end();
                        maybeFinish();
                    });
                    sedChild.on("close", () => {
                        sedClosed = true;
                        if (treeChild && !treeChild.killed) treeChild.stdin.end();
                        maybeFinish();
                    });
                    treeChild.on("close", () => {
                        treeClosed = true;
                        maybeFinish();
                    });
                },
            );
        },

        // ── Custom rendering ──────────────────────────────────────
        renderCall(
            args: FindTreeInput,
            theme: Record<string, (s: string) => string>,
            context: { lastComponent?: import("@earendil-works/pi-tui").Text },
        ) {
            const text = context.lastComponent ?? new Text("", 0, 0);
            const path = args.path || ".";
            const exprStr =
                args.expressions && args.expressions.length > 0
                    ? ` ${args.expressions.join(" ")}`
                    : "";
            text.setText(theme.fg("toolTitle", theme.bold(`findtree ${path}${exprStr}`)));
            return text;
        },

        renderResult(
            result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
            options: { expanded?: boolean },
            theme: Record<string, (s: string) => string>,
            context: { lastComponent?: import("@earendil-works/pi-tui").Text; showImages?: boolean },
        ) {
            const text = context.lastComponent ?? new Text("", 0, 0);
            const output = result.content?.find((c) => c.type === "text")?.text?.trim() || "";

            if (!output || output.startsWith("(no results") || output.startsWith("(no more results")) {
                text.setText(theme.fg("muted", output || "(no results)"));
                return text;
            }

            const lines = output.split("\n");

            // Separate footer lines (paging hints) from content lines
            const contentLines: string[] = [];
            const footerLines: string[] = [];
            for (const line of lines) {
                if (line.startsWith("└─") || line.startsWith("(showing") || line.startsWith("(took")) {
                    footerLines.push(line);
                } else {
                    contentLines.push(line);
                }
            }

            if (options.expanded) {
                let display = `\n${theme.fg("toolOutput", contentLines.join("\n"))}`;
                if (footerLines.length > 0) {
                    display += "\n" + footerLines.map((l) => theme.fg("muted", l)).join("\n");
                }
                text.setText(display);
            } else {
                const maxPreview = 20;
                const preview = contentLines.slice(0, maxPreview);
                const remaining = contentLines.length - maxPreview;
                let display = `\n${preview.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
                if (remaining > 0) {
                    display += `\n${theme.fg("muted", `└─ (${remaining} more content lines — expand to view all)`)}`;
                }
                if (footerLines.length > 0) {
                    display += "\n" + footerLines.map((l) => theme.fg("muted", l)).join("\n");
                }
                text.setText(display);
            }
            return text;
        },
    };

    // ── Register as a custom tool (LLM-callable) ───────────────────
    pi.registerTool(definition);

    // ── Register as a slash command (user-callable via /findtree) ──
    pi.registerCommand("findtree", {
        description:
            "Find files and display as a compact ASCII tree. Paging is applied at the input level (tail | head) so tree only processes the current page's paths. Supports --from N (skip first N paths) and --lines N (paths per page, default 100, max 500).",
        handler: async (args: string, ctx) => {
            // Parse --from and --lines flags before passing remaining args to find
            const allParts = args.trim().split(/\s+/);
            let fromArg: number | undefined;
            let linesArg: number | undefined;
            const findParts: string[] = [];

            for (let i = 0; i < allParts.length; i++) {
                if (allParts[i] === "--from" && i + 1 < allParts.length) {
                    fromArg = parseInt(allParts[++i], 10);
                } else if (allParts[i] === "--lines" && i + 1 < allParts.length) {
                    linesArg = parseInt(allParts[++i], 10);
                } else {
                    findParts.push(allParts[i]);
                }
            }

            const rawPath = findParts[0] || ".";
            const resolvedPath = resolve(rawPath);
            const expr = findParts.slice(1);

            // Build shell-quoted command with input-level paging:
            // find | tail -n +X | head -n Y | sed | tree
            // tail skips the first (fromArg) paths, head limits to pageSize paths.
            const quote = (s: string) => (s.includes(" ") ? `"${s}"` : s);
            const pageSize = Math.min(linesArg ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
            const skip = fromArg ?? 0;

            const tailPart = skip > 0 ? ` | tail -n +${skip + 1}` : "";
            const cmd = `cd ${quote(resolvedPath)} && find . ${expr.map(quote).join(" ")}${tailPart} | head -n ${pageSize} | sed 's|^\\./||' | tree --fromfile -A --noreport`;

            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execAsync = promisify(exec);

            try {
                const startTime = Date.now();
                const { stdout, stderr } = await execAsync(cmd, {
                    encoding: "utf-8",
                    timeout: 30_000,
                    maxBuffer: 1024 * 1024,
                });
                const elapsedMs = Date.now() - startTime;
                const elapsedSec = (elapsedMs / 1000).toFixed(2);

                let output = stdout.trim() || stderr.trim();

                // If tail produced no output (skip beyond total paths),
                // tree gets no input and produces nothing meaningful.
                if (!output || output === ".") {
                    output = `(no more results — end of output, took ${elapsedSec}s)`;
                    ctx.ui.notify(output, "info");
                    return;
                }

                // Paging was applied at the input level (tail | head),
                // so tree output is already bounded to the current page.
                const footerParts: string[] = [];

                if (skip > 0) {
                    footerParts.push(`(showing paths ${skip + 1}–${skip + pageSize})`);
                } else {
                    footerParts.push(`(showing up to ${pageSize} paths)`);
                }

                footerParts.push(`└─ more results — use --from ${skip + pageSize} for the next page`);
                footerParts.push(`(took ${elapsedSec}s)`);

                if (footerParts.length > 0) {
                    output += "\n" + footerParts.join(" ");
                }

                const lines = output.split("\n");
                if (lines.length <= 5) {
                    ctx.ui.notify(output, "info");
                } else {
                    const remaining = lines.length - 3;
                    ctx.ui.notify(
                        `${lines.slice(0, 3).join("\n")}\n... (${lines.length - 3} lines shown, ${remaining} remaining, took ${elapsedSec}s)`,
                        "info",
                    );
                }
            } catch (e: unknown) {
                const err = e as { stderr?: string; stdout?: string; message?: string };
                const msg =
                    err.stderr?.trim() ||
                    err.stdout?.trim() ||
                    err.message ||
                    String(e);
                if (msg.includes("command not found") || msg.includes("not found")) {
                    ctx.ui.notify(
                        "`tree` command required. Install with: apt install tree, brew install tree, or choco install tree",
                        "error",
                    );
                } else {
                    ctx.ui.notify(msg, "error");
                }
            }
        },
    });
}