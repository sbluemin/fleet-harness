# Browser fallback — Fleet Browser

Use `mcp__fleet-browser__*` only when [agent-browser](agent-browser.md) cannot run here. Record the agent-browser error and affected scope before switching. A failed product assertion is not a reason to switch drivers, and a permission denial is not permission to route around it. Fleet Browser is this Operation's Browser pane, not the Electron application under test.

## Connection and ownership

1. Inspect `tabs_context` before navigation. Create a fresh tab with `tabs_create`, record its ID, and pass that ID explicitly afterwards. Existing tabs belong to the user unless explicitly assigned to this run.
2. Navigate only the owned tab to the isolated Console URL from [setup](setup.md). Verify the final URL and loaded page, not just transport success. Do not import user cookies or point at the canonical Console.
3. Record host OS/architecture, browser engine, and actual display mode. The pane is visible, so never label its evidence headless; a claim that requires headless or pre-navigation instrumentation stays unverified on this route.

## Observe and interact

- Use `read_page`/`find` for fresh references, `computer` for real pointer/keyboard input and screenshots, and `form_input` for supported form controls. Read each tool's schema rather than assuming agent-browser syntax.
- Use `javascript_tool` for read-only DOM/state/geometry inspection, not to replace the interaction under test with DOM mutation or synthetic `.click()`.
- Use filtered `read_console_messages` and `read_network_requests`. Capture a baseline before acting and distinguish new entries on a repeat run; the tools do not promise a clear operation or complete socket/rejection capture.
- An accepted input call does not prove the UI received it; confirm with a screenshot or visible postcondition.

## Cleanup

Close only recorded owned tabs with `tabs_close` on success and failure, then confirm their absence with `tabs_context`. Do not close the Browser pane, pre-existing tabs, or tabs owned by `console-handoff` or `product-proposal`. If the connection prevents cleanup, report the remaining tab IDs. Stop the owned isolated Console as [verification](verification.md) describes.
