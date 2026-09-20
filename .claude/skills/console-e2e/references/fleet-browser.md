# Browser route — Fleet Browser

Use `mcp__fleet-browser__*` for Console browser E2E. This is the Operation's Browser pane, not the Electron application under test and not an agent-browser daemon.

## Connection and ownership

1. Discover/load the available Fleet Browser tools and inspect `tabs_context` before navigation. Create a fresh tab with `tabs_create`, record its returned ID, and pass that ID explicitly to subsequent calls. Existing tabs belong to the user unless explicitly assigned to this run.
2. Navigate only the owned tab to the isolated Console URL established by [setup](setup.md). Verify the final URL and loaded page, not just transport success. Do not import user cookies or point at the canonical Console to simplify setup.
3. Record host OS/architecture, browser engine and actual display mode. Fleet Browser does not expose the agent-browser `--headed false` contract: never label its evidence headless by assumption. Explicit headless requirements need a supported capability or the [fallback](agent-browser.md). For a headed visual gate, confirm the visible pane and capture its screenshot; a DOM snapshot alone does not satisfy that gate.

## Observe and interact

- Use `read_page`/`find` for fresh accessible references, `computer` for real pointer/keyboard input and screenshots, and `form_input` for supported form controls. Inspect each tool's schema instead of assuming agent-browser command syntax. Refresh references after navigation or rerenders.
- Use `javascript_tool` for read-only DOM/state/geometry inspection and debugging, not to implement UI changes or replace the interaction being tested with DOM mutation or synthetic `.click()`.
- Use filtered `read_console_messages` and `read_network_requests` for scenario diagnostics. Start from a fresh owned tab, capture a baseline before acting, and distinguish existing entries from new ones on a repeat run. Do not assume a clear-logs API or that every socket event/unhandled rejection is recorded.
- Screenshots, real input, and visible postconditions establish focus, hit testing, transitions, and canvas-terminal behavior. An accepted input call alone does not prove the UI received it.
- If the claim requires errors/rejections/WebSocket instrumentation from before the first navigation and the available tools cannot install it, use the fallback's init-script workflow. Post-load injection misses startup events and is not equivalent evidence.

## Fallback and cleanup

Fall back to agent-browser only for an unavailable/unusable Fleet Browser connection or a concrete missing capability needed by the scenario (for example explicit headless execution or pre-navigation instrumentation). Record the error/capability and affected scope. Do not switch because a product assertion failed, and do not route around permission denial. Stop repeated failing browser calls after 2–3 attempts; use the documented fallback when appropriate, otherwise report the blocker.

After any tab creation, close only recorded owned tabs using `tabs_close` on both success and failure paths, then confirm their absence with `tabs_context`. Do not close the Browser pane, pre-existing tabs, or its host app. A tab left for the user to try belongs to `console-handoff`. If the connection prevents cleanup, report the remaining tab IDs rather than claiming cleanup. Before switching drivers, clean up the Fleet Browser tabs; the owned isolated Console may remain for the same scenario.

Stop the verified owned isolated Console after verification, following [verification](verification.md). Never invoke `close-owned-session.mjs` for Fleet Browser: it owns no agent-browser session or daemon PID.
