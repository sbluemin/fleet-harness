import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MACOS_COMPUTER_USE_TRANSPORT } from "@fleet-console/computer-use/codex-transport";
import { ComputerUseService } from "../../core/host/agent/computer-use.js";
import { ComputerUseInputError, type ComputerUseResult, type ComputerUseBackend } from "@fleet-console/computer-use";
import { createMacOSComputerUsePlatform } from "@fleet-console/computer-use";
import { createComputerUseMcpHost } from "../../core/host/mcp/computer-use.js";

const macOSComputerUsePlatform = createMacOSComputerUsePlatform({ resolveCodex: () => null, childEnv: () => ({}) });

// 기존 MCP 테스트는 읽기 전용 Console 목록뿐이다. 실제 기기 접근의 승인·소유권·회수 경계를 여기서 검증한다.
describe("Computer Use authorization and lifecycle", () => {
  const services: ComputerUseService[] = [];
  afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });

  // Existing native-image regression cases explicitly retain the visual mode.
  // null exercises the public default (no observation argument).
  function setup(observation: "text" | "text_and_image" | null = "text_and_image") {
    let enabled = true;
    let local = true;
    const call = vi.fn(async (): Promise<ComputerUseResult> => ({ content: [{ type: "text", text: "<app_state>app state</app_state>" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }));
    const preflight = vi.fn(async (_app: string, _allowActivation: boolean) => {});
    const inspectWindows = vi.fn<typeof macOSComputerUsePlatform.inspectWindows>(async (apps) => apps.map((app) => ({ app, status: "no_window", pid: 42, frontmost: false, hidden: false, windowCount: 0 })));
    const openApp = vi.fn<typeof macOSComputerUsePlatform.openApp>(async (app) => ({ requestDispatched: true, windowReady: true, windowState: { app, status: "available", pid: 42, frontmost: true, hidden: false, windowCount: 1 } }));
    const resolveTarget = vi.fn(macOSComputerUsePlatform.resolveTarget);
    const diagnostic = vi.fn();
    const onCaptureTarget = vi.fn();
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
      ["paste", { name: "paste", inputSchema: { type: "object", properties: { app: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 100_000 }, format: { type: "string", enum: ["text", "md", "html"] } }, required: ["app", "text", "format"], additionalProperties: false } }],
    ]) } as unknown as ComputerUseBackend;
    const service = new ComputerUseService({
      directory: "unused", diagnostic, onCaptureTarget, enabled: () => enabled, localControl: () => local,
      platform: { ...macOSComputerUsePlatform, preflight, inspectWindows, openApp, resolveTarget, supported: () => true, inspectInstallation: async () => true,
        createBroker: async (deps) => { approve = () => deps.approve({}); return broker; } },
    });
    services.push(service);
    const invoke = async (tool: string, input: unknown, sessionLabel = "session-a", signal?: AbortSignal) => await service.specs().find((spec) => spec.id === tool)!.execute(observation && (tool === "computer_state" || tool === "computer_action") ? { observation, ...input as Record<string, unknown> } : input, { cwd: "", sessionLabel, signal }) as ComputerUseResult;
    return { service, invoke, call, preflight, inspectWindows, openApp, resolveTarget, diagnostic, onCaptureTarget, start, stop, approve: () => approve!(), enable: (value: boolean) => { enabled = value; }, local: (value: boolean) => { local = value; } };
  }

  it("keeps window recovery explicit, owned, and separate from capture and stale input", async () => {
    const f = setup();
    const app = "/Applications/Fixture.app";
    f.resolveTarget.mockImplementation(async (value) => value);
    const input = { app, reason: "Reopen the requested fixture" };
    f.enable(false);
    expect((await f.invoke("computer_open", input)).isError).toBe(true);
    f.enable(true); f.local(false);
    expect((await f.invoke("computer_open", input)).isError).toBe(true);
    f.local(true);
    expect((await f.invoke("computer_open", { ...input, app: "Fixture" })).isError).toBe(true);
    expect(f.openApp).not.toHaveBeenCalled();
    expect((await f.invoke("computer_apps", { includeWindowState: true })).isError).toBe(true);
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: `Fixture — ${app} — test.fixture` }] });
    const inventory = await f.invoke("computer_apps", { query: app, includeWindowState: true });
    expect(JSON.parse(String(inventory.content[0]!.text)).windowStates).toEqual([expect.objectContaining({ status: "no_window", windowCount: 0 })]);
    expect(f.openApp).not.toHaveBeenCalled();
    const read = await f.invoke("computer_state", { app });
    const snapshotId = JSON.parse(String(read.content[0]!.text)).snapshotId;
    expect((await f.invoke("computer_open", input, "session-b")).isError).toBe(true);
    const callsBefore = f.call.mock.calls.length;
    const opened = await f.invoke("computer_open", input);
    expect(JSON.parse(String(opened.content[0]!.text))).toMatchObject({ requestDispatched: true, windowReady: true, snapshotId: null, retryPerformed: false });
    expect(f.openApp).toHaveBeenCalledTimes(1);
    expect(f.openApp).toHaveBeenLastCalledWith(app, expect.any(AbortSignal), false);
    expect(f.call).toHaveBeenCalledTimes(callsBefore);
    expect((await f.invoke("computer_action", { app, snapshotId, action: "press_key", arguments: { key: "Return" }, reason: "stale" })).isError).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(callsBefore);
    f.openApp.mockResolvedValueOnce({ requestDispatched: true, windowReady: false, windowState: { app, status: "unknown", pid: 42, frontmost: null, hidden: null, windowCount: null, reason: "window_lookup_failed" } });
    const unavailable = await f.invoke("computer_open", input);
    expect(unavailable.isError).toBe(true);
    expect(JSON.parse(String(unavailable.content[0]!.text))).toMatchObject({ requestDispatched: true, windowReady: false, windowState: { status: "unknown" } });
    expect(f.openApp).toHaveBeenCalledTimes(2);
    await f.service.stop();
    f.openApp.mockImplementationOnce(async (_app, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { requestDispatched: true, windowReady: false, windowState: { app, status: "unknown", pid: null, frontmost: null, hidden: null, windowCount: null } };
    });
    const controller = new AbortController();
    const pending = f.invoke("computer_open", input, "session-a", controller.signal);
    await vi.waitFor(() => expect(f.openApp).toHaveBeenCalledTimes(3));
    controller.abort();
    expect((await pending).isError).toBe(true);
    expect(f.service.activeOwner()).toBeNull();
  });

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
      expect((await connection.getEndpoint()).servers).toEqual([endpoint]);
      const off = connection.issueSessionToken({ label: "off", cwd: process.cwd() })[0]!;
      expect((await rpc(off.token, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toContain("computer_state");
      expect((await rpc(off.token, "tools/call", { name: "computer_state", arguments: { app: "com.apple.TextEdit" } })).result.isError).toBe(true);
      expect(f.call).not.toHaveBeenCalled();
      f.enable(true);
      expect((await connection.getEndpoint()).servers).toEqual([endpoint]);
      const on = connection.issueSessionToken({ label: "on", cwd: process.cwd() })[0]!;
      expect((await rpc(on.token, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["computer_apps", "computer_open", "computer_state", "computer_action", "computer_paste"]));
      f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "<app_state>App=Chrome (bundleID com.google.chrome.for.testing, pid 1)\nWindow: Fixture, URL: localhost</app_state>" }, { type: "image", mimeType: "image/png", data: "b2xk" }] });
      f.call.mockResolvedValueOnce({ captureWindow: { pid: 1, windowId: 42, processStartedAt: 123, title: "Fixture" }, content: [{ type: "text", text: '<app_state>App=Chrome (bundleID com.google.chrome.for.testing, pid 1)\nWindow: "Fixture", App: Chrome.\n0 standard window URL: localhost, Secondary Actions: Raise, Fixture - Chrome - Profile\nHTML 콘텐츠 Fixture\n27 증감자 (settable, float) 수량, Value: 1</app_state>' }, { type: "image", mimeType: "image/png", data: "bmV3" }] });
      const partial = await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.google.chrome.for.testing", fullTree: true } });
      expect(partial.result.isError).toBe(true);
      expect(JSON.parse(partial.result.content[0].text)).toMatchObject({ error: "computer_use_full_tree_unavailable", snapshotId: null });
      expect(JSON.parse(partial.result.content[0].text)).toMatchObject({ observationReads: 1 });
      expect(f.call).toHaveBeenCalledTimes(1); // No implicit refresh for incomplete Chrome trees.
      const read = await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.google.chrome.for.testing", observation: "text_and_image", fullTree: true } });
      expect(JSON.parse(read.result.content[0].text)).toMatchObject({ observationReads: 1, treeFormat: "full" });
      expect(read.result.isError).toBe(false);
      expect(read.result.content.filter((block: { type: string }) => block.type === "image")).toHaveLength(1);
      expect(JSON.stringify(read.result.content.filter((block: { type: string }) => block.type === "text"))).not.toContain("aW1hZ2U=");
      expect(f.call).toHaveBeenCalledTimes(2);
      const capture = f.onCaptureTarget.mock.lastCall?.[0];
      expect(capture).toMatchObject({ pid: 1, title: "Fixture" });
      expect(host.operationIdForOwner(capture.owner)).toBe("on");
      const captureCalls = f.onCaptureTarget.mock.calls.length;
      f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "No changes" }] });
      await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.google.chrome.for.testing" } });
      expect(f.onCaptureTarget).toHaveBeenCalledTimes(captureCalls);
      f.call.mockResolvedValueOnce({ captureWindow: { pid: 2, windowId: 43, processStartedAt: 124, title: "" }, content: [{ type: "text", text: 'App=Gemini (bundleID com.google.GeminiMacOS, pid 2)\nWindow: "", App: Gemini.\n0 standard window Gemini - Conversation, Secondary Actions: Raise' }] });
      await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.google.GeminiMacOS" } });
      expect(f.onCaptureTarget.mock.lastCall?.[0]).toMatchObject({ pid: 2, title: "" });
      // 턴 종료는 기기만 놓고 같은 MCP 토큰의 다음 턴은 다시 사용할 수 있다.
      connection.cancelSession("on");
      expect(f.onCaptureTarget).toHaveBeenLastCalledWith(null);
      await f.service.stop();
      expect(f.service.activeOwner()).toBeNull();
      await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.google.GeminiMacOS" } });
      expect(f.start).toHaveBeenCalledTimes(2);
      connection.releaseSessionToken("on");
      expect(f.onCaptureTarget).toHaveBeenLastCalledWith(null);
      expect(host.operationIdForOwner(capture.owner)).toBeNull();
      expect((await rpc(on.token, "tools/call", { name: "computer_state", arguments: { app: "com.apple.TextEdit" } })).error).toBeDefined();
      expect(f.call).toHaveBeenCalledTimes(5);
      await f.service.stop();
      expect(f.stop).toHaveBeenCalled();
    } finally { await host.dispose(); }
  });

  it("revoking an Operation aborts a call that passed authorization but has not claimed the device yet", async () => {
    // 인가는 통과했지만 대상을 풀고 있는(파일시스템 대기) 사이에 허용이 거둬지면, 그 호출은 기기에 닿지 않아야 한다.
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markResolving!: () => void;
    const resolving = new Promise<void>((resolve) => { markResolving = resolve; });
    const operations = [{ id: "op-a", theaterId: "t", type: "agent", pluginId: null, title: "A", payload: { computerUse: { enabled: true, language: "en" } } as Record<string, unknown>, geometry: null, ts: { createdAt: 0, updatedAt: 0 } }];
    const service = new ComputerUseService({
      directory: "unused", enabled: () => true, localControl: () => true,
      platform: { ...macOSComputerUsePlatform, supported: () => true, inspectInstallation: async () => true, resolveTarget: async (app) => { markResolving(); await gate; return app; }, createBroker: async () => { throw new Error("device must not be claimed"); } },
    });
    services.push(service);
    const host = createComputerUseMcpHost({ service, operations: () => operations, experimentEnabled: () => true });
    const connection = host.connect();
    try {
      const endpoint = (await connection.getEndpoint()).servers[0]!;
      const token = connection.issueSessionToken({ label: "op-a", cwd: process.cwd() })[0]!.token;
      const pending = fetch(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_state", arguments: { app: "/Applications/TextEdit.app" } } }) });
      await resolving;
      operations[0]!.payload = {};
      host.revokeOperation("op-a");
      release();
      const result = (await (await pending).json()).result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: "computer_use_session_unavailable" });
      expect(service.status().state).toBe("idle");
    } finally { await host.dispose(); }
  });

  it("refuses every device tool until the caller Operation is allowed, and revoking drops its device session", async () => {
    // 콘솔 사용과 같은 정책: 실험 플래그와 호출자 Operation의 토글이 둘 다 참일 때만 통과하고,
    // 거부는 어느 스위치가 꺼졌는지와 어디서 켜는지를 에이전트에게 말한다. 회수는 진행 중인 기기 소유를 놓는다.
    const f = setup();
    let experiment = true;
    const operations = [{ id: "op-a", theaterId: "t", type: "agent", pluginId: null, title: "A", payload: {} as Record<string, unknown>, geometry: null, ts: { createdAt: 0, updatedAt: 0 } }];
    const host = createComputerUseMcpHost({ service: f.service, operations: () => operations, experimentEnabled: () => experiment, language: () => "ko" });
    const connection = host.connect();
    try {
      const endpoint = (await connection.getEndpoint()).servers[0]!;
      const token = connection.issueSessionToken({ label: "op-a", cwd: process.cwd() })[0]!.token;
      const call = async (name: string, args = {}) => (await (await fetch(endpoint.url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      })).json()).result as { isError: boolean; content: { text: string }[] };
      const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);
      const denied = await call("computer_state", { app: "com.apple.TextEdit" });
      expect(denied.isError).toBe(true);
      expect(parse(denied)).toMatchObject({ error: "computer_use_not_authorized", reason: "operation_not_authorized", retryable: true, remedy: { surface: "operation_panel", operationId: "op-a" } });
      expect(parse(denied).message).toContain("컴퓨터 사용");
      expect(f.call).not.toHaveBeenCalled();
      expect(parse(await call("computer_status"))).toMatchObject({ reason: "operation_not_authorized" });
      operations[0]!.payload = { computerUse: { enabled: true, language: "en" } };
      experiment = false;
      expect(parse(await call("computer_apps"))).toMatchObject({ error: "computer_use_not_authorized", reason: "experiment_disabled", remedy: { surface: "settings" } });
      experiment = true;
      const allowed = await call("computer_state", { app: "com.apple.TextEdit" });
      expect(allowed.isError).toBe(false);
      expect(f.call).toHaveBeenCalledTimes(1);
      expect(f.service.status().state).not.toBe("idle");
      operations[0]!.payload = {};
      host.revokeOperation("op-a");
      await f.service.stop();
      expect(f.stop).toHaveBeenCalledTimes(1);
      expect(parse(await call("computer_apps"))).toMatchObject({ reason: "operation_not_authorized" });
      expect(f.call).toHaveBeenCalledTimes(1);
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
    f.preflight.mockRejectedValueOnce(new ComputerUseInputError("computer_use_activation_blocked", "Target is minimized or not foreground"));
    expect(await f.invoke("computer_state", { app: "com.apple.TextEdit" })).toMatchObject({ isError: true });
    f.preflight.mockRejectedValueOnce(new ComputerUseInputError("computer_use_activation_blocked", "Target is minimized or not foreground"));
    expect(await f.invoke("computer_action", action)).toMatchObject({ isError: true });
    expect(f.call).toHaveBeenCalledTimes(1); // Refusal neither dispatches nor consumes the valid snapshot.
    const nativeActionTree = 'App=com.apple.TextEdit (pid 123)\nWindow: "Disposable", App: TextEdit.\n0 standard window Disposable\n\t12 text field (settable) Value: test';
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: nativeActionTree }, { type: "image", mimeType: "image/png", data: "b2xk" }] });
    const acted = await f.invoke("computer_action", { ...action, allowActivation: true }) as { content: { text: string }[] };
    expect(f.preflight).toHaveBeenLastCalledWith("com.apple.TextEdit", true);
    const nextSnapshot = JSON.parse(acted.content[1]!.text).snapshotId;
    expect(nextSnapshot).not.toBe(snapshotId);
    expect(acted.content.filter((block) => (block as unknown as { type: string }).type === "image")).toHaveLength(1);
    const outputText = JSON.stringify(acted.content.filter((block) => (block as unknown as { type: string }).type === "text"));
    expect(outputText).not.toContain("aW1hZ2U=");
    expect(JSON.parse(acted.content[1]!.text)).toMatchObject({ actionSchemasVersion: metadata.actionSchemasVersion, actionSchemasIncluded: false });
    expect(JSON.parse(acted.content[1]!.text)).not.toHaveProperty("actionSchemas");
    expect(outputText).not.toContain("actionResult");
    const actionRecords = acted.content.map((block) => { try { return JSON.parse(block.text).lastAgentAction; } catch { return null; } }).filter(Boolean);
    expect(actionRecords).toHaveLength(1);
    expect(actionRecords.every((record) => record.action === "type_text" && record.outcome === "returned")).toBe(true);
    expect(outputText.match(/12 text field/g)).toHaveLength(1);
    expect(JSON.parse(acted.content[0]!.text)).toMatchObject({ actionOutcome: "completed", observation: "completed", effectVerified: false });
    expect(f.call).toHaveBeenCalledWith("type_text", { app: "com.apple.TextEdit", text: "test" });
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: nativeActionTree }] });
    const chained = await f.invoke("computer_action", { ...action, snapshotId: nextSnapshot }) as { content: { text: string }[] };
    const chainedSnapshot = JSON.parse(chained.content[1]!.text).snapshotId;
    expect(chainedSnapshot).toEqual(expect.any(String));
    expect(chainedSnapshot).not.toBe(nextSnapshot);
    expect(JSON.parse(chained.content[1]!.text)).toMatchObject({ observationReads: 0 });
    expect(f.call.mock.calls.filter((args) => (args as unknown[])[0] === "get_app_state")).toHaveLength(1);
    f.enable(false);
    expect(await f.approve()).toBe(false);
    expect(await f.invoke("computer_apps", {})).toMatchObject({ isError: true });
    f.enable(true);
    f.local(false);
    expect(await f.approve()).toBe(false);
    f.local(true);
    expect(await f.invoke("computer_action", action)).toMatchObject({ isError: true });
    expect(f.call).toHaveBeenCalledTimes(3);
    expect(f.call.mock.calls.filter((args) => (args as unknown[])[0] === "type_text")).toHaveLength(2);
    expect(JSON.parse(acted.content[1]!.text)).toMatchObject({ observationReads: 0 });
    expect(f.stop).not.toHaveBeenCalled();
    f.call.mockRejectedValueOnce(new Error("computer_use_timeout_outcome_unknown"));
    const failedObservation = await f.invoke("computer_action", { ...action, snapshotId: chainedSnapshot }) as { content: { text: string }[]; isError: boolean };
    expect(failedObservation.isError).toBe(true);
    expect(JSON.parse(failedObservation.content[0]!.text)).toMatchObject({ actionOutcome: "unknown", observation: "failed" });
    expect(f.call).toHaveBeenCalledTimes(4);
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
    const replaced = await f.invoke("computer_action", { ...action, action: "set_value", arguments: { element_index: "1", value: "한글abcㅋ 가나다" } }) as ComputerUseResult;
    expect(f.call).toHaveBeenCalledWith("set_value", { app: "com.apple.TextEdit", element_index: "1", value: "한글abcㅋ 가나다" });
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ tool: "set_value", phase: "end", imageCount: 1, imageBytes: 5 }));
    const paste = { ...action, snapshotId: JSON.parse(replaced.content[1]!.text as string).snapshotId, text: "한글\n**서식**", format: "md" };
    expect(await f.invoke("computer_paste", { ...paste, format: "invalid" })).toMatchObject({ isError: true });
    expect(f.call).toHaveBeenCalledTimes(2);
    f.enable(false);
    expect(await f.invoke("computer_paste", paste)).toMatchObject({ isError: true });
    f.enable(true);
    f.preflight.mockRejectedValueOnce(new ComputerUseInputError("computer_use_activation_blocked", "Target is not frontmost"));
    const backgroundPaste = await f.invoke("computer_paste", paste) as ComputerUseResult;
    expect(JSON.parse(backgroundPaste.content[0]!.text as string)).toMatchObject({ error: "computer_use_activation_blocked", actionOutcome: "not_started" });
    expect(f.preflight).toHaveBeenLastCalledWith(action.app, false);
    expect(f.call).toHaveBeenCalledTimes(2);
    const pasted = await f.invoke("computer_paste", paste) as ComputerUseResult;
    expect(f.call).toHaveBeenCalledWith("paste", { app: action.app, text: paste.text, format: "md" }, { allowActivation: false });
    expect(JSON.parse(pasted.content[1]!.text as string)).toMatchObject({ observationReads: 0, imageDelivered: false, snapshotId: expect.any(String) });
    expect(pasted.content.some((block) => block.type === "image")).toBe(false);
    expect(await f.invoke("computer_paste", paste)).toMatchObject({ isError: true });
    expect(f.call).toHaveBeenCalledTimes(3);
    const nextPaste = { ...paste, snapshotId: JSON.parse(pasted.content[1]!.text as string).snapshotId };
    f.call.mockResolvedValueOnce({ isError: true, dispatchBlocked: true, content: [{ type: "text", text: '{"clipboardRestoration":"restored"}' }] });
    const lateRefusal = await f.invoke("computer_paste", nextPaste) as ComputerUseResult;
    expect(JSON.parse(lateRefusal.content[0]!.text as string)).toMatchObject({ error: "computer_use_activation_blocked", actionOutcome: "not_started", snapshotId: null });
    expect(await f.invoke("computer_paste", nextPaste)).toMatchObject({ isError: true });
    expect(f.call).toHaveBeenCalledTimes(4);
    const fresh = await f.invoke("computer_state", { app: action.app }) as ComputerUseResult;
    await f.invoke("computer_paste", { ...paste, snapshotId: JSON.parse(fresh.content[0]!.text as string).snapshotId, allowActivation: true });
    expect(f.call).toHaveBeenLastCalledWith("paste", { app: action.app, text: paste.text, format: "md" }, { allowActivation: true });
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
    expect(f.call).toHaveBeenCalledTimes(4);
    expect(f.stop).not.toHaveBeenCalled();
    state = await f.invoke("computer_state", { app: "com.apple.TextEdit" }) as ComputerUseResult;
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Computer Use server error: noWindowsAvailable" }] });
    const missingWindow = await f.invoke("computer_action", { app: "com.apple.TextEdit", snapshotId: JSON.parse(state.content[0]!.text as string).snapshotId, action: "click", arguments: { x: 10, y: 10 }, reason: "Test fixture target" }) as ComputerUseResult;
    expect(JSON.parse(missingWindow.content[0]!.text as string)).toMatchObject({ error: "computer_use_no_action_window", observation: "unavailable" });
    expect(f.service.status()).toMatchObject({ state: "ready", error: "computer_use_no_action_window", lastCall: { tool: "click", outcome: "error", error: "computer_use_no_action_window" } });
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ scope: "native_output", outcome: "error", error: "computer_use_no_action_window" }));
    expect(f.call).toHaveBeenCalledTimes(6);
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
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "<app_state>Pay special attention to the content selected by the user</app_state>" }] });
    const selected = await f.invoke("computer_action", { ...base, action: "select_text", arguments: { element_index: "1", text: "sample" } }) as ComputerUseResult;
    expect(selected.isError).toBe(false);
    const texts = selected.content.filter((block) => block.type === "text").map((block) => String(block.text));
    expect(texts.findIndex((text) => text.includes('"selectionSource":"agent_requested_selection"'))).toBeLessThan(texts.findIndex((text) => text.includes("Pay special attention")));
    expect(f.call).toHaveBeenCalledWith("select_text", { app: "com.apple.TextEdit", element_index: "1", text: "sample" });
    const followUpMeta = selected.content.filter((block) => block.type === "text").map((block) => { try { return JSON.parse(String(block.text)); } catch { return {}; } }).find((value) => value.snapshotId);
    expect(followUpMeta).toMatchObject({ snapshotScope: "broker_session", selectionSource: "not_established", lastAgentAction: { action: "select_text", outcome: "returned" } });
    expect(f.stop).not.toHaveBeenCalled();
    const nextMeta = selected.content.filter((block) => block.type === "text").map((block) => { try { return JSON.parse(String(block.text)); } catch { return {}; } }).find((value) => value.snapshotId);
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "<app_state>Pay special attention to the content selected by the user</app_state>" }] });
    const keyboard = await f.invoke("computer_action", { ...base, snapshotId: nextMeta.snapshotId, action: "press_key", arguments: { key: "super+a" } }) as ComputerUseResult;
    const keyboardTexts = keyboard.content.filter((block) => block.type === "text").map((block) => String(block.text));
    const provenance = keyboardTexts.findIndex((text) => text.includes('"observationSource":"agent_action_response"'));
    expect(provenance).toBeGreaterThanOrEqual(0);
    expect(provenance).toBeLessThan(keyboardTexts.findIndex((text) => text.includes("Pay special attention")));
    expect(JSON.parse(keyboardTexts[provenance]!)).toMatchObject({ selectionSource: "not_established", trust: "untrusted_app_content" });
  });

  function metadata(value: ComputerUseResult) {
    return value.content.flatMap((block) => {
      if (block.type !== "text") return [];
      try { return [JSON.parse(String(block.text))]; } catch { return []; }
    }).find((block) => block.snapshotId);
  }

  it("defaults to text, separates captured/delivered images and gates all coordinate actions", async () => {
    const f = setup(null);
    const app = "com.apple.TextEdit";
    const state = await f.invoke("computer_state", { app }) as ComputerUseResult;
    expect(state.content.some((block) => block.type === "image")).toBe(false);
    expect(metadata(state)).toMatchObject({ imageAvailable: true, imageDelivered: false, coordinateActionsAvailable: false, observationMode: "text_only" });
    expect(f.call).toHaveBeenCalledWith("get_app_state", { app });
    const base = { app, snapshotId: metadata(state).snapshotId, reason: "Synthetic coordinate test" };
    for (const action of ["click", "scroll", "drag"]) {
      const blocked = await f.invoke("computer_action", { ...base, action, arguments: { x: 12, y: 34 }, observation: "text_and_image" }) as ComputerUseResult;
      expect(JSON.parse(String(blocked.content[0]!.text))).toMatchObject({ error: "computer_use_screenshot_required", actionOutcome: "not_started" });
    }
    expect(f.call).toHaveBeenCalledTimes(1);
    // Pre-dispatch failures preserve the snapshot for a valid element action.
    const edited = await f.invoke("computer_action", { ...base, action: "set_value", arguments: { element_index: "1", value: "한글" } }) as ComputerUseResult;
    expect(edited.isError).toBe(false);
    expect(metadata(edited)).toMatchObject({ imageDelivered: false });
    expect(edited.content.some((block) => block.type === "image")).toBe(false);

    const visual = await f.invoke("computer_state", { app, observation: "text_and_image" }) as ComputerUseResult;
    expect(metadata(visual)).toMatchObject({ imageAvailable: true, imageDelivered: true, coordinateActionsAvailable: "unverified" });
    expect(visual.content.filter((block) => block.type === "image")).toHaveLength(1);
    const stale = await f.invoke("computer_action", { ...base, action: "click", arguments: { x: 12, y: 34 } }) as ComputerUseResult;
    expect(JSON.parse(String(stale.content[0]!.text)).error).toBe("computer_use_fresh_state_required");
    const clicked = await f.invoke("computer_action", { ...base, snapshotId: metadata(visual).snapshotId, action: "click", arguments: { x: 12, y: 34 } }) as ComputerUseResult;
    expect(clicked.isError).toBe(false);
    expect(metadata(clicked)).toMatchObject({ imageDelivered: false, coordinateActionsAvailable: false });
    // The visual permission belongs to a snapshot, not a sticky app setting.
    const hidden = await f.invoke("computer_action", { ...base, snapshotId: metadata(clicked).snapshotId, action: "click", arguments: { x: 12, y: 34 } }) as ComputerUseResult;
    expect(JSON.parse(String(hidden.content[0]!.text)).error).toBe("computer_use_screenshot_required");
  });

  it("projects images out of errors and preserves the action diff without implicit recovery reads", async () => {
    const f = setup(null);
    const app = "com.apple.TextEdit";
    const initial = await f.invoke("computer_state", { app }) as ComputerUseResult;
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "<app_state>Changed element 12: 한글</app_state>" }, { type: "image", mimeType: "image/png", data: "b2xk" }] });
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "No changes" }, { type: "image", mimeType: "image/png", data: "bmV3" }] });
    const acted = await f.invoke("computer_action", { app, snapshotId: metadata(initial).snapshotId, action: "press_key", arguments: { key: "Tab" }, reason: "Synthetic diff" }) as ComputerUseResult;
    const text = acted.content.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
    expect(text).not.toContain("No changes");
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(text).toContain("한글");
    expect(acted.content.some((block) => block.type === "image")).toBe(false);
    const explicitRead = await f.invoke("computer_state", { app }) as ComputerUseResult;
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "noWindowsAvailable" }, { type: "image", mimeType: "image/png", data: "b2xk" }] });
    const failed = await f.invoke("computer_action", { app, snapshotId: metadata(explicitRead).snapshotId, action: "press_key", arguments: { key: "Tab" }, reason: "Synthetic error" }) as ComputerUseResult;
    expect(failed.isError).toBe(true);
    expect(failed.content.some((block) => block.type === "image")).toBe(false);
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "cgWindowNotFound" }] });
    const unavailable = await f.invoke("computer_state", { app }) as ComputerUseResult;
    expect(unavailable.isError).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(5);
    const recovered = await f.invoke("computer_state", { app }) as ComputerUseResult;
    expect(metadata(recovered)).toMatchObject({ observationReads: 1, imageAvailable: true, imageDelivered: false });
    expect(recovered.content.some((block) => block.type === "image")).toBe(false);
  });

  it("accounts for final output separately, bounds wrapper text, and never logs payloads", async () => {
    const f = setup(null);
    const app = "Synthetic";
    await f.invoke("computer_state", { app });
    const state = await f.invoke("computer_state", { app }) as ComputerUseResult;
    expect(metadata(state)).toMatchObject({ actionSchemasIncluded: false });
    expect(metadata(state)).not.toHaveProperty("actionSchemas");
    const output = await f.invoke("computer_action", { app, snapshotId: metadata(state).snapshotId, action: "press_key", arguments: { key: "Tab" }, reason: "Private reason sentinel" }) as ComputerUseResult;
    const textChars = output.content.reduce((n, block) => n + (block.type === "text" ? String(block.text).length : 0), 0);
    expect(textChars).toBeLessThan(1500); // Previous no-change action wrapper alone was ~2,800 chars.
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ scope: "native_output", tool: "press_key", imageCount: 1, imageBytes: 5 }));
    expect(f.diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "model_output", tool: "computer_action", textChars, imageCount: 0, imageBytes: 0 }));
    const logs = JSON.stringify(f.diagnostic.mock.calls);
    expect(logs).not.toContain("Private reason sentinel");
    expect(logs).not.toContain("app state");
    expect(logs).not.toContain("aW1hZ2U=");
    const visual = await f.invoke("computer_state", { app, observation: "text_and_image" }) as ComputerUseResult;
    expect(f.diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "model_output", imageCount: 1, imageBytes: 5 }));
    expect(metadata(visual).imageDelivered).toBe(true);
    f.diagnostic.mockImplementation(() => { throw new Error("diagnostic unavailable"); });
    expect((await f.invoke("computer_state", { app }) as ComputerUseResult).isError).toBe(false);
  });

  it("rejects invalid observation modes before starting a broker and exposes the mode schema", async () => {
    const f = setup(null);
    for (const tool of ["computer_state", "computer_action"]) {
      const spec = f.service.specs().find((spec) => spec.id === tool)!;
      expect((spec.parameters as { properties: Record<string, unknown> }).properties.observation).toMatchObject({ enum: ["text", "text_and_image"], default: "text" });
      const denied = await f.invoke(tool, { app: "Synthetic", observation: "auto" }) as ComputerUseResult;
      expect(denied.isError).toBe(true);
    }
    expect(f.start).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
  });

  it("preserves default text and explicit visual modes through the HTTP MCP schema", async () => {
    const f = setup(null);
    const host = createComputerUseMcpHost({ service: f.service });
    const connection = host.connect();
    try {
      const endpoint = (await connection.getEndpoint()).servers[0]!;
      const token = connection.issueSessionToken({ label: "observation-modes", cwd: process.cwd() })[0]!.token;
      const read = async (observation?: string) => (await (await fetch(endpoint.url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_state", arguments: { app: "Synthetic", ...(observation ? { observation } : {}) } } }),
      })).json()).result as ComputerUseResult;
      const text = await read();
      expect(metadata(text)).toMatchObject({ imageAvailable: true, imageDelivered: false });
      expect(text.content.some((block) => block.type === "image")).toBe(false);
      const visual = await read("text_and_image");
      expect(metadata(visual)).toMatchObject({ imageDelivered: true });
      expect(visual.content.filter((block) => block.type === "image")).toHaveLength(1);
    } finally { await connection.dispose(); await host.dispose(); }
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

  it.skipIf(process.platform === "win32")("preserves MCP frames and approvals across the native compatibility transport", async () => {
    // 서비스 mock으로는 실제 자식의 UTF-8 프레임·승인 전달·EOF 회수 계약을 검증할 수 없다.
    const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-native-transport-"));
    const native = path.join(directory, "native-client");
    await writeFile(native, `#!${process.execPath}\nprocess.stdin.pipe(process.stdout);`, { mode: 0o700 });
    const child = spawn(process.execPath, ["-e", MACOS_COMPUTER_USE_TRANSPORT, native], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    try {
      const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { experimental: { "codex/auth-change": {}, retained: {} }, elicitation: { form: {} } }, clientInfo: { name: "codex", version: "0.154.0" } } };
      const input = JSON.stringify(initialize) + '\n' + JSON.stringify({ id: 2, result: { action: "decline", content: null } }) + '\n' + JSON.stringify({ method: "tools/call", params: { text: "한글 🚀", "codex/auth-change": "unchanged" } }) + '\n';
      const bytes = Buffer.from(input);
      const split = bytes.indexOf(Buffer.from("한글")) + 1;
      child.stdin.write(bytes.subarray(0, split));
      child.stdin.end(bytes.subarray(split));
      expect(await exited).toBe(0);
      const frames = output.trim().split('\n').map((line) => JSON.parse(line));
      expect(frames[0]).toEqual({ ...initialize, params: { ...initialize.params, capabilities: { experimental: { retained: {} }, elicitation: { form: {} } } } });
      expect(frames[1]).toEqual({ id: 2, result: { action: "decline", content: null } });
      expect(frames[2]).toEqual({ method: "tools/call", params: { text: "한글 🚀", "codex/auth-change": "unchanged" } });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses element handles only until verification or a new observation and never reuses old image coordinates", async () => {
    const f = setup();
    await f.service.setPlatform({ ...macOSComputerUsePlatform, supported: () => true, inspectInstallation: async () => true, boundedObservations: true, reusableElementSnapshots: true, verification: true,
      preflight: f.preflight, createBroker: async () => ({ start: f.start, stop: f.stop, call: f.call, cleanupStatus: "not_needed", threadReleaseStatus: "not_needed", cleanupFailure: null, tools: new Map([["click", { name: "click", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["app"], additionalProperties: false } }]]) }) });
    const state = await f.invoke("computer_state", { app: "Fixture", maxDepth: 4, includeScreenshot: false });
    expect(f.call).toHaveBeenLastCalledWith("get_app_state", { app: "Fixture", maxDepth: 4, includeScreenshot: false });
    const snapshotId = metadata(state).snapshotId;
    const action = { app: "Fixture", snapshotId, action: "click", arguments: { element_index: "1" }, reason: "Stable fixture button" };
    const first = await f.invoke("computer_action", action);
    expect(metadata(first)).toMatchObject({ snapshotId, snapshotReusable: "elements_only" });
    expect((await f.invoke("computer_action", action)).isError).toBe(false);
    const count = f.call.mock.calls.length;
    expect((await f.invoke("computer_action", { ...action, arguments: { x: 1, y: 1 } })).isError).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(count);
    await f.invoke("computer_verify", { app: "Fixture", expect: [{ window: { exists: true } }] });
    expect((await f.invoke("computer_action", action)).isError).toBe(true);
    const fresh = await f.invoke("computer_state", { app: "Fixture" });
    expect(metadata(fresh).snapshotId).not.toBe(snapshotId);
    expect((await f.invoke("computer_action", action)).isError).toBe(true);
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
    let finish!: () => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ content: [{ type: "text", text: "old backend" }] }); }));
    const previous = f.invoke("computer_state", { app: "Fixture" }, "session-b");
    await vi.waitFor(() => expect(f.service.status().activeTool).toBe("computer_state"));
    await f.service.setPlatform({ ...macOSComputerUsePlatform, supported: () => false });
    finish();
    expect(await previous).toMatchObject({ isError: true });
    expect(f.service.status()).toMatchObject({ supported: false, installation: "unchecked", apps: [] });
    expect(f.service.activeOwner()).toBeNull();
  });
});
