/**
 * Compact-Fast Extension
 *
 * Adds a /compact-fast command that uses a fast local model (qwen-35b-moe)
 * for compaction instead of the current conversation model.
 *
 * Mirrors pi's normal compaction structure:
 * - System prompt tells model to ONLY summarize, not continue conversation
 * - Conversation comes BEFORE instructions (model follows last pattern)
 * - Previous summary in <previous-summary> tags between conversation and instructions
 * - Split turns generate two summaries merged with separator
 * - File operations tracked in summary text AND details object
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";

// Model ID defined in ~/.pi/agent/models.json under llama-swap provider
const COMPACT_MODEL_ID = "qwen-35b-moe";

// Mirrors pi's SUMMARIZATION_SYSTEM_PROMPT (from utils.js)
const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

// Mirrors pi's SUMMARIZATION_PROMPT (from compaction.js)
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// Mirrors pi's UPDATE_SUMMARIZATION_PROMPT (from compaction.js)
const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// Mirrors pi's TURN_PREFIX_SUMMARIZATION_PROMPT (from compaction.js)
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ============================================================================
// Vended from pi's compaction/utils.js (not re-exported from package)
// ============================================================================

/** Compute final file lists from file operations. */
function computeFileLists(fileOps: {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Format file operations as XML tags for summary. */
function formatFileOperations(readFiles: string[], modifiedFiles: string[]) {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(
			`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
		);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================

export default function (pi: ExtensionAPI) {
	let useFastModel = false;

	// Register the /compact-fast command
	pi.registerCommand("compact-fast", {
		description: `Manually compact using ${COMPACT_MODEL_ID} (faster/cheaper)`,
		handler: async (_args, ctx) => {
			useFastModel = true;

			if (ctx.hasUI) {
				ctx.ui.notify(
					`Compaction started with ${COMPACT_MODEL_ID}...`,
					"info",
				);
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
		const {
			messagesToSummarize,
			turnPrefixMessages,
			isSplitTurn,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
			fileOps,
			settings,
		} = preparation;

		// Guard against empty content — abort instead of writing garbage summary
		if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
			ctx.ui.notify(
				"Nothing to compact (session below keepRecentTokens)",
				"warning",
			);
			useFastModel = false;
			throw new Error("compact-fast: nothing to summarize");
		}

		// Find the fast compaction model from models.json across all providers
		const availableModels = await ctx.modelRegistry.getAvailable();
		const compactModel = availableModels.find(
			(m) => m.id === COMPACT_MODEL_ID,
		);

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
			ctx.ui.notify(
				`Compaction auth failed: ${auth.error ?? "no API key"}`,
				"warning",
			);
			useFastModel = false;
			return;
		}

		// Use correct token budgets from pi's settings (dynamic, not hardcoded)
		const reserveTokens = settings?.reserveTokens ?? 16384;
		const historyMaxTokens = Math.floor(0.8 * reserveTokens); // ~13107
		const prefixMaxTokens = Math.floor(0.5 * reserveTokens); // ~8192

		// Helper: summarize a set of messages with the fast model
		async function summarize(
			msgs,
			prevSummary,
			isTurnPrefix,
			maxToks,
		) {
			const llmMessages = convertToLlm(msgs);
			const conversationText = serializeConversation(llmMessages);

			let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;

			if (prevSummary && !isTurnPrefix) {
				promptText += `<previous-summary>\n${prevSummary}\n</previous-summary>\n\n`;
			}

			// Pick the right prompt for this summary type
			let instructionPrompt;
			if (isTurnPrefix) {
				instructionPrompt = TURN_PREFIX_SUMMARIZATION_PROMPT;
			} else if (prevSummary) {
				instructionPrompt = UPDATE_PROMPT;
			} else {
				instructionPrompt = SUMMARIZATION_PROMPT;
			}

			promptText += instructionPrompt;

			const response = await completeSimple(
				compactModel,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: promptText }],
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: maxToks, signal },
			);

			// Check stopReason for errors (completeSimple returns structured response)
			if (response.stopReason === "error") {
				throw new Error(
					`compact-fast: ${response.errorMessage || "unknown error"}`,
				);
			}

			const text = response.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			return text;
		}

		ctx.ui.notify(
			`Compacting with ${compactModel.provider}/${COMPACT_MODEL_ID}...`,
			"info",
		);

		let summary: string;

		// Handle split turns (dual summaries, parallel) — mirrors pi's native behavior
		if (isSplitTurn && turnPrefixMessages.length > 0) {
			const [historyResult, prefixResult] = await Promise.all([
				messagesToSummarize.length > 0
					? summarize(
							messagesToSummarize,
							previousSummary,
							false, // not turn prefix
							historyMaxTokens,
						)
					: Promise.resolve("No prior history."),
				summarize(
					turnPrefixMessages,
					null,
					true, // is turn prefix
					prefixMaxTokens,
				),
			]);

			summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixResult}`;
		} else {
			const msgsToUse =
				messagesToSummarize.length > 0
					? messagesToSummarize
					: turnPrefixMessages;

			summary = await summarize(
				msgsToUse,
				previousSummary,
				false, // not turn prefix
				historyMaxTokens,
			);
		}

		if (!summary.trim()) {
			if (!signal.aborted)
				ctx.ui.notify("Compaction summary was empty", "warning");
			useFastModel = false;
			return; // Fall through to default compaction
		}

		// Append file operations AND return details for pi's tracking
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		summary += formatFileOperations(readFiles, modifiedFiles);

		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details: { readFiles, modifiedFiles },
			},
		};
	});
}
