/**
 * findtree — search with `fd`, display results as a compact ASCII tree.
 *
 * Token-efficient alternative to the built-in `find` tool for broad searches
 * spanning many subdirectories: `tree --fromfile` collapses repeated parent
 * prefixes into a single hierarchy, producing far fewer tokens.
 *
 * Engine: `fd` (provisioned by pi itself into `.pi/bin/fd` — see pi's
 * tools-manager `ensureTool("fd")`, sharkdp/fd releases). fd walks in
 * parallel and respects `.gitignore`, which makes it ~150x faster than `find`
 * on trees with heavy `node_modules` folders on slow mounts (measured 0.05s
 * vs 9s on this repo). Falls back to `fdfind` on PATH.
 *
 * Paging is applied at the input level: `tail | head` limit the fd results
 * fed to `tree` so only the current page's paths are processed, bounding
 * memory and CPU. Each page shows a self-contained subtree for those paths.
 *
 * Usage (LLM):  findtree path [fd args...]
 * Usage (user): /findtree . --type f --glob "*.ts" --exclude node_modules
 *
 * Requirements: `fd` (or `fdfind`), `tail`, `head`, and `tree` on PATH.
 *
 * @version 2.0.0
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";

// ── Schema ──────────────────────────────────────────────────────────
const findtreeSchema = Type.Object({
    path: Type.Optional(
        Type.String({ description: "Directory to search in (default: current directory '.')" }),
    ),
    args: Type.Optional(
        Type.Array(Type.String(), {
            description:
                "fd arguments, e.g. ['--type', 'f', '--glob', '*.ts', '--exclude', 'node_modules']. Runs as: fd --color=never --hidden <args>. Gitignored files are skipped by default; add '--no-ignore' to include them.",
        }),
    ),
    from: Type.Optional(
        Type.Number({
            description:
                "Skip the first N result paths before building the tree. Default: 0",
        }),
    ),
    lines: Type.Optional(
        Type.Number({
            description:
                "Maximum number of result paths per page. Default: 100. Max: 500.",
        }),
    ),
});

type FindTreeInput = Static<typeof findtreeSchema>;

// ── Constants ─────────────────────────────────────────────────────────
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const PREVIEW_LINES = 20;

// ── fd resolution (mirrors pi's tools-manager lookup order) ──────────
async function resolveFdBinary(): Promise<string | null> {
    const candidates: string[] = [];
    // pi's own bin dir first: $PI_CODING_AGENT_DIR/bin, else ~/.pi/agent/bin
    const agentDir =
        process.env.PI_CODING_AGENT_DIR ||
        process.env.XDG_CONFIG_HOME ||
        join(homedir(), ".pi", "agent");
    candidates.push(join(agentDir, "bin", "fd"));
    // Common system names
    candidates.push("fd", "fdfind");
    for (const c of candidates) {
        if (c.includes("/")) {
            try {
                await fsAccess(c);
                return c;
            } catch {
                continue;
            }
        } else {
            // Bare name: probe via `command -v` semantics using spawn would be
            // async-heavy here; return it and let spawn report ENOENT with a
            // friendly message. Prefer "fd" over "fdfind" by order.
            return c;
        }
    }
    return null;
}

// ── Tool Definition ─────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
    const definition: ToolDefinition<typeof findtreeSchema> = {
        name: "findtree",
        label: "findtree",
        description:
            "Search for files with `fd` and display results as a compact ASCII tree. " +
            "More token-efficient than the built-in `find` tool for searches spanning many " +
            "subdirectories: `tree --fromfile` collapses repeated parent-directory prefixes " +
            "into a single hierarchy. Takes native fd arguments " +
            "(e.g. --type f, --glob '*.ts', --exclude node_modules, -d 3). " +
            "Hidden files are included; gitignored files are skipped unless --no-ignore is passed. " +
            "Requires `fd` (pi provisions it into .pi/bin) and `tree`.",
        parameters: findtreeSchema,

        async execute(
            _toolCallId: string,
            { path: searchDir, args: fdArgs, from, lines }: FindTreeInput,
            signal?: AbortSignal,
            _onUpdate?: unknown,
            _ctx?: unknown,
        ) {
            const startTime = Date.now();

            const rawPath = searchDir?.trim() || ".";
            const resolvedPath = resolve(rawPath);

            // Verify the resolved path exists and is a directory before spawning
            try {
                const st = await fsStat(resolvedPath);
                if (!st.isDirectory()) {
                    return {
                        content: [{ type: "text" as const, text: `Not a directory: ${rawPath}` }],
                        details: {},
                    };
                }
            } catch {
                return {
                    content: [{ type: "text" as const, text: `Path not found: ${rawPath}` }],
                    details: {},
                };
            }

            if (signal?.aborted) throw new Error("Operation aborted");

            const rawPageSize = lines ?? DEFAULT_PAGE_SIZE;
            const rawSkip = from ?? 0;
            const pageSize = Number.isFinite(rawPageSize)
                ? Math.min(Math.max(Math.floor(rawPageSize), 1), MAX_PAGE_SIZE)
                : DEFAULT_PAGE_SIZE;
            const skip = Number.isFinite(rawSkip) ? Math.max(Math.floor(rawSkip), 0) : 0;

            // fd base flags: plain output, include hidden (like pi's own find
            // tool), keep gitignore respected (the speed win: node_modules is
            // gitignored so fd skips the slow mount). --no-require-git keeps
            // ignore rules working outside git repos.
            const userArgs = fdArgs ?? [];
            const baseArgs = ["--color=never", "--hidden", "--no-require-git"];
            const fullFdArgs = [...baseArgs, ...userArgs];

            const fdBin = (await resolveFdBinary()) ?? "fd";

            return new Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }>(
                (resolve, reject) => {
                    let done = false;
                    let fdChild: ReturnType<typeof spawn> | null = null;
                    let tailChild: ReturnType<typeof spawn> | null = null;
                    let headChild: ReturnType<typeof spawn> | null = null;
                    let treeChild: ReturnType<typeof spawn> | null = null;
                    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

                    const killAll = () => {
                        if (treeChild && !treeChild.killed) treeChild.kill();
                        if (headChild && !headChild.killed) headChild.kill();
                        if (tailChild && !tailChild.killed) tailChild.kill();
                        if (fdChild && !fdChild.killed) fdChild.kill();
                    };

                    const abortHandler = () => {
                        if (done) return;
                        done = true;
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        killAll();
                        reject(new Error("Operation aborted"));
                    };
                    signal?.addEventListener("abort", abortHandler, { once: true });

                    // ── Spawn pipeline: fd | [tail | head] | tree --fromfile ──
                    // fd already prints bare relative paths, so no sed stage.
                    fdChild = spawn(fdBin, fullFdArgs, {
                        cwd: resolvedPath,
                        stdio: ["ignore", "pipe", "pipe"],
                    });

                    // Input-level paging: skip and limit paths BEFORE they reach tree.
                    // This bounds memory and CPU — tree only processes the current page.
                    const useTail = skip > 0;

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

                    treeChild = spawn("tree", ["--fromfile", "--charset", "ascii", "--noreport"], {
                        cwd: resolvedPath,
                        stdio: ["pipe", "pipe", "pipe"],
                    });

                    // Pipe fd's stdout into the paging stage(s), then into tree
                    if (useTail) {
                        fdChild.stdout.pipe(tailChild!.stdin);
                        tailChild!.stdout.pipe(headChild.stdin);
                    } else {
                        fdChild.stdout.pipe(headChild.stdin);
                    }
                    headChild.stdout.pipe(treeChild.stdin);

                    // 30-second timeout
                    timeoutHandle = setTimeout(() => {
                        if (done) return;
                        done = true;
                        killAll();
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
                    fdChild.stderr?.on("data", (chunk: Buffer) => {
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

                        let resultText = trimmed;
                        const footerParts: string[] = [];

                        if (skip > 0) {
                            footerParts.push(`(showing paths ${skip + 1}–${skip + pageSize})`);
                        } else {
                            footerParts.push(`(showing up to ${pageSize} paths)`);
                        }

                        footerParts.push(`└─ page ends here — if more results exist, use --from ${skip + pageSize} for the next page`);
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
                        killAll();

                        const msg = err.message.includes("spawn tree ENOENT")
                            ? "`tree` command is required. Install with: apt install tree, brew install tree, or choco install tree"
                            : err.message;
                        reject(new Error(msg));
                    });

                    fdChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        killAll();

                        const msg = err.message.includes("ENOENT")
                            ? "`fd` command is required (pi provisions it into .pi/bin; or apt install fd-find, brew install fd)"
                            : err.message;
                        reject(new Error(msg));
                    });

                    if (tailChild) {
                        tailChild.on("error", (err: Error) => {
                            if (done) return;
                            done = true;
                            signal?.removeEventListener("abort", abortHandler);
                            if (timeoutHandle) clearTimeout(timeoutHandle);
                            killAll();
                            reject(new Error(err.message));
                        });
                    }

                    headChild.on("error", (err: Error) => {
                        if (done) return;
                        done = true;
                        signal?.removeEventListener("abort", abortHandler);
                        if (timeoutHandle) clearTimeout(timeoutHandle);
                        killAll();
                        reject(new Error(err.message));
                    });

                    // Track all process exits to prevent pipeline deadlocks.
                    // Each finished process closes the stdin of its downstream stage
                    // so no process hangs waiting for input that will never come.
                    let fdClosed = false;
                    // No tail stage when skip === 0, so mark it closed up front.
                    let tailClosed = !useTail;
                    let headClosed = false;
                    let treeClosed = false;
                    const maybeFinish = () => {
                        if (fdClosed && tailClosed && headClosed && treeClosed) finish();
                    };

                    fdChild.on("close", () => {
                        fdClosed = true;
                        if (tailChild && !tailChild.killed) tailChild.stdin.end();
                        else if (headChild && !headChild.killed) headChild.stdin.end();
                        maybeFinish();
                    });
                    if (tailChild) {
                        tailChild.on("close", () => {
                            tailClosed = true;
                            if (headChild && !headChild.killed) headChild.stdin.end();
                            maybeFinish();
                        });
                    }
                    headChild.on("close", () => {
                        headClosed = true;
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
                args.args && args.args.length > 0
                    ? ` ${args.args.join(" ")}`
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
                if (line.startsWith("└─ more results") || line.startsWith("└─ page ends") || line.startsWith("(showing") || line.startsWith("(took")) {
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
                const maxPreview = PREVIEW_LINES;
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
            "Find files with fd and display as a compact ASCII tree. Native fd args (e.g. --type f --glob '*.ts' --exclude node_modules -d 3). Paging: --from N (skip first N paths) and --lines N (paths per page, default 100, max 500). Gitignored files are skipped unless --no-ignore is passed.",
        handler: async (args: string, ctx) => {
            // Parse --from and --lines flags before passing remaining args to fd.
            // First positional token is the search path; the rest are fd args.
            const allParts = args.trim().split(/\s+/).filter(Boolean);
            let fromArg: number | undefined;
            let linesArg: number | undefined;
            const fdParts: string[] = [];

            for (let i = 0; i < allParts.length; i++) {
                if (allParts[i] === "--from" && i + 1 < allParts.length) {
                    fromArg = parseInt(allParts[++i], 10);
                } else if (allParts[i] === "--lines" && i + 1 < allParts.length) {
                    linesArg = parseInt(allParts[++i], 10);
                } else {
                    fdParts.push(allParts[i]);
                }
            }

            const rawPath = fdParts[0] || ".";
            const resolvedPath = resolve(rawPath);
            const userArgs = fdParts.slice(1);

            // Same sanitising as the tool path: floor, clamp, reject NaN.
            const rawPage = linesArg;
            const rawFrom = fromArg;
            const pageSize = Number.isFinite(rawPage as number)
                ? Math.min(Math.max(Math.floor(rawPage as number), 1), MAX_PAGE_SIZE)
                : DEFAULT_PAGE_SIZE;
            const skip = Number.isFinite(rawFrom as number) ? Math.max(Math.floor(rawFrom as number), 0) : 0;

            // No shell: spawn pipeline fd | [tail] | head | tree.
            const { spawn: spawnCmd } = await import("node:child_process");
            const fdBin = (await resolveFdBinary()) ?? "fd";
            const runStage = (
                cmd: string,
                stageArgs: string[],
            ): import("node:child_process").ChildProcess =>
                spawnCmd(cmd, stageArgs, { cwd: resolvedPath, stdio: ["pipe", "pipe", "pipe"] });

            const fdP = runStage(fdBin, ["--color=never", "--hidden", "--no-require-git", ...userArgs]);
            const tailP = skip > 0 ? runStage("tail", ["-n", `+${skip + 1}`]) : null;
            const headP = runStage("head", ["-n", String(pageSize)]);
            const treeP = runStage("tree", ["--fromfile", "--charset", "ascii", "--noreport"]);

            const startTime = Date.now();
            const timeoutMs = 30_000;
            const killer = setTimeout(() => {
                for (const p of [treeP, headP, tailP, fdP]) p?.kill();
            }, timeoutMs);

            try {
                if (tailP) {
                    fdP.stdout?.pipe(tailP.stdin);
                    tailP.stdout?.pipe(headP.stdin);
                } else {
                    fdP.stdout?.pipe(headP.stdin);
                }
                headP.stdout?.pipe(treeP.stdin);
                fdP.on("close", () => {
                    if (tailP) tailP.stdin?.end();
                    else headP.stdin?.end();
                });
                tailP?.on("close", () => headP.stdin?.end());
                headP.on("close", () => treeP.stdin?.end());

                let stdout = "";
                treeP.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
                let stderr = "";
                for (const p of [fdP, treeP]) p.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
                await new Promise<void>((res, rej) => {
                    treeP.on("close", () => res());
                    treeP.on("error", rej);
                    fdP.on("error", rej);
                });
                clearTimeout(killer);
                const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

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

                footerParts.push(`└─ page ends here — if more results exist, use --from ${skip + pageSize} for the next page`);
                footerParts.push(`(took ${elapsedSec}s)`);

                if (footerParts.length > 0) {
                    output += "\n" + footerParts.join(" ");
                }

                const lines = output.split("\n");
                if (lines.length <= PREVIEW_LINES + 1) {
                    ctx.ui.notify(output, "info");
                } else {
                    ctx.ui.notify(
                        `${lines.slice(0, PREVIEW_LINES).join("\n")}\n... (${lines.length - PREVIEW_LINES} more lines — narrow your fd args or page with --from, took ${elapsedSec}s)`,
                        "info",
                    );
                }
            } catch (e: unknown) {
                clearTimeout(killer);
                const err = e as { stderr?: string; stdout?: string; message?: string };
                const msg =
                    err.stderr?.trim() ||
                    err.stdout?.trim() ||
                    err.message ||
                    String(e);
                if (msg.includes("command not found") || msg.includes("not found") || msg.includes("ENOENT")) {
                    ctx.ui.notify(
                        "`fd` and `tree` are required. pi provisions fd into .pi/bin; tree via: apt install tree, brew install tree, or choco install tree",
                        "error",
                    );
                } else {
                    ctx.ui.notify(msg, "error");
                }
            }
        },
    });
}
