import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { BrowserPolicyError, type BrowserService } from "./service.js";

export interface BrowserToolDeps {
  readonly service: BrowserService;
}

/**
 * 에이전트에 노출되는 Operation Browser 도구면 — Fleet 의 브라우저 어휘. 탭·항해·컴퓨터 조작·페이지 읽기·
 * 폼 입력·콘솔·네트워크·자바스크립트·뷰포트·배치를 한 벌로 묶고, 정책(호출자 Operation 판정, 로컬 전용)은
 * 도구가 아니라 MCP 호스트가 감싼다.
 *
 * 세션 라벨은 MCP 호스트가 Operation id 로 바꿔서 넘긴다.
 */

type ToolResult = { content: { type: "text"; text: string }[] | { type: string; [key: string]: unknown }[]; isError?: boolean };

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError };
}

function failure(error: unknown): ToolResult {
  if (error instanceof BrowserPolicyError) return text({ error: error.code, message: error.message, ...error.detail }, true);
  const message = error instanceof Error ? error.message : "browser_tool_failed";
  const aborted = /abort|interrupted|browser_engine_closed/i.test(message);
  return text({ error: aborted ? "browser_call_interrupted" : "browser_tool_failed", message: aborted ? "The call was interrupted (the user stopped the agent or the tab closed). Do not retry automatically; read the page again if you continue." : message }, true);
}

const TAB_ID = { type: "string", description: "Tab ID from tabs_context or the tab that opened it. Omit for the active tab." };

export function createBrowserToolSpecs(deps: BrowserToolDeps): AgentToolSpec[] {
  const { service } = deps;
  const spec = (id: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, any>, operationId: string, signal: AbortSignal) => Promise<ToolResult>): AgentToolSpec => ({
    id, tag: id, title: id, promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [], description, parameters,
    execute: async (args, context) => {
      const operationId = context.sessionLabel ?? "";
      if (!operationId) return text({ error: "browser_caller_unresolved" }, true);
      try { return await service.agentCall(operationId, context.signal, (signal) => run((args ?? {}) as Record<string, any>, operationId, signal)); }
      catch (error) { return failure(error); }
    },
  });

  const tabsContext = (operationId: string) => {
    const state = service.state(operationId);
    return { browserOpen: state.tabs.length > 0, tabs: state.tabs.map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title, isActive: tab.id === state.activeTabId })), viewport: { width: state.viewport.width, height: state.viewport.height, preset: state.viewport.preset } };
  };

  const screenshotBlock = async (operationId: string, tabId: string | null | undefined, clip?: { x: number; y: number; width: number; height: number }) => {
    const shot = await service.screenshot(operationId, { tabId, clip, format: "png" });
    return [{ type: "image", data: shot.data, mimeType: shot.mimeType }, { type: "text", text: `Screenshot ${shot.width}x${shot.height} CSS px. Coordinates for computer actions are these pixels; the origin is the top-left of the viewport.` }];
  };

  const navigate = spec("navigate", "Navigate a tab to a URL, or go back/forward/reload in its history. Without tabId the active tab is used; if no tab is open, one is created. Any http(s) URL is allowed.", {
    type: "object", properties: { url: { type: "string", description: "Absolute URL, or one of \"back\", \"forward\", \"reload\"." }, tabId: TAB_ID }, required: ["url"], additionalProperties: false,
  }, async (args, operationId) => {
    const result = await service.navigate(operationId, String(args.url), "agent", args.tabId ?? null);
    return text({ ok: result.ok, error: result.error, tab: { tabId: result.tab.id, url: result.tab.url, title: result.tab.title }, ...tabsContext(operationId) }, !result.ok);
  });

  const computer = spec("computer", "Use a mouse and keyboard on the Browser pane's page and take screenshots. Coordinates are CSS pixels of the last screenshot (viewport origin). Actions: screenshot, left_click, right_click, double_click, triple_click, type, key, scroll, scroll_to, left_click_drag, hover, wait, zoom. Prefer element refs from read_page/find (scroll_to) before coordinate clicks. type inserts text (Unicode ok; newlines press Enter). key uses xdotool names (Return, Tab, Escape, cmd+a).", {
    type: "object", properties: {
      action: { type: "string", enum: ["screenshot", "left_click", "right_click", "double_click", "triple_click", "type", "key", "scroll", "scroll_to", "left_click_drag", "hover", "wait", "zoom"] },
      coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] in CSS pixels." },
      start_coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Drag start for left_click_drag." },
      text: { type: "string", description: "Text for type, or the key chord for key." },
      scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
      scroll_amount: { type: "number", description: "Wheel notches (default 3)." },
      ref: { type: "string", description: "Element ref (ref_N) for scroll_to." },
      duration: { type: "number", description: "Seconds for wait (max 10)." },
      region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x, y, width, height] for zoom." },
      tabId: TAB_ID,
    }, required: ["action"], additionalProperties: false,
  }, async (args, operationId, signal) => {
    const tabId = args.tabId ?? null;
    const xy = (value: unknown): { x: number; y: number } => { if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) throw new BrowserPolicyError("browser_coordinate_invalid", "coordinate must be [x, y] numbers from the latest screenshot."); return { x: value[0], y: value[1] }; };
    switch (args.action) {
      case "screenshot": return { content: await screenshotBlock(operationId, tabId) };
      case "zoom": { const r = args.region; if (!Array.isArray(r) || r.length !== 4) throw new BrowserPolicyError("browser_region_invalid", "region must be [x, y, width, height]."); return { content: await screenshotBlock(operationId, tabId, { x: r[0], y: r[1], width: r[2], height: r[3] }) }; }
      case "left_click": case "right_click": case "double_click": case "triple_click": {
        const { x, y } = xy(args.coordinate);
        await service.click(operationId, x, y, { button: args.action === "right_click" ? "right" : "left", clickCount: args.action === "double_click" ? 2 : args.action === "triple_click" ? 3 : 1 }, tabId);
        break;
      }
      case "hover": { const { x, y } = xy(args.coordinate); await service.mouse(operationId, { type: "move", x, y }, tabId); break; }
      case "left_click_drag": { await service.drag(operationId, xy(args.start_coordinate), xy(args.coordinate), tabId); break; }
      case "type": { if (typeof args.text !== "string") throw new BrowserPolicyError("browser_text_required", "text is required for type."); await service.typeText(operationId, args.text, tabId); break; }
      case "key": { if (typeof args.text !== "string") throw new BrowserPolicyError("browser_text_required", "text (key chord) is required for key."); await service.keyChord(operationId, args.text, tabId); break; }
      case "scroll": {
        const { x, y } = args.coordinate ? xy(args.coordinate) : { x: service.state(operationId).viewport.width / 2, y: service.state(operationId).viewport.height / 2 };
        const amount = (typeof args.scroll_amount === "number" ? args.scroll_amount : 3) * 100;
        const direction = args.scroll_direction ?? "down";
        await service.mouse(operationId, { type: "wheel", x, y, deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0, deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0 }, tabId);
        break;
      }
      case "scroll_to": { if (typeof args.ref !== "string") throw new BrowserPolicyError("browser_ref_required", "ref is required for scroll_to."); await service.scrollToRef(operationId, args.ref, tabId); break; }
      case "wait": { const seconds = Math.min(10, Math.max(0, Number(args.duration ?? 1))); await new Promise<void>((resolve) => { const timer = setTimeout(resolve, seconds * 1000); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }); return text(`Waited for ${seconds} seconds`); }
      default: throw new BrowserPolicyError("browser_action_invalid", `Unknown action ${String(args.action)}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { content: [{ type: "text", text: `${args.action} done.` }, ...await screenshotBlock(operationId, tabId)] };
  });

  const readPage = spec("read_page", "Get an accessibility-tree representation of the page as an indented list. Interactive elements carry [ref_N] ids for form_input, computer scroll_to and find. filter \"interactive\" keeps only buttons/links/inputs. Output is capped (default 50000 chars); pass max_chars to raise it.", {
    type: "object", properties: { filter: { type: "string", enum: ["interactive", "all"] }, max_chars: { type: "number" }, tabId: TAB_ID }, additionalProperties: false,
  }, async (args, operationId) => { const page = await service.readPage(operationId, { tabId: args.tabId ?? null, filter: args.filter, maxChars: typeof args.max_chars === "number" ? args.max_chars : undefined }); return text(page.text || "(empty page)"); });

  const find = spec("find", "Search the page's accessibility tree for elements whose role or name contains every word of the query. Returns matching lines with their ref ids.", {
    type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 400 }, tabId: TAB_ID }, required: ["query"], additionalProperties: false,
  }, async (args, operationId) => text(await service.find(operationId, String(args.query), args.tabId ?? null)));

  const formInput = spec("form_input", "Set a form control's value by element ref from read_page or find. Booleans for checkboxes/radios, option value or text for selects, strings for text inputs and editable areas. Fires input/change events.", {
    type: "object", properties: { ref: { type: "string" }, value: { type: ["string", "number", "boolean"] }, tabId: TAB_ID }, required: ["ref", "value"], additionalProperties: false,
  }, async (args, operationId) => text({ ref: args.ref, result: await service.formInput(operationId, String(args.ref), args.value, args.tabId ?? null) }));

  const getPageText = spec("get_page_text", "Extract the visible text of the page (article/main content first, falling back to body). Ideal for reading docs and long pages without screenshots.", {
    type: "object", properties: { tabId: TAB_ID }, additionalProperties: false,
  }, async (args, operationId) => text(await service.pageText(operationId, args.tabId ?? null)));

  const consoleMessages = spec("read_console_messages", "Get console output (log, info, warn, error, debug) and uncaught exceptions from the tab. Always pass a pattern (regex) to filter; without one you may get many irrelevant lines.", {
    type: "object", properties: { pattern: { type: "string" }, limit: { type: "number" }, tabId: TAB_ID }, additionalProperties: false,
  }, async (args, operationId) => text(service.consoleMessages(operationId, { tabId: args.tabId ?? null, pattern: args.pattern, limit: args.limit }).map((entry) => `${new Date(entry.at).toISOString()} [${entry.level}] ${entry.text}${entry.url ? ` (${entry.url}:${entry.line ?? 0})` : ""}`).join("\n") || "(no console messages)"));

  const network = spec("read_network_requests", "List network requests (XHR, fetch, documents, images…) made by the tab since its last navigation, or fetch a specific response body by requestId (truncated to 64 KB). Use pattern (regex) to filter by URL, method or status.", {
    type: "object", properties: { pattern: { type: "string" }, limit: { type: "number" }, requestId: { type: "string" }, tabId: TAB_ID }, additionalProperties: false,
  }, async (args, operationId) => {
    if (typeof args.requestId === "string") return text(await service.responseBody(operationId, args.requestId, args.tabId ?? null));
    return text(service.networkRequests(operationId, { tabId: args.tabId ?? null, pattern: args.pattern, limit: args.limit }).map((entry) => `${entry.requestId} ${entry.method} ${entry.status ?? (entry.failed ? "FAILED" : "…")} ${entry.type} ${entry.url}${entry.failed ? ` (${entry.failed})` : ""}${entry.size ? ` ${entry.size}B` : ""}`).join("\n") || "(no requests recorded)");
  });

  const javascript = spec("javascript_tool", "Execute JavaScript in the page for DEBUGGING and INSPECTION only. Do NOT use this to implement UI changes — edit source code instead. Returns the awaited, JSON-serialized result.", {
    type: "object", properties: { code: { type: "string", minLength: 1, maxLength: 20_000 }, tabId: TAB_ID }, required: ["code"], additionalProperties: false,
  }, async (args, operationId) => { const result = await service.evaluate(operationId, String(args.code), args.tabId ?? null); return result.error ? text({ error: "javascript_failed", message: result.error }, true) : text(result.value === undefined ? "undefined" : result.value); });

  const resizeWindow = spec("resize_window", "Emulate a viewport size in the Browser pane tab. Presets: mobile (375x812), tablet (768x1024), or desktop (returns to the pane's responsive size). Optionally emulate prefers-color-scheme. The user sees the same size and a “set by agent” mark.", {
    type: "object", properties: { preset: { type: "string", enum: ["mobile", "tablet", "desktop"] }, width: { type: "number" }, height: { type: "number" }, colorScheme: { type: "string", enum: ["light", "dark", "system"] }, tabId: TAB_ID }, additionalProperties: false,
  }, async (args, operationId) => {
    const preset = args.preset === "desktop" ? "responsive" : args.preset;
    const viewport = await service.setViewport(operationId, { preset, width: args.width, height: args.height, colorScheme: args.colorScheme === "system" ? null : args.colorScheme }, "agent");
    return text({ viewport });
  });

  const tabsContextTool = spec("tabs_context", "List every Browser pane tab of this Operation with ids, URLs and which is active, plus the current viewport.", { type: "object", properties: {}, additionalProperties: false }, async (_args, operationId) => text(tabsContext(operationId)));
  const tabsCreate = spec("tabs_create", "Open a fresh blank Browser pane tab and return its tabId. Prefer navigate with a url when you know the destination.", { type: "object", properties: {}, additionalProperties: false }, async (_args, operationId) => { const tab = await service.createTab(operationId, null, "agent"); return text({ tabId: tab.id }); });
  const tabsClose = spec("tabs_close", "Close one Browser pane tab. Close tabs you opened when you are done, unless the user wants them kept.", { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"], additionalProperties: false }, async (args, operationId) => { await service.closeTab(operationId, String(args.tabId)); return text({ closed: args.tabId, ...tabsContext(operationId) }); });
  const tabsSelect = spec("tabs_select", "Bring one Browser pane tab to the front for the user.", { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"], additionalProperties: false }, async (args, operationId) => { await service.selectTab(operationId, String(args.tabId)); return text(tabsContext(operationId)); });

  const singles = [navigate, computer, readPage, find, formInput, getPageText, consoleMessages, network, javascript, resizeWindow, tabsContextTool, tabsCreate, tabsClose, tabsSelect];
  const byName = new Map(singles.map((tool) => [tool.id, tool]));

  const batch: AgentToolSpec = {
    id: "browser_batch", tag: "browser_batch", title: "browser_batch", promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [],
    description: "Execute a sequence of browser tool calls in ONE round trip. Each item is {name, input} exactly as you would pass to that tool standalone. Actions run sequentially and stop on the first error. Coordinates you write in the batch refer to the screenshot taken BEFORE this call. browser_batch cannot be nested.",
    parameters: { type: "object", properties: { actions: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name"] } } }, required: ["actions"], additionalProperties: false },
    execute: async (args, context) => {
      const actions = (args as { actions?: { name: string; input?: Record<string, unknown> }[] }).actions ?? [];
      const content: { type: string; [key: string]: unknown }[] = [];
      // 스텝마다 새 호출이 열리므로 「중단」은 세대로 이어 본다 — 한 번 눌렸으면 남은 스텝은 시작하지 않는다.
      const operationId = context.sessionLabel ?? "";
      const serial = service.interruptSerial(operationId);
      for (const [index, action] of actions.entries()) {
        if (service.interruptSerial(operationId) !== serial) { content.push({ type: "text", text: `Step ${index + 1}: batch stopped — the user interrupted the browser. Do not retry automatically; read the page again if you continue.` }); return { content, isError: true }; }
        const tool = byName.get(action.name);
        if (!tool || action.name === "browser_batch") { content.push({ type: "text", text: `Step ${index + 1}: unknown tool ${action.name}; batch stopped.` }); return { content, isError: true }; }
        const result = await tool.execute(action.input ?? {}, context) as ToolResult;
        content.push({ type: "text", text: `— step ${index + 1}: ${action.name}` }, ...result.content);
        if (result.isError) return { content, isError: true };
      }
      return { content };
    },
  };

  return [...singles, batch];
}
