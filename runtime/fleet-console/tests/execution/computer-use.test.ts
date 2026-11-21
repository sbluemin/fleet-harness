import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MACOS_COMPUTER_USE_TRANSPORT } from "@fleet-console/computer-use/codex-transport";
import { ComputerUseService } from "../../features/computer-use/host/computer-use.js";
import type { DeviceTool } from "../../features/computer-use/host/computer-use-input.js";
import { computerUseTools } from "../../features/computer-use/host/computer-use-tools.js";
import { FleetHelperClient, type HelperWindow } from "../../features/computer-use/runtime/fleet-helper.js";
import { createComputerUseMcpHost } from "../../features/computer-use/host/mcp.js";
import { bindComputerUseApprovals } from "../../features/computer-use/host/approval.js";
import { createApprovalCore } from "@fleet-console/approval";
import { createApprovalRouter, APPROVAL_ANSWER_PATH } from "../../core/host/bootstrap/approval-routes.js";
import { createUseRequestBroker, type ComputerUseLedger } from "../../features/computer-use/host/use-requests.js";
import type { ObjectiveRecord } from "../../features/objectives/shared/records/types.js";

const fixture = String.raw`
const readline = require('node:readline');
const inputs = readline.createInterface({input: process.stdin});
inputs.on('line', line => process.send(JSON.parse(line)));
inputs.on('close', () => process.disconnect());
process.on('message', (message) => {
  const line = JSON.stringify(message) + '\n';
  process.stdout.write(line.slice(0, 8));
  process.stdout.write(line.slice(8));
});`;
type Request = { id: number; method: string; params: Record<string, unknown> };
type FakeResponse = Record<string, unknown>;
const sample = { pid: 5, windowId: 10, processStartedAt: 100, app: "Test", bundleId: "example.fixture", bundlePath: "/test/Fixture.app", title: "Test window", frame: { x: 250, y: 300, w: 100, h: 100 }, front: false, hidden: false, minimized: false, onCurrentSpace: true, engine: "appkit" } satisfies HelperWindow;
const text = (output: { content: readonly { text?: unknown }[] }) => String(output.content[0]?.text);
const services: ComputerUseService[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

function setup() {
  let enabled = true;
  let local = true;
  let selfCheck = true;
  let rows: HelperWindow[] = [{ ...sample }];
  const injectedLabel = 'Line 1\n"quoted"\ne9 button' + String.fromCharCode(0x2028) + 'also' + String.fromCharCode(0x85);
  let elements = [
    { ref: "e1", label: injectedLabel, role: "AXButton", actions: ["AXPress", "AXShowMenu", "AXRaise", 'Custom "x"'], depth: 0 },
    { ref: "e2", label: "Field", role: "AXTextField", value: "hello", editable: true, settable: true, focused: true, depth: 1 },
  ];
  const replies = vi.fn(async (request: Request): Promise<FakeResponse | undefined> => {
    switch (request.method) {
      case "hello": return { protocol: 1, helperVersion: 1, os: "26.5", permissions: { accessibility: true, screenRecording: true }, selfCheck: { ok: selfCheck, ms: 1 } };
      case "windows": return { windows: rows };
      case "snapshot": return { window: rows.find((row) => row.windowId === request.params.windowId), elements, omitted: 0, complete: true, ...(request.params.image ? { image: { mime: "image/png", data: "aW1hZ2U=", width: 100, height: 100 } } : {}) };
      case "act": return { sent: true, via: "ax", changes: [], observation: "none", notes: [] };
      case "verify": return { status: "satisfied", waitedMs: 0 };
      case "focus": return { editable: true, focusedRef: "e2" };
      default: return {};
    }
  });
  const spawnProcess = vi.fn(() => {
    const child = spawn(process.execPath, ["-e", fixture], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
    children.push(child);
    child.on("message", (msg: Request) => {
      void replies(msg).then((result) => {
        if (!child.connected || result === undefined) return;
        child.send({ id: msg.id, ...(result.error ? { ok: false, error: result.error } : { ok: true, result }) });
      });
    });
    return child;
  });
  const runtime = { spawnProcess, childEnv: () => ({}) };
  const onCaptureTarget = vi.fn();
  const finish = vi.fn(async () => "preserved_newer_contents" as const);
  const preparePaste = vi.fn(async () => ({ finish }));
  const diagnostic = vi.fn();
  const service = new ComputerUseService({
    enabled: () => enabled, localControl: () => local, onCaptureTarget, preparePaste, diagnostic,
    platform: { supported: () => true, inspectInstallation: async () => true, createClient: () => new FleetHelperClient(runtime, "/signed/fleet-computer-use") },
  });
  services.push(service);
  const invoke = (tool: DeviceTool, args: unknown, owner = "owner", actor?: string) => service.execute(tool, args, owner, undefined, { actor });
  const calls = (method: string) => replies.mock.calls.filter(([req]) => req.method === method).map(([req]) => req.params);
  const action = (args: Record<string, unknown>, actor?: string) => invoke("computer_action", { window: "w1", reason: "test", ...args }, "owner", actor);
  return { service, invoke, action, runtime, calls, replies, onCaptureTarget, preparePaste, finish, diagnostic,
    enable: (value: boolean) => { enabled = value; }, local: (value: boolean) => { local = value; }, check: (value: boolean) => { selfCheck = value; },
    get rows() { return rows; }, set rows(value) { rows = value; }, get elements() { return elements; }, set elements(value) { elements = value; } };
}

type McpResult = { isError: boolean; content: { type: string; text?: string }[] };
async function connect(host: ReturnType<typeof createComputerUseMcpHost>) {
  const connection = host.connect();
  const endpoint = (await connection.getEndpoint()).servers[0]!;
  const createToken = (label: string) => connection.issueSessionToken({ label, cwd: process.cwd() });
  const rpc = async (token: string, method: string, params = {}) => (await fetch(endpoint.url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })).json();
  const call = async (token: string, name: string, args = {}): Promise<McpResult> => (await rpc(token, "tools/call", { name, arguments: args })).result;
  return { connection, createToken, rpc, call };
}
const objective = (id: string, computerUse?: ObjectiveRecord["computerUse"]): ObjectiveRecord => ({ id, commodoreId: "c", theaterId: "t", type: "agent", pluginId: null, title: id, geometry: null, ts: { createdAt: 0, updatedAt: 0 }, computerUse });
const allowed = { enabled: true, language: "en" } as const;

describe("Fleet Computer Use", () => {
  it("does not start the helper for status, disabled use, or a remote session; reports capture identity and releases on end", async () => {
    const f = setup();
    expect(text(await f.invoke("computer_session", { op: "status" }))).toContain("helper not started");
    f.enable(false);
    expect(text(await f.invoke("computer_apps", {}))).toContain("computer_use_disabled");
    f.enable(true); f.local(false);
    expect(text(await f.invoke("computer_apps", {}))).toContain("computer_use_local_only");
    expect(f.runtime.spawnProcess).not.toHaveBeenCalled();
    f.local(true);
    expect(text(await f.invoke("computer_apps", {}))).toContain('w1 "Test window"');
    expect(f.runtime.spawnProcess).toHaveBeenCalledWith({ command: "/signed/fleet-computer-use", args: [], env: {} });
    expect(text(await f.invoke("computer_session", { op: "status" }))).toBe("status: enabled · helper ready · permissions ok · idle");
    const observation = await f.invoke("computer_state", { window: "w1" });
    expect(observation.content).toHaveLength(1);
    expect(f.onCaptureTarget).toHaveBeenLastCalledWith({ pid: 5, windowId: 10, processStartedAt: 100, title: "Test window", owner: "owner" });
    expect(text(await f.invoke("computer_apps", {}, "outsider"))).toContain("computer_use_busy");
    expect(text(await f.invoke("computer_session", { op: "end" }, "outsider"))).toContain("computer_use_foreign_session");
    expect(text(await f.invoke("computer_session", { op: "end" }))).toBe("end: left; device released");
    expect(f.calls("shutdown")).toHaveLength(1);
    expect(f.service.activeOwner()).toBeNull();
    expect(f.onCaptureTarget).toHaveBeenLastCalledWith(null);
  });

  it("keeps observation available after self-check failure and correlates replies without replaying timed-out input", async () => {
    const f = setup();
    f.check(false);
    await f.invoke("computer_apps", {});
    expect((await f.invoke("computer_state", { window: "w1" })).isError).toBe(false);
    expect(text(await f.action({ action: "key", key: "Tab" }))).toContain("not sent: self_check_failed");
    expect(f.calls("act")).toHaveLength(0);
    await f.service.stop();
    f.check(true);
    const client = new FleetHelperClient(f.runtime, "/signed/fleet-computer-use", 200);
    await client.start();
    let release!: () => void;
    f.replies.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { windows: [] }; });
    const first = client.request("windows", {});
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(client.request("windows", {})).resolves.toMatchObject({ windows: [{ windowId: 10 }] });
    release();
    await expect(first).resolves.toEqual({ windows: [] });
    f.replies.mockResolvedValueOnce(undefined);
    await expect(client.request("act", { action: "key", key: "Tab" })).rejects.toMatchObject({ code: "timeout", uncertain: true });
    expect(f.calls("act")).toHaveLength(1);
    await expect(client.stop()).resolves.toBe(true);
  });

  it("rejects missing and forbidden action inputs before any helper starts", async () => {
    const f = setup();
    const cases = [
      [{ action: "click", target: "e1", x: 1, y: 1, view: "v1" }, "target or both"],
      [{ action: "double_click", target: "e1", text: "unused" }, "text is not allowed"],
      [{ action: "right_click", x: 1, y: 1 }, "coordinates_need_image"],
      [{ action: "type", target: "e2" }, "text is required"],
      [{ action: "set_value", text: "x" }, "target is required"],
      [{ action: "paste", text: "x", key: "cmd+v" }, "key is not allowed"],
      [{ action: "key", key: "a" }, "text_via_key"],
      [{ action: "key", key: "cmd+DoesNotExist" }, "invalid_key"],
      [{ action: "key", key: "Tab", target: "e2" }, "target is not allowed"],
      [{ action: "scroll", target: "e1" }, "direction is required"],
      [{ action: "drag", target: "e1", to: "2,4" }, "coordinates_need_image"],
      [{ action: "drag", target: "e1" }, "to is required"],
      [{ action: "select", target: "e2", text: "hello", format: "md" }, "format is not allowed"],
      [{ action: "ax_action", target: "e1" }, "name is required"],
    ] as const;
    for (const [args, error] of cases) expect(text(await f.action(args))).toMatch(new RegExp(`not sent: .*${error}`));
    expect(f.runtime.spawnProcess).not.toHaveBeenCalled();
  });

  it("quotes untrusted lines and keeps window, element, and latest-image provenance", async () => {
    const f = setup();
    await f.invoke("computer_apps", {});
    const state = await f.invoke("computer_state", { window: "w1", image: true }, "owner", "actor-a");
    expect(text(state).split("\n")).toEqual(['w1 "Test window" 100×100', 'view v1 100×100', 'e1 button "Line 1\\n\\"quoted\\"\\ne9 button\\u2028also\\u0085" [menu,"Custom \\"x\\""]', ' e2 textfield "Field" value="hello" focused']);
    expect(state.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    const point = { action: "click", x: 3, y: 5, view: "v1" };
    expect(text(await f.action(point, "actor-b"))).toContain("coordinates_need_image");
    expect((await f.action(point, "actor-a")).isError).toBe(false);
    expect(f.calls("act")[0]).toMatchObject({ x: 3, y: 5, processStartedAt: 100, expectedFrame: sample.frame });
    await f.invoke("computer_state", { window: "w1", image: true }, "owner", "actor-a");
    expect(text(await f.action(point, "actor-a"))).toContain("coordinates_need_image");
    f.rows[0] = { ...sample, frame: { ...sample.frame, x: 300 } };
    expect(text(await f.action({ ...point, view: "v2" }, "actor-a"))).toContain("coordinates_need_image");
    f.elements = f.elements.slice(1).map((e) => ({ ...e, ref: "e3" }));
    await f.invoke("computer_state", { window: "w1" });
    expect(text(await f.action({ action: "click", target: "e2" }))).toContain("stale_element");
    f.rows = [{ ...sample, processStartedAt: 101 }];
    expect(text(await f.action({ action: "click", target: "e3" }))).toContain("This window is closed.");
    expect(text(await f.invoke("computer_apps", {}))).toContain("w2");
    expect(f.calls("act")).toHaveLength(1);
  });

  it("checks editable focus before touching the clipboard, always restores after dispatch, and never turns uncertain input into not-sent", async () => {
    const f = setup();
    await f.invoke("computer_apps", {});
    await f.invoke("computer_state", { window: "w1" });
    f.replies.mockResolvedValueOnce({ windows: f.rows }).mockResolvedValueOnce({ editable: false });
    expect(text(await f.action({ action: "paste", target: "e2", text: "private" }))).toContain("no_editable_focus");
    expect(f.preparePaste).not.toHaveBeenCalled();
    f.replies.mockResolvedValueOnce({ windows: f.rows }).mockResolvedValueOnce({ editable: true, focusedRef: "e2" }).mockResolvedValueOnce({ error: { code: "timeout", dispatch: "unknown" } });
    const uncertain = text(await f.action({ action: "paste", target: "e2", text: "private" }));
    expect(uncertain).toBe("paste e2: dispatch unknown: timeout — Check with computer_verify or computer_state; do not replay the action.\nclipboard: kept newer contents");
    expect(f.calls("act")).toEqual([{ pid: 5, windowId: 10, processStartedAt: 100, ref: "e2", action: "key", key: "cmd+v", requireEditableFocus: true }]);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.service.recentCalls("owner"))).not.toContain("private");
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain("private");
  });

  it("returns unknown rather than success for stale, ambiguous, or incomplete verification", async () => {
    const f = setup();
    const verify = (expect: unknown[]) => f.invoke("computer_verify", { window: "w1", expect });
    expect(text(await verify([{}]))).toContain("not sent: invalid_params");
    expect(f.runtime.spawnProcess).not.toHaveBeenCalled();
    await f.invoke("computer_apps", {});
    await f.invoke("computer_state", { window: "w1" });
    expect(text(await verify([{ target: "e9", exists: false }]))).toBe("unknown: #1 e9 is stale");
    f.replies.mockResolvedValueOnce({ windows: f.rows }).mockResolvedValueOnce({ status: "unknown", index: 0, reason: "ambiguous", waitedMs: 0 });
    expect(text(await verify([{ role: "button" }]))).toContain("matches multiple elements");
    f.replies.mockResolvedValueOnce({ windows: f.rows }).mockResolvedValueOnce({ status: "unknown", index: 0, reason: "incomplete", waitedMs: 0 });
    expect(text(await verify([{ role: "button", exists: false }]))).toContain("incomplete tree");
    expect(f.calls("verify").at(-1)).toMatchObject({ expect: [{ role: "AXButton", exists: false }] });
    f.replies.mockResolvedValueOnce({ windows: f.rows }).mockResolvedValueOnce({ status: "unsatisfied", index: 0, actual: { field: "value", value: "hello" }, waitedMs: 2000 });
    expect(text(await verify([{ target: "e2", value: "hello fleet" }]))).toBe('unsatisfied: #1 e2 value "hello" ≠ "hello fleet" after 2000ms');
  });

  it("advertises the exact device tool schemas and holds both Objective session operations", async () => {
    const f = setup();
    const record = objective("a");
    const requests = { hold: vi.fn(async () => "declined" as const) };
    const host = createComputerUseMcpHost({ service: f.service, objectiveRecords: () => [record], requests, experimentEnabled: () => true });
    const { createToken, rpc, call, connection } = await connect(host);
    try {
      f.enable(false);
      expect(createToken("off")).toEqual([]);
      f.enable(true);
      const { token } = createToken("a")[0]!;
      const list = (await rpc(token, "tools/list")).result.tools;
      expect(list).toEqual(computerUseTools.map((t) => ({ ...t, description: `${t.description} Desktop calls may wait up to 4 min for device access in the Objective panel.` })));
      for (const op of ["status", "end"]) expect(text(await call(token, "computer_session", { op }))).toContain("declined_by_user");
      expect(requests.hold).toHaveBeenCalledTimes(2);
      expect(f.runtime.spawnProcess).not.toHaveBeenCalled();
      record.computerUse = allowed;
      expect((await call(token, "computer_apps")).isError).toBe(false);
      connection.releaseSessionToken("a");
      expect((await rpc(token, "tools/call", { name: "computer_apps", arguments: {} })).error).toBeDefined();
      await f.service.stop();
      expect(f.calls("shutdown")).toHaveLength(1);
    } finally { await host.dispose(); }
  });

  it("keeps the plugin gate and sends the unmodified device descriptions and schemas without a hold note", async () => {
    const f = setup();
    let enabled = false;
    const host = createComputerUseMcpHost({ service: f.service, experimentEnabled: () => true });
    const plugin = host.connectPlugin({ enabled: () => enabled })!;
    const [caller, receiver] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "computer-use-contract", version: "1" });
    await (plugin.embeddedServer as unknown as { instance: McpServer }).instance.connect(receiver);
    await client.connect(caller);
    try {
      const listed = (await client.listTools()).tools.map(({ name, description, inputSchema: { $schema: _sdkDialect, ...inputSchema } }) => ({ name, description, inputSchema }));
      expect(listed).toEqual(computerUseTools);
      expect(JSON.stringify((await client.callTool({ name: "computer_apps", arguments: {} })).content)).toContain("plugin_not_authorized");
      expect(f.runtime.spawnProcess).not.toHaveBeenCalled();
      enabled = true;
      expect((await client.callTool({ name: "computer_apps", arguments: {} })).isError).not.toBe(true);
    } finally { await client.close(); await host.dispose(); }
  });

  it("releases a shared group only after its last participant ends and does not share delivered views", async () => {
    const f = setup();
    const records = [objective("root", allowed), objective("peer")];
    const host = createComputerUseMcpHost({ service: f.service, objectiveRecords: () => records, experimentEnabled: () => true, useContext: (participantId) => ({ contextId: "root", participantId, shared: true }) });
    const { createToken, call } = await connect(host);
    try {
      const a = createToken("root")[0]!.token;
      const b = createToken("peer")[0]!.token;
      await call(a, "computer_apps");
      expect(text(await call(a, "computer_state", { window: "w1", image: true }))).toContain("view v1");
      expect(text(await call(b, "computer_action", { window: "w1", action: "click", x: 5, y: 5, view: "v1", reason: "test" }))).toContain("coordinates_need_image");
      expect(text(await call(a, "computer_session", { op: "end" }))).toBe("end: left; others still use the device");
      expect(f.calls("shutdown")).toHaveLength(0);
      expect(text(await call(b, "computer_session", { op: "end" }))).toBe("end: left; device released");
      expect(f.calls("shutdown")).toHaveLength(1);
    } finally { await host.dispose(); }
  });

  it("ends one computer-use request whether the panel or the approval route answers first", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-computer-approval-"));
    const approvals = createApprovalCore({ filePath: path.join(dir, "approvals.json") });
    const objectives: { id: string; computerUse?: { enabled: boolean; language: "en" | "ko" } }[] = [{ id: "op-a" }];
    let experiment = true;
    let ledger: ComputerUseLedger | null = null;
    const requests = createUseRequestBroker({ recheckMs: 60_000, computerLedger: () => ledger });
    const binding = bindComputerUseApprovals({
      core: approvals,
      experimentEnabled: () => experiment,
      language: () => "en",
      read: (id) => objectives.find((objective) => objective.id === id) as never ?? null,
      patch: (_id, input) => { objectives[0] = { ...objectives[0]!, ...input }; },
    });
    ledger = binding.ledger;
    let body: unknown;
    let replied = { status: 0, value: {} as { error?: string } };
    const router = createApprovalRouter({
      core: approvals,
      isAuthorized: () => true,
      readJsonBody: async () => body,
      writeJson: (_res, status, value) => { replied = { status, value: value as { error?: string } }; },
    });
    try {
      const held = requests.hold({ objectiveId: "op-a", capability: "computer", tool: "computer_session", authorized: () => objectives[0]?.computerUse?.enabled === true });
      const view = requests.list().requests.find((request) => request.capability === "computer");
      expect(view?.tools).toEqual(["computer_session"]);
      expect(approvals.snapshot().requests.map((request) => request.id)).toEqual([view!.id]);
      expect(approvals.snapshot().requests.some((request) => request.type !== "computer.use")).toBe(false);
      expect(requests.answer("op-a", view!.id, "always")).toEqual({ ok: true, capability: "computer" });
      expect(await held).toBe("always");
      expect(objectives[0]?.computerUse).toEqual({ enabled: true, language: "en" });
      expect(approvals.snapshot().requests).toEqual([]);
      expect(requests.list().requests).toEqual([]);
      body = { id: view!.id, decision: "always" };
      await router({ req: { method: "POST" } as never, res: {} as never, pathname: APPROVAL_ANSWER_PATH });
      expect(replied).toEqual({ status: 404, value: { error: "unknown_request" } });
      delete objectives[0]!.computerUse;
      experiment = false;
      const heldOff = requests.hold({ objectiveId: "op-a", capability: "computer", tool: "computer_apps", authorized: () => objectives[0]?.computerUse?.enabled === true });
      const offView = requests.list().requests.find((request) => request.capability === "computer");
      body = { id: offView!.id, decision: "always" };
      await router({ req: { method: "POST" } as never, res: {} as never, pathname: APPROVAL_ANSWER_PATH });
      expect(replied).toEqual({ status: 409, value: { error: "experiment_disabled" } });
      expect(approvals.snapshot().requests.map((request) => request.id)).toEqual([offView!.id]);
      expect(objectives[0]?.computerUse).toBeUndefined();
      expect(requests.answer("op-a", offView!.id, "deny")).toEqual({ ok: true, capability: "computer" });
      expect(await heldOff).toBe("declined");
    } finally {
      requests.dispose();
      binding.dispose();
      approvals.dispose();
      await rm(dir, { recursive: true, force: true });
    }
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

});
