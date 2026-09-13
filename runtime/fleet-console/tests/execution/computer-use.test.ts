import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseService } from "../../core/host/agent/computer-use.js";
import type { ComputerUseResult, ComputerUseBackend } from "../../core/host/agent/computer-use-platform.js";
import { macOSComputerUsePlatform } from "../../core/host/agent/computer-use-macos.js";
import { createComputerUseMcpHost } from "../../core/host/mcp/computer-use.js";

// 기존 MCP 테스트는 읽기 전용 Console 목록뿐이다. 실제 기기 접근의 승인·소유권·회수 경계를 여기서 검증한다.
describe("Computer Use authorization and lifecycle", () => {
  const services: ComputerUseService[] = [];
  afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });

  function setup() {
    let enabled = true;
    let local = true;
    const call = vi.fn(async (): Promise<ComputerUseResult> => ({ content: [{ type: "text", text: "app state" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }));
    const diagnostic = vi.fn();
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    let approve: (() => Promise<boolean>) | undefined;
    const broker = { start, stop, call, cleanupStatus: "failed", threadReleaseStatus: "not_needed", cleanupFailure: null, tools: new Map([
      ["get_app_state", { name: "get_app_state", inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"], additionalProperties: false } }],
      ["press_key", { name: "press_key", description: "Use xdotool key syntax", inputSchema: { type: "object", properties: { app: { type: "string" }, key: { type: "string" } }, required: ["app", "key"], additionalProperties: false } }],
      ["click", { name: "click", inputSchema: { type: "object", properties: { app: { type: "string" }, x: { type: "number" }, y: { type: "number" }, element_index: { type: "string" } }, required: ["app"], additionalProperties: false } }],
      ["select_text", { name: "select_text", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "string" }, text: { type: "string" } }, required: ["app", "element_index", "text"], additionalProperties: false } }],
      ["set_value", { name: "set_value", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "string" }, value: { type: "string" } }, required: ["app", "element_index", "value"], additionalProperties: false } }],
      ["type_text", { name: "type_text", inputSchema: { type: "object", properties: { app: { type: "string" }, text: { type: "string" } }, required: ["app", "text"], additionalProperties: false } }],
    ]) } as unknown as ComputerUseBackend;
    const service = new ComputerUseService({
      directory: "unused", diagnostic, enabled: () => enabled, localControl: () => local,
      platform: { ...macOSComputerUsePlatform, supported: () => true, inspectInstallation: async () => true,
        createBroker: async (deps) => { approve = () => deps.approve({}); return broker; } },
    });
    services.push(service);
    const invoke = (tool: string, input: unknown, sessionLabel = "session-a", signal?: AbortSignal) => service.specs().find((spec) => spec.id === tool)!.execute(input, { cwd: "", sessionLabel, signal });
    return { service, invoke, call, diagnostic, start, stop, approve: () => approve!(), enable: (value: boolean) => { enabled = value; }, local: (value: boolean) => { local = value; } };
  }

  it("serves a separate opt-in MCP and revokes device access with its token", async () => {
    const f = setup();
    const host = createComputerUseMcpHost({ service: f.service });
    const connection = host.connect();
    try {
      const endpoint = (await connection.getEndpoint()).servers[0]!;
      expect(endpoint.name).toBe("fleet-computer-use");
      const rpc = async (token: string, method: string, params = {}) => (await fetch(endpoint.url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })).json();
      f.enable(false);
      const off = connection.issueSessionToken({ label: "off", cwd: process.cwd() })[0]!;
      expect((await rpc(off.token, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["computer_status", "computer_end"]));
      f.enable(true);
      const on = connection.issueSessionToken({ label: "on", cwd: process.cwd() })[0]!;
      expect((await rpc(on.token, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["computer_apps", "computer_state", "computer_action"]));
      f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "<app_state>App=Chrome (bundleID com.google.chrome.for.testing, pid 1)\nWindow: Fixture, URL: localhost</app_state>" }, { type: "image", mimeType: "image/png", data: "b2xk" }] });
      f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "<app_state>HTML 콘텐츠 Fixture\n27 증감자 (settable, float) 수량, Value: 1</app_state>" }, { type: "image", mimeType: "image/png", data: "bmV3" }] });
      const read = await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.google.chrome.for.testing" } });
      expect(JSON.parse(read.result.content[0].text)).toMatchObject({ observationReads: 2 });
      expect(read.result.isError).toBe(false);
      expect(read.result.content.filter((block: { type: string }) => block.type === "image")).toHaveLength(1);
      expect(JSON.stringify(read.result.content.filter((block: { type: string }) => block.type === "text"))).not.toContain("aW1hZ2U=");
      expect(f.call).toHaveBeenCalledTimes(2);
      connection.releaseSessionToken("on");
      expect((await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.apple.TextEdit" } })).error).toBeDefined();
      expect(f.call).toHaveBeenCalledTimes(2);
      await f.service.stop();
      expect(f.stop).toHaveBeenCalled();
    } finally { await host.dispose(); }
  });

  it("keeps the default-off and remote boundary ahead of process startup", async () => {
    const f = setup();
    f.enable(false);
    expect(await f.invoke("computer_apps", {})).toMatchObject({ isError: true });
    f.enable(true); f.local(false);
    expect(await f.invoke("computer_apps", {})).toMatchObject({ isError: true });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("pre-approves device permissions while opted in and still requires fresh observations", async () => {
    const f = setup();
    const value = await f.invoke("computer_state", { app: "com.apple.TextEdit" }) as { content: { text: string }[] };
    expect(await f.approve()).toBe(true);
    const metadata = JSON.parse(value.content[0]!.text);
    expect(metadata.actionSchemas.type_text.properties).not.toHaveProperty("app");
    expect(metadata.actionSchemas.type_text.required).toEqual(["text"]);
    const snapshotId = metadata.snapshotId;
    const action = { app: "com.apple.TextEdit", snapshotId, action: "type_text", arguments: { text: "test" }, reason: "Fill the disposable document" };
    expect(await f.invoke("computer_action", { ...action, arguments: { app: action.app, text: "test" } })).toMatchObject({ isError: true });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.call).toHaveBeenCalledTimes(1);
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Changed element 12: editable field" }, { type: "image", mimeType: "image/png", data: "b2xk" }] });
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Computer Use server error -10005: cgWindowNotFound" }] });
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "No changes" }, { type: "image", mimeType: "image/png", data: "bmV3" }] });
    const acted = await f.invoke("computer_action", action) as { content: { text: string }[] };
    const nextSnapshot = JSON.parse(acted.content[4]!.text).snapshotId;
    expect(nextSnapshot).not.toBe(snapshotId);
    expect(acted.content.filter((block) => (block as unknown as { type: string }).type === "image")).toHaveLength(1);
    const outputText = JSON.stringify(acted.content.filter((block) => (block as unknown as { type: string }).type === "text"));
    expect(outputText).not.toContain("aW1hZ2U=");
    expect(JSON.parse(acted.content[4]!.text)).toMatchObject({ actionSchemasVersion: metadata.actionSchemasVersion, actionSchemasIncluded: false });
    expect(JSON.parse(acted.content[4]!.text)).not.toHaveProperty("actionSchemas");
    expect(outputText).not.toContain("actionResult");
    const actionRecords = acted.content.map((block) => { try { return JSON.parse(block.text).lastAgentAction; } catch { return null; } }).filter(Boolean);
    expect(actionRecords.length).toBeGreaterThan(1);
    expect(actionRecords.every((record) => record.action === "type_text" && record.outcome === "returned")).toBe(true);
    expect(outputText).toContain("Changed element 12");
    expect(outputText).toContain("No changes");
    expect(outputText.indexOf("Changed element 12")).toBeLessThan(outputText.indexOf("No changes"));
    expect(JSON.parse(acted.content[0]!.text)).toMatchObject({ actionOutcome: "completed", observation: "completed", effectVerified: false });
    expect(f.call).toHaveBeenCalledWith("type_text", { app: "com.apple.TextEdit", text: "test" });
    f.enable(false);
    expect(await f.approve()).toBe(false);
    expect(await f.invoke("computer_apps", {})).toMatchObject({ isError: true });
    f.enable(true);
    f.local(false);
    expect(await f.approve()).toBe(false);
    f.local(true);
    expect(await f.invoke("computer_action", action)).toMatchObject({ isError: true });
    expect(f.call).toHaveBeenCalledTimes(4);
    expect(f.call.mock.calls.filter((args) => (args as unknown[])[0] === "type_text")).toHaveLength(1);
    expect(JSON.parse(acted.content[4]!.text)).toMatchObject({ observationReads: 2 });
    expect(f.stop).not.toHaveBeenCalled();
    f.call.mockImplementationOnce(async () => ({ content: [{ type: "text", text: "applied" }] }));
    f.call.mockRejectedValueOnce(new Error("computer_use_timeout_outcome_unknown"));
    const failedObservation = await f.invoke("computer_action", { ...action, snapshotId: nextSnapshot }) as { content: { text: string }[]; isError: boolean };
    expect(failedObservation.isError).toBe(true);
    expect(JSON.parse(failedObservation.content[0]!.text)).toMatchObject({ actionOutcome: "completed", observation: "failed" });
    expect(f.call).toHaveBeenCalledTimes(6);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("blocks lossy Unicode typing before dispatch and allows explicit whole-field Unicode replacement", async () => {
    const f = setup();
    const read = await f.invoke("computer_state", { app: "com.apple.TextEdit" }) as ComputerUseResult;
    const snapshotId = JSON.parse(read.content[0]!.text as string).snapshotId;
    const action = { app: "com.apple.TextEdit", snapshotId, reason: "Fill disposable field" };
    const blocked = await f.invoke("computer_action", { ...action, action: "type_text", arguments: { text: "한글abcㅋ 가나다" } }) as ComputerUseResult;
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content[0]!.text as string)).toMatchObject({ error: "computer_use_unicode_input_requires_set_value", actionOutcome: "not_started" });
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
    const controls = await f.invoke("computer_action", { ...action, action: "type_text", arguments: { text: "abc\r\n\t" } }) as ComputerUseResult;
    expect(JSON.parse(controls.content[0]!.text as string)).toMatchObject({ error: "computer_use_control_characters_require_explicit_action", actionOutcome: "not_started" });
    expect(f.call).toHaveBeenCalledTimes(1);
    await f.invoke("computer_action", { ...action, action: "set_value", arguments: { element_index: "1", value: "한글abcㅋ 가나다" } });
    expect(f.call).toHaveBeenCalledWith("set_value", { app: "com.apple.TextEdit", element_index: "1", value: "한글abcㅋ 가나다" });
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ tool: "set_value", phase: "end", imageCount: 1, imageBytes: 5 }));
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain("한글");
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain("aW1hZ2U=");
  });

  it("normalizes key names and reports native coordinate errors without fallback dispatch", async () => {
    const f = setup();
    let state = await f.invoke("computer_state", { app: "com.apple.TextEdit" }) as ComputerUseResult;
    const meta = JSON.parse(state.content[0]!.text as string);
    expect(meta.actionSchemas.press_key.description).toContain("Return");
    await f.invoke("computer_action", { app: "com.apple.TextEdit", snapshotId: meta.snapshotId, action: "press_key", arguments: { key: "enter" }, reason: "Newline in disposable document" });
    expect(f.call).toHaveBeenCalledWith("press_key", { app: "com.apple.TextEdit", key: "Return" });
    state = await f.invoke("computer_state", { app: "com.apple.TextEdit" }) as ComputerUseResult;
    expect(JSON.parse(state.content[0]!.text as string)).toMatchObject({ coordinateActionsAvailable: "unverified", actionSchemasIncluded: false });
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "windowNotFoundAtPosition(-2153,540)" }] });
    const failure = await f.invoke("computer_action", { app: "com.apple.TextEdit", snapshotId: JSON.parse(state.content[0]!.text as string).snapshotId, action: "click", arguments: { x: 325, y: 599 }, reason: "Test fixture target" }) as ComputerUseResult;
    expect(JSON.parse(failure.content[0]!.text as string)).toMatchObject({ error: "computer_use_coordinate_target_unavailable" });
    expect(f.service.status()).toMatchObject({ state: "ready", error: "computer_use_coordinate_target_unavailable", lastCall: { tool: "click", outcome: "error" } });
    expect(f.call).toHaveBeenCalledTimes(5);
    expect(f.stop).not.toHaveBeenCalled();
    state = await f.invoke("computer_state", { app: "com.apple.TextEdit" }) as ComputerUseResult;
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Computer Use server error: noWindowsAvailable" }] });
    const missingWindow = await f.invoke("computer_action", { app: "com.apple.TextEdit", snapshotId: JSON.parse(state.content[0]!.text as string).snapshotId, action: "click", arguments: { x: 10, y: 10 }, reason: "Test fixture target" }) as ComputerUseResult;
    expect(JSON.parse(missingWindow.content[0]!.text as string)).toMatchObject({ error: "computer_use_no_action_window", observation: "unavailable" });
    expect(f.service.status()).toMatchObject({ state: "ready", error: "computer_use_no_action_window", lastCall: { tool: "click", outcome: "error", error: "computer_use_no_action_window" } });
    expect(f.diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "error", error: "computer_use_no_action_window" }));
    expect(f.call).toHaveBeenCalledTimes(7);
    expect(f.stop).not.toHaveBeenCalled();
    state = await f.invoke("computer_state", { app: "com.apple.TextEdit", includeActionSchemas: true }) as ComputerUseResult;
    expect(JSON.parse(state.content[0]!.text as string)).toHaveProperty("actionSchemas.press_key");
    await f.invoke("computer_action", { app: "com.apple.TextEdit", snapshotId: JSON.parse(state.content[0]!.text as string).snapshotId, action: "press_key", arguments: { key: "Command+Shift+," }, reason: "Disposable shortcut target" });
    expect(f.call).toHaveBeenCalledWith("press_key", { app: "com.apple.TextEdit", key: "super+shift+comma" });
  });

  it("refuses coordinates without a current image but preserves element actions and selection provenance", async () => {
    const f = setup();
    await f.invoke("computer_state", { app: "com.apple.TextEdit" });
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Menu tree without image" }] });
    const state = await f.invoke("computer_state", { app: "com.apple.TextEdit" }) as ComputerUseResult;
    const metadata = JSON.parse(state.content[0]!.text as string);
    expect(metadata).toMatchObject({ imageAvailable: false, coordinateActionsAvailable: false });
    const base = { app: "com.apple.TextEdit", snapshotId: metadata.snapshotId, reason: "Disposable menu" };
    const coordinates = await f.invoke("computer_action", { ...base, action: "click", arguments: { x: 12, y: 34 } }) as ComputerUseResult;
    expect(JSON.parse(coordinates.content[0]!.text as string)).toMatchObject({ error: "computer_use_screenshot_required", actionOutcome: "not_started" });
    const empty = await f.invoke("computer_action", { ...base, action: "set_value", arguments: { element_index: "1", value: "" } }) as ComputerUseResult;
    expect(JSON.parse(empty.content[0]!.text as string)).toMatchObject({ error: "computer_use_empty_value_unsupported", actionOutcome: "not_started" });
    expect(f.call).toHaveBeenCalledTimes(2);
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Pay special attention to the content selected by the user" }] });
    const selected = await f.invoke("computer_action", { ...base, action: "select_text", arguments: { element_index: "1", text: "sample" } }) as ComputerUseResult;
    expect(selected.isError).toBe(false);
    const texts = selected.content.filter((block) => block.type === "text").map((block) => String(block.text));
    expect(texts.findIndex((text) => text.includes('"selectionSource":"agent_requested_selection"'))).toBeLessThan(texts.findIndex((text) => text.includes("Pay special attention")));
    expect(f.call).toHaveBeenCalledWith("select_text", { app: "com.apple.TextEdit", element_index: "1", text: "sample" });
    const followUpMeta = selected.content.filter((block) => block.type === "text").map((block) => { try { return JSON.parse(String(block.text)); } catch { return {}; } }).find((value) => value.snapshotId);
    expect(followUpMeta).toMatchObject({ snapshotScope: "broker_session", selectionSource: "not_established", lastAgentAction: { action: "select_text", outcome: "returned" } });
    expect(f.stop).not.toHaveBeenCalled();
    const nextMeta = selected.content.filter((block) => block.type === "text").map((block) => { try { return JSON.parse(String(block.text)); } catch { return {}; } }).find((value) => value.snapshotId);
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Pay special attention to the content selected by the user" }] });
    const keyboard = await f.invoke("computer_action", { ...base, snapshotId: nextMeta.snapshotId, action: "press_key", arguments: { key: "super+a" } }) as ComputerUseResult;
    const keyboardTexts = keyboard.content.filter((block) => block.type === "text").map((block) => String(block.text));
    const provenance = keyboardTexts.findIndex((text) => text.includes('"observationSource":"agent_action_response"'));
    expect(provenance).toBeGreaterThanOrEqual(0);
    expect(provenance).toBeLessThan(keyboardTexts.findIndex((text) => text.includes("Pay special attention")));
    expect(JSON.parse(keyboardTexts[provenance]!)).toMatchObject({ selectionSource: "not_established", trust: "untrusted_app_content" });
  });

  it("ends only its owner's session and accepts exact app names without claiming capture release", async () => {
    const f = setup();
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Fleet Console — /Applications/Fleet Console.app/ — com.example.fleet [frontmost, running]\nFleet Console — /Users/test/Applications/Fleet Console.app — com.example.fleet" }] });
    const inventory = await f.invoke("computer_apps", {}) as ComputerUseResult;
    expect(JSON.parse(inventory.content[0]!.text as string).targets.map((target: { app: string }) => target.app)).toEqual(["/Applications/Fleet Console.app", "/Users/test/Applications/Fleet Console.app"]);
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Ambiguous app identifier 'com.example.fleet'. Multiple apps share this bundle identifier: /Applications/Fleet Console.app, /Volumes/Fleet/Fleet Console.app. Use an app name or full app path instead." }] });
    const ambiguous = await f.invoke("computer_state", { app: "com.example.fleet" }) as ComputerUseResult;
    expect(JSON.parse(ambiguous.content[0]!.text as string).candidates.map((target: { app: string }) => target.app)).toEqual(expect.arrayContaining(["/Applications/Fleet Console.app", "/Volumes/Fleet/Fleet Console.app"]));
    await f.invoke("computer_state", { app: "Fleet Console" });
    expect(f.call).toHaveBeenCalledWith("get_app_state", { app: "Fleet Console" });
    expect(await f.invoke("computer_end", {}, "session-b")).toMatchObject({ isError: true });
    expect(f.stop).not.toHaveBeenCalled();
    const ended = await f.invoke("computer_end", {}) as ComputerUseResult;
    expect(ended.isError).toBe(false);
    expect(JSON.parse(ended.content[0]!.text as string)).toMatchObject({ ended: true, captureStopped: "unverified", reconnect: "on_next_use", warning: "computer_use_cleanup_unconfirmed" });
    expect(f.service.status()).toMatchObject({ error: null, warning: "computer_use_cleanup_unconfirmed" });
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.service.status()).toMatchObject({ state: "idle", apps: [] });
  });

  it("binds desktop ownership and discards a late result when its session ends", async () => {
    const f = setup();
    const controller = new AbortController();
    let complete!: () => void;
    f.call.mockImplementationOnce(() => new Promise((resolve) => { complete = () => resolve({ content: [{ type: "text", text: "late" }] }); }));
    const pending = f.invoke("computer_state", { app: "com.apple.TextEdit" }, "session-a", controller.signal);
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    expect(f.service.status()).toMatchObject({ activeTool: "computer_state", stage: "get_app_state", state: "running" });
    expect(await f.invoke("computer_state", { app: "com.apple.TextEdit" }, "session-b")).toMatchObject({ isError: true });
    controller.abort();
    complete();
    expect(await pending).toMatchObject({ isError: true });
    await f.service.stop();
    expect(f.stop).toHaveBeenCalled();
    expect(f.service.status()).toMatchObject({ state: "idle", apps: [] });
    await f.invoke("computer_apps", {}, "session-b");
    expect(f.start).toHaveBeenCalledTimes(2);
  });
});
