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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
