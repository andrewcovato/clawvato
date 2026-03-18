# Prompt Configuration

Prompts are loaded from this directory at startup. They use `{{VARIABLE}}` syntax for dynamic values.

## Template Variables

| Variable | Value | Used In |
|---|---|---|
| `{{NO_RESPONSE}}` | `[NO_RESPONSE]` — sentinel value the bot outputs when it decides not to respond | system.md |

## Editing Prompts

You can edit any prompt file and restart the bot to apply changes. A few rules:

1. **Do not remove template variables** (`{{...}}`). The bot validates at startup that all placeholders are resolved.
2. **Respect output format contracts.** Prompts marked with `OUTPUT CONTRACT` require the model to return a specific format (usually JSON). Removing or changing that instruction will break the code that parses the response.
3. **Test after editing.** Run `npm test` to verify nothing is broken.

## Files

| File | Purpose | Has Format Contract? |
|---|---|---|
| `system.md` | Main bot personality, behavior, and guidelines | No |
| `summary.md` | Drive file summary generation (Haiku) | Yes — JSON `{summary, entities}` |
| `doc-extraction.md` | Fact extraction from documents (Haiku) | Yes — JSON array of fact objects |
| `extraction.md` | Fact extraction from Slack conversations (Haiku) | Yes — JSON `{facts, people}` |
| `reflection.md` | Memory consolidation insights (Haiku) | Yes — JSON array of insight objects |
| `interrupt-classification.md` | Interrupt type classification (Haiku) | Yes — JSON `{type, confidence}` |
