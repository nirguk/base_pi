/**
 * Remote Control Extension
 *
 * Lets the agent trigger session-level actions on the user's behalf,
 * which is what makes them usable from remote-pi mobile chat where
 * slash commands typed as text are not dispatched.
 *
 * Provides:
 *   /remote-reload  + tool remote_reload      (same flow as /reload)
 *   /remote-new     + tool remote_new         (same flow as /new)
 *   /remote-model   + tool remote_set_model   (switch live LLM model)
 *   /remote-spawn   + tool remote_spawn       (spawn a fresh named headless agent, phone can reach it)
 *   /remote-rename  + tool remote_rename      (set a workspace's persisted remote-pi agent name)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function (pi: ExtensionAPI) {
	// ---------- reload ----------
	pi.registerCommand("remote-reload", {
		description: "Reload extensions, skills, prompts, themes, and context files (remote-friendly /reload)",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	pi.registerTool({
		name: "remote_reload",
		label: "Remote Reload",
		description:
			"Reload pi extensions, skills, prompts, and context files. Use when the user asks to reload or refresh pi from remote chat.",
		parameters: Type.Object({}),
		async execute() {
			pi.sendUserMessage("/remote-reload", { deliverAs: "followUp", expandPromptTemplates: true });
			return {
				content: [{ type: "text", text: "Queued /remote-reload as a follow-up command." }],
			};
		},
	});

	// ---------- new session ----------
	pi.registerCommand("remote-new", {
		description: "Start a fresh session (remote-friendly /new). Optional arg becomes the kickoff message.",
		handler: async (args, ctx) => {
			const kickoff = args.trim() || "Started a fresh session from remote request.";
			const parentSession = ctx.sessionManager.getSessionFile();
			await ctx.newSession({
				parentSession,
				withSession: async (replaced) => {
					// deliverAs is REQUIRED when the replacement agent is still
					// marked processing (interactive/mesh sessions) — without it,
					// sendUserMessage throws "Agent is already processing. Specify
					// streamingBehavior ('steer' or 'followUp') to queue the
					// message." followUp queues the kickoff (wait), which is the
					// non-interrupting, supported choice for a fresh session.
					await replaced.sendUserMessage(kickoff, { deliverAs: "followUp" });
				},
			});
		},
	});

	pi.registerTool({
		name: "remote_new",
		label: "Remote New Session",
		description:
			"Start a fresh session, like /new. Use when the user asks to start over, start fresh, or open a new session from remote chat. Optionally pass a kickoff message for the new session.",
		parameters: Type.Object({
			kickoff: Type.Optional(Type.String({ description: "Message to open the new session with" })),
		}),
		async execute(_id, params) {
			const kickoff = (params as { kickoff?: string }).kickoff ?? "";
			// Queue the command only after the current run has fully settled.
			// Delivering earlier (mid-run, or even at agent_end) can land
			// /remote-new while an LLM request is still in flight — retry,
			// compaction, or a queued follow-up are still legal after agent_end
			// (see extensions.md: agent_end -> "Pi may still auto-retry,
			// auto-compact and retry, or continue with queued follow-up
			// messages"). ctx.newSession then aborts that in-flight operation
			// ("This operation was aborted"), which crashes pi.
			// agent_settled is the final boundary: ctx.isIdle() is true and work
			// requested there is deferred until every settled handler finishes,
			// which matches typing /new while idle — the supported path.
			// Do NOT wait for the settle events inside the tool — the run cannot
			// end while this tool is executing, so that would deadlock.
			const off = pi.on("agent_settled", () => {
				off();
				pi.sendUserMessage(`/remote-new ${kickoff}`.trim(), {
					deliverAs: "followUp",
					expandPromptTemplates: true,
				});
			});
			return {
				content: [{ type: "text", text: "Queued /remote-new as a follow-up command." }],
			};
		},
	});

	// ---------- set live model ----------
	pi.registerCommand("remote-model", {
		description: "Switch the live session model. Usage: /remote-model <provider/model-id or model-id>",
		handler: async (args, ctx) => {
			const spec = args.trim();
			if (!spec) {
				const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
				ctx.ui.notify(`Usage: /remote-model <provider/model-id>. Current: ${cur}`, "warning");
				return;
			}
			const model = resolveModel(ctx as never, spec);
			if (!model) {
				ctx.ui.notify(`Model not found: ${spec}`, "error");
				return;
			}
			const ok = await pi.setModel(model as never);
			if (!ok) ctx.ui.notify(`No auth configured for ${spec}`, "error");
			else ctx.ui.notify(`Model switched to ${spec}`, "info");
		},
	});

	pi.registerTool({
		name: "remote_set_model",
		label: "Remote Set Model",
		description:
			"Switch the live session LLM model. Accepts 'provider/model-id' (e.g. 'openrouter/meta/muse-spark-1.3-contributor') or a bare model id. Use when the user asks to change or update the model from remote chat.",
		parameters: Type.Object({
			model: Type.String({ description: "Model spec, e.g. 'openrouter/my-model' or bare model id" }),
			thinkingLevel: Type.Optional(
				Type.Union([
					Type.Literal("off"),
					Type.Literal("minimal"),
					Type.Literal("low"),
					Type.Literal("medium"),
					Type.Literal("high"),
					Type.Literal("xhigh"),
					Type.Literal("max"),
				]),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { model: spec, thinkingLevel } = params as { model: string; thinkingLevel?: string };
			const model = resolveModel(ctx as never, spec);
			if (!model) {
				return { content: [{ type: "text", text: `Model not found: ${spec}` }] };
			}
			const ok = await pi.setModel(model as never);
			if (!ok) {
				return { content: [{ type: "text", text: `Model found but no auth configured: ${spec}` }] };
			}
			if (thinkingLevel) {
				try {
					pi.setThinkingLevel(thinkingLevel as never);
				} catch {
					// non-fatal: model switched, thinking level unchanged
				}
			}
			return { content: [{ type: "text", text: `Live model switched to ${spec}` }] };
		},
	});

	// ---------- spawn a fresh named agent ----------
	pi.registerTool({
		name: "remote_spawn",
		label: "Remote Spawn Agent",
		description:
			"Spawn a fresh headless remote-pi agent under a chosen name. The agent runs with cwd = its identity folder; if that folder is already named as a different agent the spawn moves to a dedicated subfolder <cwd>/.spawns/<name> with a fresh config, so each named agent owns its own folder + room. Launches detached with the relay auto-started. Use when the user wants a new, separately-named agent from remote chat -- the mobile app cannot spawn a session itself.",
		parameters: Type.Object({
			cwd: Type.String({ description: "Absolute base folder to spawn from/under, e.g. /workspaces/base_pi" }),
			name: Type.Optional(Type.String({ description: "Agent name (defaults to the base folder name). The final folder that owns this agent gets this agent_name." })),
		}),
		async execute(_id, params) {
			const { cwd: rawCwd, name: rawName } = params as { cwd: string; name?: string };
			const baseCwd = validAgentCwd(rawCwd);
			if (!baseCwd) return { content: [{ type: "text", text: `Cwd must be an absolute existing directory: ${rawCwd}` }] };
			const name = sanitizeAgentName(rawName ?? basename(baseCwd));
			if (!name) return { content: [{ type: "text", text: `Invalid name: ${rawName}. Use letters, digits, dot, dash, underscore.` }] };
			// A process is associated with the folder it runs in (its cwd): its name
			// comes from that folder's .pi/remote-pi/config.json and its room is
			// derived from (cwd, name). Never overwrite an existing agent's config.
			const spawnCwd = resolveSpawnFolder(baseCwd, name);
			const cfgFile = ensureRemotePiConfig(spawnCwd, name);
			try {
				const daemonId = startSupervisedDaemon(spawnCwd, name);
				return {
					content: [
						{
							type: "text",
							text: `Spawned supervised agent "${name}" (daemon id ${daemonId}) with cwd=${spawnCwd}, config ${cfgFile}. pi-supervisord manages it (crash auto-restart + cron). Identity anchor = cwd: that folder is its process root, so ps/pid plus cwd associates it. It auto-starts the relay; pair the phone to the same relay URL to see it. Stop/restart with: remote-pi daemon stop|start ${daemonId}.`,
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `Could not start supervised daemon in ${spawnCwd}: ${String(err)}. Ensure pi-supervisord is running.` },
					],
				};
			}
		},
	});
	pi.registerCommand("remote-spawn", {
		description: "Spawn a fresh named headless agent: /remote-spawn <cwd> [name (default: folder name)]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const baseCwd = validAgentCwd(parts[0]);
			if (!baseCwd) {
				ctx.ui.notify(`Usage: /remote-spawn <cwd> [name] -- cwd must be an absolute existing dir`, "error");
				return;
			}
			const name = sanitizeAgentName(parts[1] ?? basename(baseCwd));
			if (!name) {
				ctx.ui.notify(`Invalid name: ${parts[1]}`, "error");
				return;
			}
			const spawnCwd = resolveSpawnFolder(baseCwd, name);
			ensureRemotePiConfig(spawnCwd, name);
			try {
				const daemonId = startSupervisedDaemon(spawnCwd, name);
				ctx.ui.notify(`Spawned supervised agent "${name}" (id ${daemonId}, cwd=${spawnCwd})`, "info");
			} catch (err) {
				ctx.ui.notify(`Could not start supervised daemon in ${spawnCwd}: ${String(err)}`, "error");
			}
		},
	});

	// ---------- rename a workspace's persisted agent name ----------
	pi.registerTool({
		name: "remote_rename",
		label: "Remote Rename Agent",
		description:
			"Set the persisted remote-pi agent_name for an agent's workspace folder (its .pi/remote-pi/config.json). Takes effect for a freshly spawned agent, or on the next restart of a running daemon in that folder; a currently-running interactive agent renames live via its own /remote-pi rename. Use to name-or-rename an agent for a given intended use.",
		parameters: Type.Object({
			cwd: Type.String({ description: "Workspace folder whose agent_name to set, e.g. /workspaces/base_pi" }),
			name: Type.String({ description: "New agent name" }),
		}),
		async execute(_id, params) {
			const { cwd: rawCwd, name: rawName } = params as { cwd: string; name: string };
			const cwd = validAgentCwd(rawCwd);
			if (!cwd) return { content: [{ type: "text", text: `Cwd must be an absolute existing directory: ${rawCwd}` }] };
			const name = sanitizeAgentName(rawName);
			if (!name) return { content: [{ type: "text", text: `Invalid name: ${rawName}. Use letters, digits, dot, dash, underscore.` }] };
			const cfgFile = ensureRemotePiConfig(cwd, name);
			return {
				content: [
					{
						type: "text",
						text: `Set ${cfgFile} agent_name to "${name}". Takes effect on the next spawn / daemon restart in this folder; a running interactive agent there renames live with /remote-pi rename.`,
					},
				],
			};
		},
	});
	pi.registerCommand("remote-rename", {
		description: "Set a workspace's persisted agent name: /remote-rename <cwd> <name>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cwd = validAgentCwd(parts[0]);
			if (!cwd || !parts[1]) {
				ctx.ui.notify(`Usage: /remote-rename <cwd> <name>`, "error");
				return;
			}
			const name = sanitizeAgentName(parts[1]);
			if (!name) {
				ctx.ui.notify(`Invalid name: ${parts[1]}`, "error");
				return;
			}
			ensureRemotePiConfig(cwd, name);
			ctx.ui.notify(`Set ${cwd}/.pi/remote-pi/config.json agent_name to "${name}"`, "info");
		},
	});
}

// biome-ignore lint/suspicious/noExplicitAny: modelRegistry is untyped here by design
function resolveModel(ctx: any, spec: string): unknown {
	const registry = ctx.modelRegistry;
	if (!registry) return null;
	if (spec.includes("/")) {
		const slash = spec.indexOf("/");
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		try {
			return registry.find(provider, id) ?? null;
		} catch {
			return null;
		}
	}
	try {
		const all: Array<{ id?: string; provider?: string }> = registry.getAvailable?.() ?? [];
		return all.find((m) => m.id === spec) ?? null;
	} catch {
		return null;
	}
}

// ---------- remote_spawn / remote_rename helpers ----------

/** Validates a target workspace folder: must be absolute and existing. Returns it or null. */
function validAgentCwd(raw: string | undefined): string | null {
	if (!raw) return null;
	if (!raw.startsWith("/")) return null;
	try {
		if (!existsSync(raw)) return null;
		if (!statSync(raw).isDirectory()) return null;
	} catch {
		return null;
	}
	return raw;
}

/** Normalises an agent name to URL-safe chars; returns null if unusable. */
function sanitizeAgentName(raw: string): string | null {
	const cleaned = raw.trim().replace(/\s+/g, "-");
	if (!cleaned || cleaned.length > 64) return null;
	if (!/^[A-Za-z0-9._-]+$/.test(cleaned)) return null;
	return cleaned;
}

/** Writes (or updates) <cwd>/.pi/remote-pi/config.json with the agent name and relay auto-start. */
function ensureRemotePiConfig(cwd: string, name: string): string {
	const dir = join(cwd, ".pi", "remote-pi");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "config.json");
	let cfg: Record<string, unknown> = {};
	try {
		cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		// no existing config -> start fresh
	}
	cfg.agent_name = name;
	cfg.auto_start_relay = true;
	writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
	return file;
}

/** Reads the agent_name already configured for a folder, or undefined if none/absent. */
function configuredAgentName(cwd: string): string | undefined {
	try {
		const cfg = JSON.parse(readFileSync(join(cwd, ".pi", "remote-pi", "config.json"), "utf8")) as { agent_name?: string };
		return typeof cfg.agent_name === "string" && cfg.agent_name ? cfg.agent_name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Decides the folder an agent actually runs in = its identity anchor. A process
 * is tied to the folder it chdirs into: its name comes from that folder's
 * `.pi/remote-pi/config.json` and its room is derived from (cwd, name). So the
 * association is: cwd == identity. If `baseCwd` is already named as a different
 * agent we must NOT overwrite it -- the new named agent gets a dedicated
 * subfolder `<baseCwd>/.spawns/<name>` with a fresh config, which then becomes
 * its cwd/anchor. If baseCwd is unowned (no config) or already carries the same
 * name, the spawn owns baseCwd directly.
 */
function resolveSpawnFolder(baseCwd: string, name: string): string {
	const existing = configuredAgentName(baseCwd);
	if (existing && existing !== name) return join(baseCwd, ".spawns", name);
	return baseCwd;
}

/** Locates the remote-pi extension's main index across known install paths. */
function resolveRemotePiIndex(): string {
	const candidates: string[] = [];
	try {
		const here = fileURLToPath(import.meta.url);
		candidates.push(join(dirnameHere(here), "../../.pi/npm/node_modules/remote-pi/dist/index.js"));
	} catch {
		// import.meta.url unavailable in some compiled contexts -> fall back below
	}
	candidates.push("/opt/pi-npm-store/npm/node_modules/remote-pi/dist/index.js");
	candidates.push("/workspaces/base_pi/.pi/npm/node_modules/remote-pi/dist/index.js");
	for (const c of candidates) {
		if (c && existsSync(c)) return c;
	}
	return candidates[candidates.length - 1];
}

function dirnameHere(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(0, i) : p;
}

/**
 * Runs a remote-pi CLI subcommand (the actual binary), capturing stdout; throws
 * with its stderr/stdout message on failure. Used to register + start daemons.
 */
function runRemotePi(args: string[]): string {
	const index = resolveRemotePiIndex();
	try {
		return execFileSync(process.execPath, [index, ...args], { encoding: "utf8" }).trim();
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		throw new Error((e.stderr || e.stdout || e.message || String(err)).trim());
	}
}

/**
 * Registers the folder as a named daemon and starts it through pi-supervisord,
 * so the spawned agent is crashed-restart + cron-managed. Returns the daemon id.
 * Requires pi-supervisord to be running (daemon start drives the supervisor UDS).
 */
function startSupervisedDaemon(cwd: string, name: string): string {
	const out = runRemotePi(["create", cwd, "--name", name]);
	const idMatch = /id=([A-Za-z0-9_]+)/.exec(out);
	const id = idMatch ? idMatch[1] : "";
	if (!id) throw new Error(`remote-pi create did not return a daemon id: ${out}`);
	runRemotePi(["daemon", "start", id]);
	return id;
}
