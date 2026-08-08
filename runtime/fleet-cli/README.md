# @dotobokuri/fleet-cli

`fleet` is a thin native launcher for gateway-doctrine Claude Code.

On startup it:

- binds one in-process Fleet MCP server named `fleet` with Fleet Wiki tools and `gateway_models`;
- injects that MCP endpoint into Claude Code through `--mcp-config`;
- registers configured gateway model × effort identities as agent files in the Fleet plugin, reachable as `fleet:<name>`;
- serves the AI gateway on an ephemeral `127.0.0.1` port under `/ai-gateway`;
- spawns Claude Code with inherited standard input, output, and error streams.

AI gateway model selection and diagnostics settings are read from `~/.fleet/ai-gateway.json`. Provider credentials are managed with `fleet auth login|list|logout`. Use `fleet update` to update the installed CLI. All other arguments are passed through to Claude Code verbatim; `-h` or `--help` is Fleet help only when it is the first argument.

Install globally:

```bash
npm install -g @dotobokuri/fleet-cli
```
