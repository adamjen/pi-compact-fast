/**
 * Compact-Fast Extension
 *
 * Adds a /compact-fast command that uses qwen-35b-moe (from models.json)
 * for compaction instead of the current conversation model.
 *
 * Follows the same pattern as custom-compaction.ts — makes a direct API call
 * to the target model via complete() and returns the summary directly to pi.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

// Model ID defined in ~/.pi/agent/models.json under llama-swap provider
const COMPACT_MODEL_ID = "qwen3.6-35b";

export default function (pi: ExtensionAPI) {
	let useFastModel = false;

	// Register the /compact-fast command
	pi.registerCommand("compact-fast", {
		description: `Manually compact using ${COMPACT_MODEL_ID} (faster/cheaper)`,
		handler: async (_args, ctx) => {
			useFastModel = true;

			if (ctx.hasUI) {
				ctx.ui.notify(`Compaction started with ${COMPACT_MODEL_ID}...`, "info");
			}

			ctx.compact({
				onComplete: () => {
					useFastModel = false;
					if (ctx.hasUI) {
						ctx.ui.notify("Fast compaction completed", "success");
					}
				},
				onError: (error) => {
					useFastModel = false;
					if (ctx.hasUI) {
						ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
					}
				},
			});
		},
	});

	// Intercept compaction and use qwen-35b-moe via direct API call
	pi.on("session_before_compact", async (event, ctx) => {
		if (!useFastModel) {
			return; // Let default compaction handle it
		}

		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// Find the fast compaction model from models.json across all providers
		const availableModels = await ctx.modelRegistry.getAvailable();
		const compactModel = availableModels.find((m) => m.id === COMPACT_MODEL_ID);

		if (!compactModel) {
			ctx.ui.notify(
				`Could not find "${COMPACT_MODEL_ID}" in configured models, using default compaction`,
				"warning",
			);
			useFastModel = false;
			return;
		}

		// Resolve auth for the target model (apiKey + headers from provider config)
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(compactModel);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(`Compaction auth failed: ${auth.error ?? "no API key"}`, "warning");
			useFastModel = false;
			return;
		}

		// Combine all messages for summary
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Compacting ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${compactModel.provider}/${COMPACT_MODEL_ID}...`,
			"info",
		);

		// Convert messages to readable text format and call the model directly
		const conversationText = serializeConversation(convertToLlm(allMessages));
		const previousContext = previousSummary ? `\n\nPrevious session summary for context:\n${previousSummary}` : "";

		const response = await complete(
			compactModel,
			{
				messages: [
					{
						role: "user" as const,
						content: [
							{ type: "text" as const, text: `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`, },
					],
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal },
		);

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		if (!summary.trim()) {
			if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
			useFastModel = false;
			return; // Fall through to default compaction
		}

		// Return the summary directly — pi uses it as-is for compaction
		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore,
			},
		};
	});
}
