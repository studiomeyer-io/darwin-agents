# Darwin Examples

## custom-agent.ts

A complete example of defining a custom agent with evolution, metric weights, and tool access. Shows the full pattern: `defineAgent()` -> configure evolution -> `runAgent()`.

```bash
npx tsx examples/custom-agent.ts
```

Requires Claude CLI installed and authenticated. No API keys or MCP servers needed.

## What to learn from this

- How `defineAgent()` validates and applies defaults
- How `evolution.metrics` weights control what Darwin optimizes for
- How `taskType` enables per-category performance tracking
- The full evolution cycle: run -> evaluate -> detect patterns -> A/B test -> promote or rollback
