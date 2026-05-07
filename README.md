# @adamjen/pi-compact-fast

**`/compact-fast` command for Pi** — compact your session using a fast local model instead of your main conversation model.

## What it does

Pi normally uses your current conversation model for compaction (summarizing the session). This extension adds `/compact-fast` which:

1. Looks up `qwen3.6-35b` from your configured models (`models.json`)
2. Uses that model directly via a separate API call to generate the summary
3. Returns the summary to Pi's built-in compaction system

This saves tokens on expensive models and speeds up compaction when using a smaller/faster local model.

## Install

```bash
pi install npm:@adamjen/pi-compact-fast
```

Or try without installing:

```bash
pi -e npm:@adamjen/pi-compact-fast
```

## Usage

```
/compact-fast
```

That's it — Pi will compact the session using `qwen3.6-35b` instead of your current model.

## Configure a different model

Edit `extensions/index.ts` and change line 14:

```ts
const COMPACT_MODEL_ID = "your-model-id";
```

The model must be defined in your `~/.pi/agent/models.json` or provider config.

## How it works

Follows the same pattern as Pi's [custom-compaction example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts):

1. Intercepts `session_before_compact` event
2. Makes a direct API call to the target model via `complete()` from `@mariozechner/pi-ai`
3. Returns `{ compaction: { summary, ... } }` which Pi uses as-is for compaction

## License

MIT
