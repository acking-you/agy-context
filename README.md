# Context for Antigravity

Inspect your live Antigravity context window in real time from a native sidecar panel, with zero extra LLM calls or token overhead.

![Context panel preview](assets/preview.png)

## Install

```bash
agy plugin install https://github.com/acking-you/agy-context
```

## Features

- **Antigravity-accurate context limit**: Reads Antigravity's actual per-conversation compaction cap (`256k` standard, `512k` Orchestrator, etc.) directly from local session metadata, with the underlying model limit shown on hover.
- **Dual visualization**: Toggle between a proportional segmented usage bar and a `10x10` treemap grid with synchronized hover states.
- **Full category breakdown**: Inspect tokens across user messages, agent responses, tool calls, MCP schemas (active and deferred), rules, skills, and compaction savings.
- **Last-turn & session cache stats**: Clarifies both the latest-turn prompt cache hit rate and cumulative whole-session cache efficiency, plus compaction savings without extra LLM calls.
- **Per-request cache trajectory**: Live dual-line SVG chart tracking every request's cache hit rate alongside cumulative session efficiency, with interactive crosshair inspection, miss classification (`cold #1`, `TTL`, `compacted`, `0% drop`), and a full per-request breakdown table.
- **100% local**: Reads local session and workspace telemetry directly inside Antigravity.

## Usage

Open the panel using the sidecar `+` button (`Context`) or ask Antigravity:

> Open the Context panel for this conversation

## License

[MIT](LICENSE)
