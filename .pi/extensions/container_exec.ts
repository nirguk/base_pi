/**
 * container_exec — run a command inside a registered project devcontainer.
 *
 * Preferred over `pi-run` in bash for agent use: structured args (no shell
 * quoting bugs), clear errors, and automatic session naming.
 *
 * Usage (LLM): container_exec { alias: "congruent_roster", command: ["python3", "-m", "pytest"] }
 *
 * Naming: sets the session display name to the alias (same as `/name <alias>`)
 * when it differs, so cross-container work is easy to find in `/resume`.
 *
 * Resolver lives in `.pi/scripts/pi-projects.js` (shared with `pi-run`).
 *
 * @version 1.0.0
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Type, type Static } from "typebox";

const containerExecSchema = Type.Object({
	alias: Type.String({ description: "Registered project alias, e.g. 'congruent_roster'" }),
	command: Type.Array(Type.String(), {
		description: "Command + args to run inside the container, e.g. ['python3','-m','pytest']",
	}),
	user: Type.Optional(Type.String({ description: "User to run as inside the container (docker exec -u). Defaults to container root." })),
	env: Type.Optional(
		Type.Array(Type.String(), { description: "Env vars as KEY=VAL entries (docker exec -e). Repeatable." }),
	),
	workdir: Type.Optional(Type.String({ description: "Working directory inside the container. Defaults to the registered project path." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Default 120, max 600." })),
});

type ContainerExecInput = Static<typeof containerExecSchema>;

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

const require = createRequire(__filename);
// Shared resolver — same logic `pi-run` uses, so the two cannot drift apart.
const { resolveContainer } = require("/workspaces/base_pi/.pi/scripts/pi-projects.js") as {
	resolveContainer: (alias: string) => { name: string | null; path: string; resolved: boolean; via: string };
};

export default function (pi: ExtensionAPI) {
	const definition: ToolDefinition<typeof containerExecSchema> = {
		name: "container_exec",
		label: "container_exec",
		description:
			"Run a command inside a registered project devcontainer (e.g. congruent_roster). " +
			"Prefer this over `pi-run` in bash: structured args avoid quoting bugs, errors are clear, " +
			"and the session is auto-named after the container alias.",
		parameters: containerExecSchema,

		async execute(_toolCallId, input: ContainerExecInput, signal?: AbortSignal) {
			const { alias, command, user, env, workdir, timeout } = input;

			if (!alias?.trim()) {
				return { content: [{ type: "text" as const, text: "Missing alias." }], details: {}, isError: true };
			}
			if (!command || command.length === 0) {
				return { content: [{ type: "text" as const, text: "Missing command." }], details: {}, isError: true };
			}

			// Auto-name the session after the container. Cheap: header update only.
			try {
				if (pi.getSessionName() !== alias) pi.setSessionName(alias);
			} catch {
				// Naming is best-effort; never fail execution on it.
			}

			let resolved: { name: string | null; path: string; resolved: boolean; via: string };
			try {
				resolved = resolveContainer(alias);
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Could not resolve alias '${alias}': ${(err as Error).message}` }],
					details: {},
					isError: true,
				};
			}

			if (!resolved?.name) {
				return {
					content: [{ type: "text" as const, text: `Unknown project alias '${alias}'. Check \`pi-projects list\`.` }],
					details: {},
					isError: true,
				};
			}

			const cwd = workdir?.trim() || resolved.path;
			const timeoutMs = Math.min(Math.max((timeout ?? DEFAULT_TIMEOUT_S) * 1000, 1000), MAX_TIMEOUT_S * 1000);

			const args = ["-n", "docker", "exec", "-w", cwd];
			if (user?.trim()) args.push("-u", user.trim());
			for (const e of env ?? []) {
				if (!e.includes("=")) {
					return {
						content: [{ type: "text" as const, text: `Bad env entry '${e}': expected KEY=VAL.` }],
						details: {},
						isError: true,
					};
				}
				args.push("-e", e);
			}
			args.push(resolved.name, ...command);

			if (signal?.aborted) throw new Error("Operation aborted");

			return new Promise((resolve, reject) => {
				let done = false;
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				const child = spawn("sudo", args, { stdio: ["ignore", "pipe", "pipe"] });

				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
				child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

				const kill = () => { if (!child.killed) child.kill(); };
				const abortHandler = () => {
					if (done) return;
					done = true;
					if (timeoutHandle) clearTimeout(timeoutHandle);
					kill();
					reject(new Error("Operation aborted"));
				};
				signal?.addEventListener("abort", abortHandler, { once: true });

				timeoutHandle = setTimeout(() => {
					if (done) return;
					done = true;
					kill();
					reject(new Error(`container_exec timed out after ${Math.round(timeoutMs / 1000)}s`));
				}, timeoutMs);

				child.on("error", (err: Error) => {
					if (done) return;
					done = true;
					signal?.removeEventListener("abort", abortHandler);
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				child.on("close", (code: number | null) => {
					if (done) return;
					done = true;
					signal?.removeEventListener("abort", abortHandler);
					if (timeoutHandle) clearTimeout(timeoutHandle);

					const out = stdout.trim();
					const errOut = stderr.trim();
					const exitCode = code ?? -1;

					if (exitCode !== 0) {
						const hint = /not running/i.test(errOut) || /no such container/i.test(errOut)
							? ` Container '${resolved.name}' (alias '${alias}') may be stopped — open the project in VS Code first.`
							: "";
						const text = [
							`container_exec failed (exit ${exitCode}) in '${alias}' [${resolved.name}]${hint}`,
							`$ ${command.join(" ")}`,
							out ? `\n--- stdout ---\n${out}` : "",
							errOut ? `\n--- stderr ---\n${errOut}` : "",
						].join("\n").trim();
						resolve({
							content: [{ type: "text" as const, text }],
							details: { alias, container: resolved.name, exitCode },
							isError: true,
						});
						return;
					}

					const text = out || "(no output)";
					resolve({
						content: [{ type: "text" as const, text }],
						details: { alias, container: resolved.name, exitCode },
					});
				});
			});
		},
	};

	pi.registerTool(definition);
}
