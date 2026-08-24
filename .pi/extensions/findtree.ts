/**
 * findtree — pi native tool: search with `find`, display as ASCII tree.
 *
 * Follows pi.dev's built-in tool pattern (see createFindToolDefinition):
 * - Spawns child processes directly (no bash function wrapper)
 * - Typebox schema for typed parameters
 * - Proper abort signal handling
 * - Custom TUI rendering (renderCall / renderResult)
 * - Registered as both a custom tool (LLM-callable) and a /-command
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { access as fsAccess } from "node:fs/promises";
import { createInterface } from "node:readline";
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
			"Designed to reduce token consumption vs the built-in `find` tool: " +
			"`tree --fromfile` collapses repeated parent-directory prefixes into a single hierarchy, " +
			"so deep/broad directory searches produce far fewer tokens. " +
			"Prefer this tool over the built-in `find` when results are expected to span many subdirectories. " +
			"Accepts the same expressions as `find`. Requires `tree` command to be installed.",
		parameters: findtreeSchema,
		async execute(
			_toolCallId: string,
			{ path: searchDir, expressions }: FindTreeInput,
			signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: unknown,
		) {
			const searchPath = searchDir?.trim() || ".";

			// Check path exists
			try {
				await fsAccess(searchPath);
			} catch {
				return {
					content: [{ type: "text" as const, text: `Path not found: ${searchPath}` }],
					details: {},
				};
			}

			if (signal?.aborted) throw new Error("Operation aborted");

			return new Promise((resolve, reject) => {
				let settled = false;
				let treeChild: ReturnType<typeof spawn> | null = null;
				let findChild: ReturnType<typeof spawn> | null = null;
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					if (timeoutHandle) clearTimeout(timeoutHandle);
					fn();
				};

				const onAbort = () => {
					if (treeChild && !treeChild.killed) treeChild.kill();
					if (findChild && !findChild.killed) findChild.kill();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				// Build find args: find [path] [expressions...]
				const findArgs = [searchPath];
				if (expressions && expressions.length > 0) {
					findArgs.push(...expressions);
				}

				// Spawn `find`, pipe into `tree --fromfile -A --noreport`
				findChild = spawn("find", findArgs, {
					stdio: ["ignore", "pipe", "pipe"],
				});

				treeChild = spawn("tree", ["--fromfile", "-A", "--noreport"], {
					stdio: ["pipe", "pipe", "pipe"],
				});

				findChild.stdout.pipe(treeChild.stdin);

				// 30-second timeout
				timeoutHandle = setTimeout(() => {
					if (treeChild && !treeChild.killed) treeChild.kill();
					if (findChild && !findChild.killed) findChild.kill();
					settle(() => reject(new Error("findtree timed out after 30 seconds")));
				}, 30_000);

				let output = "";
				const rl = createInterface({ input: treeChild.stdout });
				rl.on("line", (line: string) => {
					output += line + "\n";
				});

				let stderr = "";
				treeChild.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				findChild.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				const cleanup = () => {
					rl.close();
				};

				treeChild.on("error", (err: Error) => {
					cleanup();
					const msg = err.message.includes("spawn tree ENOENT")
						? "`tree` command is required. Install with: apt install tree / brew install tree"
						: err.message;
					settle(() => reject(new Error(msg)));
				});

				treeChild.on("close", (_code: number | null) => {
					cleanup();
					if (signal?.aborted) return;

					const trimmed = output.trim();
					if (!trimmed) {
						// tree --fromfile produces nothing when find finds no files
						const errMsg = stderr.trim();
						if (errMsg) {
							settle(() => reject(new Error(errMsg)));
							return;
						}
						settle(() =>
							resolve({
								content: [{ type: "text" as const, text: "(no results)" }],
								details: {},
							}),
						);
						return;
					}

					settle(() =>
						resolve({
							content: [{ type: "text" as const, text: trimmed }],
							details: {},
						}),
					);
				});

				findChild.on("error", (err: Error) => {
					const msg = err.message.includes("spawn find ENOENT")
						? "`find` command is required (part of GNU findutils)"
						: err.message;
					settle(() => reject(new Error(msg)));
				});
			});
		},

		renderCall(
			args: FindTreeInput,
			theme: Record<string, (s: string) => string>,
			context: { lastComponent?: import("@earendil-works/pi-tui").Text },
		) {
			const text = context.lastComponent ?? new Text("", 0, 0);
			const path = args.path || ".";
			const exprStr =
				args.expressions && args.expressions.length > 0 ? ` ${args.expressions.join(" ")}` : "";
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
			const output =
				result.content?.find((c) => c.type === "text")?.text?.trim() || "";

			if (!output) {
				text.setText(theme.fg("muted", "(no results)"));
				return text;
			}

			if (options.expanded) {
				text.setText(`\n${theme.fg("toolOutput", output)}`);
			} else {
				const lines = output.split("\n");
				const maxPreview = 20;
				const preview = lines.slice(0, maxPreview);
				const remaining = lines.length - maxPreview;
				let display = `\n${preview.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
				if (remaining > 0) {
					display += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
				}
				text.setText(display);
			}
			return text;
		},
	};

	// ── Register as a custom tool (LLM-callable via pi's tool system) ──
	pi.registerTool(definition);

	// ── Register as a slash command (user-callable via /findtree) ──────
	pi.registerCommand("findtree", {
		description: "Find files and display as a compact ASCII tree (find | tree --fromfile)",
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/);
			const searchPath = parts[0] || ".";
			const expr = parts.slice(1);

			// Build command string (shell-quoted for safety)
			const findArgs = [searchPath, ...expr].map((a) =>
				a.includes(" ") ? `"${a}"` : a,
			);
			const cmd = `find ${findArgs.join(" ")} | tree --fromfile -A --noreport 2>&1`;

			const { execSync } = await import("node:child_process");
			try {
				const result = execSync(cmd, {
					encoding: "utf-8",
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
				});
				const output = result.trim() || "(no results)";
				// Output to notification area
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
				const err = e as { stdout?: Buffer; stderr?: Buffer };
				const msg = err.stderr?.toString()?.trim() || err.stdout?.toString()?.trim() || String(e);
				ctx.ui.notify(msg.includes("command not found") ? "tree command not found. Install with: apt install tree" : msg, "error");
			}
		},
	});
}