# @adamjen/pi-compact-fast

**`/compact-fast` command for Pi** — compact your session using a fast local model instead of your main conversation model.

## What it does

Pi normally uses your current conversation model for compaction (summarizing the session). This extension adds `/compact-fast` which:

1. Looks up `qwen-35b-moe` from your configured models (`models.json`)
2. Uses that model directly via a separate API call to generate the summary
3. Returns the structured summary to Pi's built-in compaction system

This saves tokens on expensive models and speeds up compaction when using a smaller/faster local model.

## Install

```bash
pi install npm:@adamjen/pi-compact-fast@latest
```

Or try without installing:

```bash
pi -e npm:@adamjen/pi-compact-fast
```

## Usage

```
/compact-fast
```

That's it — Pi will compact the session using `qwen-35b-moe` instead of your current model.

## Configure a different model

Edit `extensions/index.ts` and change line 24:

```ts
const COMPACT_MODEL_ID = "your-model-id";
```

The model must be defined in your `~/.pi/agent/models.json` or provider config.

## How it works

1. Intercepts `session_before_compact` event
2. Makes a direct API call to the target model via `completeSimple()` from `@mariozechner/pi-ai`
3. Returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` which Pi uses for compaction

### Prompt structure (mirrors pi's native compaction)

- **System prompt** tells model to ONLY summarize, not continue conversation
- **Conversation comes BEFORE instructions** — the model follows the last pattern
- **Previous summary** in `<previous-summary>` tags between conversation and instructions (for incremental updates)
- **Split turns** generate two summaries merged with separator (mirrors pi's native behavior)
- **File operations** tracked in both summary text AND `details` object

## Changelog

### 2.0.0 — Major rewrite

- ✅ Guard against empty content — aborts cleanly instead of writing garbage "empty conversation" summary
- ✅ File operations tracking — `<read-files>` and `<modified-files>` tags appended to summary, plus `details` object for pi's internal tracking
- ✅ Split turn handling — parallel dual summaries with proper merge separator when a single turn exceeds `keepRecentTokens`
- ✅ Correct token budgets — dynamic from `settings.reserveTokens * 0.8` / `* 0.5` instead of hardcoded 8192
- ✅ Added `TURN_PREFIX_SUMMARIZATION_PROMPT` for split-turn prefix summaries (different format: "Original Request", "Early Progress")
- ✅ Switched from `complete()` to `completeSimple()` — matches pi's internal API usage
- ✅ Added `stopReason === "error"` check — handles API failures gracefully instead of producing empty strings
- ✅ Removed debug logging (`console.error`)
- ⚠️ Default model changed from `qwen3.6-35b` to `qwen-35b-moe` (configure your own in models.json)

### 1.x — Initial release

- Basic compaction using a fast local model via direct API call

## License

MIT
