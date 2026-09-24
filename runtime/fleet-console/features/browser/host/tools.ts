import type { AgentToolSpec } from "@fleet-console/agent-runtime/tools";
import { BrowserPolicyError, type BrowserService } from "./service.js";
import { actOnBrowser, waitForBrowser, type BrowserCondition, type BrowserTarget } from "./semantic.js";
import type { BrowserScreenshotStore } from "./screenshot-store.js";

export interface BrowserToolDeps {
  readonly service: BrowserService;
  /** 캡처가 놓이는 자리. 스크린샷은 결과에 싣지 않고 언제나 여기 파일로 건넨다. */
  readonly screenshots: BrowserScreenshotStore;
}

/**
 * 에이전트에 노출되는 Operation Browser 도구면 — Fleet 의 브라우저 어휘. 탭·항해·컴퓨터 조작·페이지 읽기·
 * 폼 입력·콘솔·네트워크·자바스크립트·뷰포트·배치를 한 벌로 묶고, 정책(호출자 Operation 판정, 로컬 전용)은
 * 도구가 아니라 MCP 호스트가 감싼다.
 *
 * 세션 라벨은 MCP 호스트가 Operation id 로 바꿔서 넘긴다.
 */

type TextBlock = { type: "text"; text: string };
type ToolResult = { content: TextBlock[]; isError: boolean };

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

  /**
   * 한 장의 스크린샷. 화질은 JPEG 압축으로 줄이되 **해상도는 건드리지 않는다** — 줄인 해상도는 UI 의 작은
   * 글자, 특히 획이 조밀한 한글을 뭉개서 에이전트가 문구를 잘못 읽는 쪽으로 실패한다.
   *
   * 캡처는 도구 결과에 싣지 않고 **언제나 파일로 건넨다**. 결과에 실린 base64 는 이미지가 아니라 텍스트로
   * 값이 매겨져 한 장이 수만 토큰을 먹고, 그러고도 호출한 CLI 의 상한을 넘기면 결과가 통째로 흘러가
   * 모델은 이미지를 아예 보지 못한다. 경로는 몇 십 토큰이고 에이전트가 제 손으로 읽을 때 비로소 이미지로
   * 들어가니, 같은 장이 스무 배 넘게 싸면서 더 확실히 닿는다.
   */
  const screenshotBlock = async (operationId: string, tabId: string | null | undefined, signal: AbortSignal, clip?: { x: number; y: number; width: number; height: number }): Promise<TextBlock[]> => {
    const shot = await service.screenshot(operationId, { tabId, clip, format: "jpeg", signal });
    const pixelLine = shot.pixels ? `Image ${shot.pixels.width}x${shot.pixels.height} pixels; pixel-to-CSS scale [${shot.width / shot.pixels.width}, ${shot.height / shot.pixels.height}]. Geometry ${shot.geometryVersion}.` : "";
    const viewportLine = `Reported viewport ${shot.viewport.width}x${shot.viewport.height} (${shot.viewport.preset}${shot.viewport.followsPane ? ", follows pane" : ", emulated"}).`;
    const layoutLine = shot.layout ? `Page layout metrics ${shot.layout.width}x${shot.layout.height}.` : "Page layout metrics unavailable.";
    const stale = shot.staleViewport
      ? " WARNING: stored viewport disagreed with page layout before this capture — prior screenshot coordinates may be stale; take a fresh screenshot before clicking by coordinate."
      : "";
    const origin = clip ? `Capture offset in the viewport is [${clip.x}, ${clip.y}]; add this offset to points measured in the cropped image.` : "Capture offset in the viewport is [0, 0].";
    const geometry = `Screenshot capture ${shot.width}x${shot.height} CSS px. ${pixelLine} ${viewportLine} ${layoutLine}${stale} ${origin} Coordinates for computer actions are CSS pixels relative to the top-left of the viewport, not the crop.`;
    // 끊긴 호출은 파일을 남기지 않는다 — 브라우저를 거두면 이 호출은 그 자리에서 끊기고 회수도 이미 지나갔으므로,
    // 여기서 쓰면 사람이 거둔 페이지의 사본이 디렉터리를 되살리며 남는다. 결과 자체도 어차피 버려진다.
    if (signal.aborted) return [{ type: "text", text: geometry }];
    try {
      const filePath = deps.screenshots.save(operationId, Buffer.from(shot.data, "base64"), "jpg");
      return [{ type: "text", text: `${geometry}\nThe image was written to this machine — the same machine you are running on. Read the image file to see it: ${filePath}` }];
    } catch {
      // 앞선 조작은 이미 일어났다 — 실패로 되돌리면 에이전트가 같은 클릭을 되풀이한다. 이 장만 포기하고
      // 그 사실을 알린다. base64 로 되돌아가지는 않는다.
      return [{ type: "text", text: `${geometry}\nThe image could not be written to this machine, so there is no picture of this call. Take a screenshot again to see the page.` }];
    }
  };

  /**
   * 지정 방식마다 한 갈래 — 한 호출이 둘 이상을 섞을 수 없는 모양이다. 한 객체에 모든 키를 선택 항목으로
   * 두면, OpenAI strict 변환이 그것을 전부 필수+null 허용으로 바꿔 모델이 매 호출 여섯 키를 채우게 되고,
   * gpt-6-sol 은 null 대신 값을 채워 같은 거부를 229번 되풀이했다. strict 가 받지 않는 `const` 없이 필수 키와
   * `additionalProperties: false` 로만 갈래를 가른다.
   *
   * within 은 갈래마다 복사되므로 설명을 싣지 않는다 — 이 세 도구는 매 요청의 도구 목록에 실린다. ref 는 이미
   * 요소 하나를 가리켜 within 이 확인 노릇밖에 못 하므로 ref 갈래에는 within 을 두지 않는다.
   */
  const targetBranches = (within?: Record<string, unknown>) => {
    const scoped = within ? { within } : {};
    const described = within !== undefined;
    return [
      { type: "object", properties: { ref: described ? { type: "string", description: "Exactly as observe/read_page/find printed it; never invent or edit." } : { type: "string" } }, required: ["ref"], additionalProperties: false },
      { type: "object", properties: { selector: { type: "string" }, ...scoped }, required: ["selector"], additionalProperties: false },
      { type: "object", properties: { role: { type: "string" }, name: { type: "string" }, exact: described ? { type: "boolean", description: "Exact name match. Default true." } : { type: "boolean" }, ...scoped }, additionalProperties: false },
    ];
  };
  const scopeSchema = { anyOf: targetBranches() };
  const targetSchema = { description: "Exactly one of ref, selector, or role/name; never combine them. selector and role/name take an optional within: a unique ancestor in one of the same forms. A ref is already unique and takes no within.", anyOf: targetBranches(scopeSchema) };
  const conditionSchema = { type: "object", properties: { target: targetSchema, state: { type: "string", enum: ["visible", "hidden", "enabled", "disabled", "checked", "unchecked"] }, attribute: { type: "string" }, equals: { type: "string" }, value: { type: "string" }, url: { type: "string" } }, additionalProperties: false };
  const observation = async (mode: string | undefined, operationId: string, tabId: string | null | undefined, signal: AbortSignal): Promise<TextBlock[]> => {
    if (!mode || mode === "none") return [];
    // 입력 이후 관측 실패는 입력 실패가 아니다. 재전송을 유도하지 않는다.
    try {
      if (mode === "screenshot") return await screenshotBlock(operationId, tabId, signal);
      return [{ type: "text", text: JSON.stringify(await service.readPage(operationId, { tabId, filter: "interactive", maxChars: 12000 })) }];
    } catch (error) { return [{ type: "text", text: JSON.stringify({ observationError: error instanceof Error ? error.message : "unavailable", retryInput: false }) }]; }
  };
  const observe = spec("observe", "Observe without images. Omit target for a bounded accessibility snapshot with observation-scoped refs. Use within/max_depth/max_chars to narrow it. Supply target for a small state result (visible, enabled, checked, value, text, requested attributes). Targets are unique ref, role/name (exact by default), or CSS selector, optionally within a unique scope. No match and ambiguous matches are distinct errors.", {
    type: "object", properties: { target: targetSchema, within: targetSchema, filter: { type: "string", enum: ["interactive", "all"] }, max_depth: { type: "integer", minimum: 0, maximum: 100 }, max_chars: { type: "integer", minimum: 200, maximum: 50000 }, attributes: { type: "array", maxItems: 20, items: { type: "string" } }, tabId: TAB_ID }, additionalProperties: false,
  }, async (args, operationId) => {
    if (args.target) { const ref = await service.targetRef(operationId, args.target as BrowserTarget, args.tabId); return text({ ref, ...await service.elementState(operationId, ref, args.attributes ?? [], args.tabId) }); }
    return text(await service.readPage(operationId, { tabId: args.tabId, within: args.within, filter: args.filter ?? "interactive", maxDepth: args.max_depth, maxChars: args.max_chars }));
  });
  const waitFor = spec("wait_for", "Wait for a declared URL or element condition without sending input. Exact URL, visible/hidden/enabled/disabled/checked/unchecked, attribute equals, or value. Timeouts return matched=false. Does not retry a prior action. Prefer this to sleeps.", {
    type: "object", properties: { condition: conditionSchema, timeout_ms: { type: "integer", minimum: 0, maximum: 30000 }, tabId: TAB_ID }, required: ["condition"], additionalProperties: false,
  }, async (args, operationId, signal) => text(await waitForBrowser(service, operationId, args.condition as BrowserCondition, args.tabId, signal, args.timeout_ms)));
  const act = spec("act", "Act on a unique element: click, fill, select, check, uncheck. Use ref from observe/read_page or role/name/selector with optional within. No automatic screenshot. An optional expect checks a postcondition without retrying input; observed success is separate from input dispatch. Optional observe returns snapshot or screenshot after input. Never automatically repeat an action after a postcondition timeout.", {
    type: "object", properties: { action: { type: "string", enum: ["click", "fill", "select", "check", "uncheck"] }, target: targetSchema, value: { type: ["string", "number", "boolean"] }, expect: conditionSchema, timeout_ms: { type: "integer", minimum: 0, maximum: 30000 }, observe: { type: "string", enum: ["none", "snapshot", "screenshot"] }, tabId: TAB_ID }, required: ["action", "target"], additionalProperties: false,
  }, async (args, operationId, signal) => {
    const dispatch = await actOnBrowser(service, operationId, { action: args.action, target: args.target, value: args.value, tabId: args.tabId }, signal);
    let verification: unknown = { requested: false };
    if (args.expect) {
      try { verification = await waitForBrowser(service, operationId, args.expect, args.tabId, signal, args.timeout_ms); }
      catch (error) { verification = { matched: false, error: error instanceof Error ? error.message : "unavailable", retryInput: false }; }
    }
    return { content: [{ type: "text", text: JSON.stringify({ input: dispatch, verification, retryInput: false }) }, ...await observation(args.observe, operationId, args.tabId, signal)], isError: false };
  });
  const capture = spec("capture", "Explicit screenshot only. Waits for native pane/layout readiness. Returns a local image file with actual pixel size, CSS capture area, offset and geometry version. Never infer page-action success from capture. Input coordinates remain viewport CSS pixels.", {
    type: "object", properties: { tabId: TAB_ID, region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } }, additionalProperties: false,
  }, async (args, operationId, signal) => ({ content: await screenshotBlock(operationId, args.tabId, signal, args.region ? { x: args.region[0], y: args.region[1], width: args.region[2], height: args.region[3] } : undefined), isError: false }));

  const navigate = spec("navigate", "Navigate a tab to a URL, or go back/forward/reload in its history. Without tabId the active tab is used; if no tab is open, one is created. Any http(s) URL is allowed.", {
    type: "object", properties: { url: { type: "string", description: "Absolute URL, or one of \"back\", \"forward\", \"reload\"." }, tabId: TAB_ID }, required: ["url"], additionalProperties: false,
  }, async (args, operationId) => {
    const result = await service.navigate(operationId, String(args.url), "agent", args.tabId ?? null);
    return text({ ok: result.ok, error: result.error, tab: { tabId: result.tab.id, url: result.tab.url, title: result.tab.title }, ...tabsContext(operationId) }, !result.ok);
  });

  const computer = spec("computer", "Use a mouse and keyboard on the Browser pane's page and take screenshots. Coordinates are CSS pixels relative to the viewport origin. For zoom crops, add the reported capture offset to image points. Actions: screenshot, left_click, right_click, double_click, triple_click, type, key, scroll, scroll_to, left_click_drag, hover, wait, zoom. Prefer element refs from read_page/find for clicks and scroll_to before coordinate clicks. Click actions accept ref or coordinate; ref scrolls into view, hit-tests, then dispatches a real pointer. Replies report input dispatched (not page success) plus hit diagnostics. type inserts text (Unicode ok; newlines press Enter). key uses xdotool names (Return, Tab, Escape, cmd+a). No automatic screenshot. Use act for ordinary controls, capture for images, or the observe option (snapshot/screenshot) for optional post-action observation.", {
    type: "object", properties: {
      observe: { type: "string", enum: ["none", "snapshot", "screenshot"], description: "Optional post-action observation; default none." },
      action: { type: "string", enum: ["screenshot", "left_click", "right_click", "double_click", "triple_click", "type", "key", "scroll", "scroll_to", "left_click_drag", "hover", "wait", "zoom"] },
      coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] in viewport CSS pixels. Add the capture offset when using a zoom crop." },
      geometry_version: { type: "string", description: "Geometry from capture; reject coordinate input if viewport changed. Recommended for coordinates." },
      start_coordinate: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "Drag start for left_click_drag." },
      text: { type: "string", description: "Text for type, or the key chord for key." },
      scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
      scroll_amount: { type: "number", description: "Wheel notches (default 3)." },
      ref: { type: "string", description: "Element ref (ref_N) for scroll_to or click actions." },
      duration: { type: "number", description: "Seconds for wait (max 10)." },
      region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x, y, width, height] for zoom." },
      tabId: TAB_ID,
    }, required: ["action"], additionalProperties: false,
  }, async (args, operationId, signal) => {
    const tabId = args.tabId ?? null;
    const xy = (value: unknown): { x: number; y: number } => { if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) throw new BrowserPolicyError("browser_coordinate_invalid", "coordinate must be [x, y] numbers from the latest screenshot."); return { x: value[0], y: value[1] }; };
    if (args.geometry_version && (args.coordinate || args.start_coordinate) && args.geometry_version !== await service.geometryVersion(operationId, tabId)) throw new BrowserPolicyError("browser_viewport_stale", "Viewport changed since capture. Capture again; no input was dispatched.");
    let dispatchSummary: string | null = null;
    switch (args.action) {
      case "screenshot": return { content: await screenshotBlock(operationId, tabId, signal), isError: false };
      case "zoom": { const r = args.region; if (!Array.isArray(r) || r.length !== 4) throw new BrowserPolicyError("browser_region_invalid", "region must be [x, y, width, height]."); return { content: await screenshotBlock(operationId, tabId, signal, { x: r[0], y: r[1], width: r[2], height: r[3] }), isError: false }; }
      case "left_click": case "right_click": case "double_click": case "triple_click": {
        const button = args.action === "right_click" ? "right" as const : "left" as const;
        const clickCount = args.action === "double_click" ? 2 : args.action === "triple_click" ? 3 : 1;
        const hasRef = typeof args.ref === "string" && args.ref.length > 0;
        const hasCoordinate = Array.isArray(args.coordinate);
        if (hasRef && hasCoordinate) throw new BrowserPolicyError("browser_click_target_ambiguous", "Pass either ref or coordinate for click actions, not both.");
        if (!hasRef && !hasCoordinate) throw new BrowserPolicyError("browser_click_target_required", "Click actions require ref (from read_page/find) or coordinate from the latest screenshot.");
        const dispatched = hasRef
          ? await service.clickRef(operationId, String(args.ref), { button, clickCount, signal }, tabId)
          : await service.clickAt(operationId, xy(args.coordinate).x, xy(args.coordinate).y, { button, clickCount, signal }, tabId);
        const hit = dispatched.hit ? ` hit=${dispatched.hit.selector || dispatched.hit.tag}${dispatched.hit.disabled ? " disabled=true" : ""}${dispatched.hit.text ? ` text=${JSON.stringify(dispatched.hit.text)}` : ""}` : " hit=(none)";
        dispatchSummary = `${args.action}: input dispatched at [${Math.round(dispatched.x)}, ${Math.round(dispatched.y)}]${dispatched.ref ? ` ref=${dispatched.ref}` : ""}${hit}.${dispatched.note ? ` ${dispatched.note}` : ""} This reports pointer dispatch only — confirm with the screenshot or page state; do not assume the control activated.`;
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
    const summary = dispatchSummary ?? `${args.action}: input dispatched. Confirm with the screenshot or page state; do not assume success.`;
    return { content: [{ type: "text", text: summary }, ...await observation(args.observe, operationId, tabId, signal)], isError: false };
  });

  const readPage = spec("read_page", "Get an accessibility-tree representation of the page as an indented list. Interactive elements carry observation-scoped ref ids for form_input, computer clicks/scroll_to and find. filter \"interactive\" keeps only buttons/links/inputs. Output is capped (default 50000 chars); pass max_chars to raise it.", {
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

  const resizeWindow = spec("resize_window", "Set the Browser pane tab viewport. Presets: mobile (375x812), tablet (768x1024), or desktop (clears emulation and follows the native pane size). Arbitrary width/height emulates that CSS size (not the previous preset). Optionally emulate prefers-color-scheme. The user sees the same size and a “set by agent” mark.", {
    type: "object", properties: { preset: { type: "string", enum: ["mobile", "tablet", "desktop"] }, width: { type: "number", description: "CSS px width to emulate. With desktop/responsive, this locks an emulated size instead of the native pane." }, height: { type: "number", description: "CSS px height to emulate." }, colorScheme: { type: "string", enum: ["light", "dark", "system"] }, tabId: TAB_ID }, additionalProperties: false,
  }, async (args, operationId) => {
    const preset = args.preset === "desktop" ? "responsive" : args.preset;
    const viewport = await service.setViewport(operationId, { preset, width: typeof args.width === "number" ? args.width : undefined, height: typeof args.height === "number" ? args.height : undefined, colorScheme: args.colorScheme === "system" ? null : args.colorScheme }, "agent");
    return text({ viewport });
  });

  const tabsContextTool = spec("tabs_context", "List every Browser pane tab of this Operation with ids, URLs and which is active, plus the current viewport.", { type: "object", properties: {}, additionalProperties: false }, async (_args, operationId) => text(tabsContext(operationId)));
  const tabsCreate = spec("tabs_create", "Open a fresh blank Browser pane tab and return its tabId. Prefer navigate with a url when you know the destination.", { type: "object", properties: {}, additionalProperties: false }, async (_args, operationId) => { const tab = await service.createTab(operationId, null, "agent"); return text({ tabId: tab.id }); });
  const tabsClose = spec("tabs_close", "Close one Browser pane tab. Close tabs you opened when you are done, unless the user wants them kept.", { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"], additionalProperties: false }, async (args, operationId) => { await service.closeTab(operationId, String(args.tabId)); return text({ closed: args.tabId, ...tabsContext(operationId) }); });
  const tabsSelect = spec("tabs_select", "Bring one Browser pane tab to the front for the user.", { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"], additionalProperties: false }, async (args, operationId) => { await service.selectTab(operationId, String(args.tabId)); return text(tabsContext(operationId)); });

  const singles = [observe, act, waitFor, capture, navigate, computer, readPage, find, formInput, getPageText, consoleMessages, network, javascript, resizeWindow, tabsContextTool, tabsCreate, tabsClose, tabsSelect];
  const byName = new Map(singles.map((tool) => [tool.id, tool]));

  const batch: AgentToolSpec = {
    id: "browser_batch", tag: "browser_batch", title: "browser_batch", promptSnippet: "", whenToUse: [], whenNotToUse: [], usageGuidelines: [],
    description: "Execute a sequence of browser tool calls in ONE round trip. Each item is {name, input} exactly as you would pass to that tool standalone. Actions run sequentially and stop on the first error. Coordinates you write in the batch refer to the screenshot taken BEFORE this call. browser_batch cannot be nested.",
    parameters: { type: "object", properties: { actions: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name"] } } }, required: ["actions"], additionalProperties: false },
    execute: async (args, context) => {
      const actions = (args as { actions?: { name: string; input?: Record<string, unknown> }[] }).actions ?? [];
      const content: TextBlock[] = [];
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
      return { content, isError: false };
    },
  };

  return [...singles, batch];
}
