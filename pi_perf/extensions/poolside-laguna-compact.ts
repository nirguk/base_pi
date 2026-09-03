/**
 * Poolside Laguna S 2.1 Compaction Extension
 *
 * Replaces Pi's default compaction summarization with a dedicated call to
 * Poolside's Laguna S 2.1 model. Laguna S 2.1 is a 118B MoE model (~8B
 * active per token) with a 1,048,576-token context window and up to
 * 131,072 completion tokens — designed for agentic coding and long-horizon
 * tool use, making it a strong choice for summarizing coding sessions.
 *
 * Prerequisites — no models.json entry needed. Laguna S 2.1 is available
 * via the built-in OpenRouter provider as poolside/laguna-s-2.1. Just make
 * sure you have OpenRouter auth configured (via /login openrouter or the
 * OPENROUTER_API_KEY environment variable).
 *
 * Then install the extension:
 *   pi --extension examples/extensions/poolside-laguna-compact.ts
 *
 * Or add it to .pi/settings.json:
 *   { "extensions": ["./extensions/poolside-laguna-compact.ts"] }
 *
 * Key design choices explained (see the comments below for tuning):
 *
 * - maxTokens: 16384 — Laguna can handle long inputs, so a 16k output budget
 *   is generous for a thorough structured checkpoint summary while keeping
 *   costs reasonable. Adjust down (4096–8192) for cheaper/faster summaries.
 * - Summarizes only messagesToSummarize (not turnPrefixMessages) by default.
 *   Set INCLUDE_TURN_PREFIX to true if you want the split-turn prefix included.
 * - Preserves previous summary context for iterative compactions.
 * - Falls back to Pi's default compaction if Laguna is unavailable or the
 *   call fails.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// ── Tunable knobs ──────────────────────────────────────────────────

/** Maximum output tokens for the summary. Laguna S 2.1 supports up to
 *  131,072 completion tokens; 16,384 is a generous budget for a thorough
 *  structured checkpoint summary that preserves file paths, error traces,
 *  and next steps. Adjust down (4096–8192) if you want cheaper/faster
 *  summaries, or up if your sessions produce very large summaries. */
const MAX_SUMMARY_TOKENS = 16384;

/** Whether to include the split-turn prefix messages in the summary.
 *  The default compaction already handles split turns by summarizing the
 *  prefix separately and merging. Setting this to true includes them in the
 *  same summarization pass, which is simpler but may lose granularity on
 *  very large turns. */
const INCLUDE_TURN_PREFIX = false;

/** How many recent tokens to keep un-summarized (overrides settings.json
 *  compaction.keepRecentTokens for this extension only). Set to null to use
 *  the configured value. With Laguna's 1M context window, you can afford
 *  a smaller keep boundary (summarize more aggressively) or a larger one
 *  (preserve more recent context). */
const OVERRIDE_KEEP_RECENT_TOKENS: number | null = null;

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
			settings,
		} = preparation;

		// Resolve Laguna S 2.1 from the model registry.
		// The model is served via OpenRouter (as poolside/laguna-s-2.1), so we
		// look up the openrouter provider with the full model path as the ID.
		const model = ctx.modelRegistry.find("openrouter", "poolside/laguna-s-2.1");
		if (!model) {
			ctx.ui.notify(
				"Laguna S 2.1 not found in model registry — falling back to default compaction",
				"warning",
			);
			return; // fall back to Pi's default compaction
		}

		// Build the list of messages to summarize.
		// Default: only messages before the keep boundary.
		// Set INCLUDE_TURN_PREFIX = true to also fold in the split-turn prefix.
		const summarizeMessages = INCLUDE_TURN_PREFIX
			? [...messagesToSummarize, ...turnPrefixMessages]
			: messagesToSummarize;

		if (summarizeMessages.length === 0) {
			return; // nothing to summarize, let default compaction handle it
		}

		ctx.ui.notify(
			`Laguna S 2.1 compaction: summarizing ${summarizeMessages.length} messages (${tokensBefore.toLocaleString()} tokens pre-compaction) with up to ${MAX_SUMMARY_TOKENS.toLocaleString()} output tokens`,
			"info",
		);

		// Serialize conversation to text so the model treats it as a document,
		// not a live conversation to continue.
		const conversationText = serializeConversation(convertToLlm(summarizeMessages));

		// Build the prompt.
		// We include the previous summary for iterative compactions so the
		// model can update/merge rather than re-derive from scratch.
		const previousContext = previousSummary
			? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\nUpdate the previous summary with new information from the conversation below.`
			: "";

		const promptText = `You are a conversation summarizer for a coding agent session. Create a structured context checkpoint summary that another LLM will use to continue the work.${previousContext}

Summarize the conversation below. Preserve exact file paths, function names, error messages, and key decisions. Be thorough but concise — the summary replaces the entire history that produced it.

<conversation>
${conversationText}
</conversation>`;

		const summaryMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: summaryMessages },
				{
					maxTokens: MAX_SUMMARY_TOKENS,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
					// Disable tool calls — summarization should never invoke tools.
					toolChoice: "none",
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) {
					ctx.ui.notify(
						"Laguna S 2.1 returned an empty summary — falling back to default compaction",
						"warning",
					);
				}
				return;
			}

			ctx.ui.notify(`Laguna S 2.1 compaction done — summary is ${summary.length} chars`, "info");

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Laguna S 2.1 compaction failed: ${message} — falling back to default`, "error");
			// Return undefined to fall back to Pi's default compaction behavior.
			return;
		}
	});
}
