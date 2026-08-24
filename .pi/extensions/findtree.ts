/**
 * findtree — search with `find`, display results as a compact ASCII tree.
 *
 * Token-efficient alternative to the built-in `find` tool for broad searches
 * spanning many subdirectories: `tree --fromfile` collapses repeated parent
 * prefixes into a single hierarchy, producing far fewer tokens.
 *
 * Usage (LLM):  findtree path [expressions...]
 * Usage (user): /findtree . -type f -name "*.ts"
 *
 * Requirements: `find` (findutils) and `tree` installed on the system.
 *
 * @version 1.1.0
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
});

type FindTreeInput = Static<typeof findtreeSchema>;

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
            { path: searchDir, expressions }: FindTreeInput,
            signal?: AbortSignal,
            _onUpdate?: unknown,
            _ctx?: unknown,
        ) {
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

            // Build find arguments: always from `.` (cwd handles the directory)
            const findArgs = ["."];
            if (expressions && expressions.length > 0) {
                findArgs.push(...expressions);
            }

            return new Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }>(
                (resolve, reject) => {
                    let done = false;
                    let findChild: ReturnType<typeof spawn> | null = null;
                    let sedChild: ReturnType<typeof spawn> | null = null;
                    let treeChild: ReturnType<typeof spawn> | null = null;
                    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

                    const abortHandler = () => {
                        if (done) return;
                        done = true;
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        if (sedChild && !sedChild.killed) sedChild.kill();
                        if (findChild && !findChild.killed) findChild.kill();
                        reject(new Error("Operation aborted"));
                    };
                    signal?.addEventListener("abort", abortHandler, { once: true });

                    // ── Spawn pipeline: find | sed | tree --fromfile ──
                    // `find .` outputs paths prefixed with './', but `tree --fromfile`
                    // only handles bare relative paths (e.g., '.pi/file' not './.pi/file').
                    findChild = spawn("find", findArgs, {
                        cwd: resolvedPath,
                        stdio: ["ignore", "pipe", "pipe"],
                    });

                    sedChild = spawn("sed", ["s|^\\./||"], {
                        cwd: resolvedPath,
                        stdio: ["pipe", "pipe", "pipe"],
                    });

                    treeChild = spawn("tree", ["--fromfile", "-A", "--noreport"], {
                        cwd: resolvedPath,
                        stdio: ["pipe", "pipe", "pipe"],
                    });

                    // Pipe find's stdout into sed's stdin, then sed's stdout into tree's stdin
                    findChild.stdout.pipe(sedChild.stdin);
                    sedChild.stdout.pipe(treeChild.stdin);

                    // 30-second timeout
                    timeoutHandle = setTimeout(() => {
                        if (done) return;
                        done = true;
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        if (sedChild && !sedChild.killed) sedChild.kill();
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
                        if (trimmed && trimmed !== ".") {
                            resolve({
                                content: [{ type: "text", text: trimmed }],
                                details: {},
                            });
                        } else {
                            const err = stderr.trim();
                            if (err) {
                                reject(new Error(err));
                            } else {
                                resolve({
                                    content: [{ type: "text", text: "(no results)" }],
                                    details: {},
                                });
                            }
                        }
                    };

                    treeChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (sedChild && !sedChild.killed) sedChild.kill();
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
                        if (treeChild && !treeChild.killed) treeChild.kill();

                        const msg = err.message.includes("spawn find ENOENT")
                            ? "`find` command is required (part of GNU findutils)"
                            : err.message;
                        reject(new Error(msg));
                    });

                    sedChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        if (findChild && !findChild.killed) findChild.kill();
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        reject(new Error(err.message));
                    });

                    // Track all three process exits to prevent pipeline deadlocks.
                    // Each finished process closes the stdin of its downstream stage
                    // so no process hangs waiting for input that will never come.
                    let findClosed = false;
                    let sedClosed = false;
                    let treeClosed = false;
                    const maybeFinish = () => {
                        if (findClosed && sedClosed && treeClosed) finish();
                    };

                    findChild.on("close", () => {
                        findClosed = true;
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

            if (!output || output === "(no results)") {
                text.setText(theme.fg("muted", "(no results)"));
                return text;
            }

            const lines = output.split("\n");
            if (options.expanded) {
                text.setText(`\n${theme.fg("toolOutput", output)}`);
            } else {
                const maxPreview = 20;
                const preview = lines.slice(0, maxPreview);
                const remaining = lines.length - maxPreview;
                let display = `\n${preview.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
                if (remaining > 0) {
                    display += `\n${theme.fg("muted", `└─ (${remaining} more lines — expand to view all)`)}`;
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
        description: "Find files and display as a compact ASCII tree (find | tree --fromfile)",
        handler: async (args: string, ctx) => {
            const parts = args.trim().split(/\s+/);
            const rawPath = parts[0] || ".";
            // Resolve to absolute path for cwd
            const resolvedPath = resolve(rawPath);
            const expr = parts.slice(1);

            // Build shell-quoted command
            // We cd into the search dir so `find .` outputs ./path/file, then we
            // strip the `./` prefix with sed for tree --fromfile compatibility.
            const quote = (s: string) => (s.includes(" ") ? `"${s}"` : s);
            const cmd = `cd ${quote(resolvedPath)} && find . ${expr.map(quote).join(" ")} | sed 's|^\\./||' | tree --fromfile -A --noreport`;

            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execAsync = promisify(exec);

            try {
                const { stdout, stderr } = await execAsync(cmd, {
                    encoding: "utf-8",
                    timeout: 30_000,
                    maxBuffer: 1024 * 1024,
                });
                const output = stdout.trim() || stderr.trim() || "(no results)";

                const lines = output.split("\n");
                if (lines.length <= 5) {
                    ctx.ui.notify(output, "info");
                } else {
                    ctx.ui.notify(
                        `${lines.slice(0, 3).join("\n")}\n... (${lines.length - 3} more lines)`,
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