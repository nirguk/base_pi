/**
 * pi-size-hello — greet a container join with a deterministic size report.
 *
 * USE
 * ---
 * Joining a project container always starts the same way: the agent reads the
 * project's README.md. This extension treats that read as the hello and
 * appends a short size report to the read result, so every agent that joins
 * sees the same up-front facts: how many source files, how many lines and
 * characters (with a rough token estimate), plus the project's own method-map
 * summary line when that command runs cleanly. It also shows a short note
 * to the person watching, so they can see what was shared and the key
 * numbers without opening the full read result.
 *
 * The report is informational only. It never blocks the read, never edits
 * files, and never fails the turn: anything that goes wrong (missing config,
 * stopped container, slow map command) silently degrades to a shorter report
 * or no report at all.
 *
 * CONVENTIONS
 * ----------
 * - One project entry per repo in `.pi/size-hello.json`, keyed by its host
 *   path (e.g. "/workspaces/PlantWise"). Fields: alias (the pi-projects
 *   name used to find the live container), label (shown in the report),
 *   exts (file endings to count, e.g. [".cs"]), containerPath (working
 *   folder inside the container), mapCommand (argv run inside the container
 *   whose stdout must contain a "TOTAL ..." line), mapTimeoutMs.
 * - Only an exact README.md read fires the hook (case-insensitive pair:
 *   README.md / readme.md). Deeper doc reads stay quiet.
 * - Repeat reads within 30 seconds stay quiet; anything older reports again.
 * - Build folders are never counted: obj, bin, node_modules, .git, publish.
 * - Tokens are a rough chars-divided-by-four estimate, not a tokenizer count.
 * - The map command runs as the vscode user with a bounded timeout and a
 *   capped output buffer; its failure only drops the map line.
 *
 * MANUAL USE
 * ----------
 * `/size-hello /workspaces/PlantWise` prints the same report on demand.
 * With no argument it reports the first configured project.
 *
 * ADDING A PROJECT
 * ----------------
 * Add one block to `.pi/size-hello.json` with the host path, alias, label,
 * counted endings, and (optionally) a map command that prints a TOTAL line.
 * No code change needed here.
 *
 * @version 1.1.0
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

type ProjectConfig = {
	alias: string;
	label: string;
	exts: string[];
	containerPath?: string;
	mapCommand?: string[];
	mapTimeoutMs?: number;
};

type SizeHelloConfig = { projects: Record<string, ProjectConfig> };

const CONFIG_PATH = "/workspaces/base_pi/.pi/size-hello.json";
const SKIP_DIRS = new Set(["obj", "bin", "node_modules", ".git", "publish"]);

// Short dedupe window: repeat README reads within 30 seconds stay quiet
// (offset paging, re-reads). Anything older reports again, every session.
const greeted = new Map<string, number>();
const DEDUPE_MS = 30_000;

async function loadConfig(): Promise<SizeHelloConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as SizeHelloConfig;
	} catch {
		return { projects: {} };
	}
}

async function walk(dir: string, exts: string[], out: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			await walk(join(dir, e.name), exts, out);
		} else if (exts.some((ext) => e.name.endsWith(ext))) {
			out.push(join(dir, e.name));
		}
	}
}

async function sizeReport(root: string, cfg: ProjectConfig): Promise<{ text: string; note: string }> {
	// Count first, map second: the count is cheap and local (a partial count
	// beats a failed turn, so unreadable files below are skipped), while the
	// map command may take a minute inside the container on first build.
	const files: string[] = [];
	await walk(root, cfg.exts, files);
	files.sort();
	let lines = 0;
	let chars = 0;
	for (const f of files) {
		try {
			const text = await readFile(f, "utf8");
			chars += text.length;
			lines += text.split("\n").length;
		} catch {
			// Unreadable file: skip, never fail the report.
		}
	}
	const tokens = Math.round(chars / 4);
	const fmt = (n: number) => n.toLocaleString("en-US");
	let text =
		`[size-hello] ${cfg.label}: ${files.length} source files, ` +
		`${fmt(lines)} lines, ${fmt(chars)} chars (~${fmt(tokens)} tokens)`;
	const mapTotal = await mapSummary(cfg);
	if (mapTotal) text += `\n[size-hello] method map: ${mapTotal}`;
	// Short note for the person watching: says what was shared and the key
	// numbers in plain words. The full detail stays in the read result.
	let note =
		`Shared ${cfg.label} size with the model: ${files.length} files, ` +
		`${fmt(lines)} lines (~${fmt(tokens)} tokens).`;
	if (mapTotal) note += ` Map says: ${mapTotal}.`;
	return { text, note };
}

function dockerExec(
	container: string,
	user: string,
	cwd: string,
	command: string[],
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"docker",
			["exec", "-u", user, "-w", cwd, container, ...command],
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(String(stderr || error.message)));
				else resolve(String(stdout));
			},
		);
		void child;
	});
}

async function mapSummary(cfg: ProjectConfig): Promise<string | null> {
	if (!cfg.mapCommand || cfg.mapCommand.length === 0) return null;
	try {
		const require = createRequire(__filename);
		const { resolveContainer } = require("/workspaces/base_pi/.pi/scripts/pi-projects.js") as {
			resolveContainer: (alias: string) => { name: string | null; path: string; resolved: boolean };
		};
		const resolved = resolveContainer(cfg.alias);
		if (!resolved.resolved || !resolved.name) return null;
		const out = await dockerExec(
			resolved.name,
			"vscode",
			cfg.containerPath ?? resolved.path,
			cfg.mapCommand,
			cfg.mapTimeoutMs ?? 120000,
		);
		const total = out.split("\n").find((l) => l.startsWith("TOTAL "));
		return total ? total.trim() : null;
	} catch {
		return null;
	}
}

function projectFor(readPath: string, projects: Record<string, ProjectConfig>): [string, ProjectConfig] | null {
	for (const [root, cfg] of Object.entries(projects)) {
		if (readPath === `${root}/README.md` || readPath === `${root}/readme.md`) return [root, cfg];
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	// The hello hook: watch finished `read` calls, and only exact README
	// reads under a configured root. Everything else falls through untouched.
	pi.on("tool_result", async (event: any, ctx: any) => {
		try {
			if (event.toolName !== "read") return;
			const readPath = String(event.input?.path ?? "");
			if (!readPath) return;
			const { projects } = await loadConfig();
			const match = projectFor(readPath, projects);
			if (!match) return;
			const [root, cfg] = match;
			const key = `${root}`;
			const now = Date.now();
			if (now - (greeted.get(key) ?? 0) < DEDUPE_MS) return;
			greeted.set(key, now);
			const { text, note } = await sizeReport(root, cfg);
			try {
				await ctx?.ui?.notify?.(note, "info");
			} catch {
				// The visible note is best effort: never fail the read over it.
			}
			const content = Array.isArray(event.content) ? event.content : [];
			return { content: [...content, { type: "text", text }] };
		} catch {
			return;
		}
	});

	pi.registerCommand("size-hello", {
		description: "Print the deterministic size report for a configured project path.",
		handler: async (args: string, ctx: any) => {
			const { projects } = await loadConfig();
			const target = (args || "").trim() || Object.keys(projects)[0] || "";
			const cfg = projects[target];
			if (!cfg) {
				ctx.ui.notify(`size-hello: no project configured for '${target}'.`, "warning");
				return;
			}
			const { text } = await sizeReport(target, cfg);
			ctx.ui.notify(text, "info");
		},
	});
}

// Force CommonJS resolution for createRequire targets.
export {};
