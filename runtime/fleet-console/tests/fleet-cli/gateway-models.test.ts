import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConsoleControl } from "../../features/console-use/host/console-control.js";
import { CONSOLE_CONTROL_TOOLS } from "@fleet-console/sdk/mcp";

import { createConsoleUseMcpHost } from "../../features/console-use/host/console-use.js";
import type { ConsoleUseMcpConnection } from "@fleet-console/sdk/mcp";

let lifecycle: ConsoleUseMcpConnection | undefined;

afterEach(async () => {
	await lifecycle?.dispose();
	lifecycle = undefined;
});

describe("fleet-console-use host", () => {
  it("requires Operation authorization, deduplicates actions and bounds automation across restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "console-control-"));
    let time = Date.now();
    let activity: "idle" | "running" = "idle";
    const operations = [{ id: "op-a", title: "Build", theaterId: "theater-a", type: "agent", pluginId: null, payload: {} as Record<string, unknown>, geometry: null, ts: { createdAt: 1, updatedAt: 1 } }];
    const allow = (on: boolean) => { if (on) operations[0]!.payload = { consoleUse: { enabled: true, language: "ko" } }; else operations[0]!.payload = {}; };
    const deps = { directory, now: () => time, operations: () => operations, theaters: () => [{ id: "theater-a", name: "Project" }] };
    const control = createConsoleControl(deps);
    let executions = 0;
    const adapter = {
      observe: () => ({ activity, lifecycle: "live" as const, observedAt: new Date(time).toISOString(), source: "host" as const, attention: { kind: "none" as const }, surface: "chat" as const, supportedActions: ["send" as const], output: { status: "unavailable" as const, outcome: "unknown" as const } }),
      execute: async (_input: unknown, assertCurrent: () => void, settled: (result: "succeeded") => void) => { assertCurrent(); executions += 1; settled("succeeded"); return { operationId: "op-a", delivery: "confirmed" as const }; },
    };
    control.attach(adapter);
    const onOperationUse = vi.fn();
    const host = createConsoleUseMcpHost({ ...deps, control, onOperationUse, language: () => "ko" });
    const connection = host.connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true, operationCallers: true });
    try {
      const endpoint = (await connection.getEndpoint()).servers[0]!;
      const token = connection.issueSessionToken({ label: "op-a", cwd: directory })[0]!;
      const call = async (name: string, args: unknown) => {
        const response = await fetch(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        const json = await response.json();
        return JSON.parse(json.result.content[0].text);
      };
      // 도구가 실려 있다는 것이 허용이 아니다. 기본은 거부이고, 그 Operation의 토글이
      // 참일 때만 통과한다 — 거부는 어디를 켜야 하는지를 싣는다.
      const args = { requestId: "request-a", operationId: "op-a", text: "Check build" };
      for (const [name, body] of [["console_context", {}], ["console_operations", {}], ["console_send", args]] as const) {
        expect(await call(name, body)).toMatchObject({ error: "console_use_not_authorized", reason: "operation_not_authorized", retryable: true, remedy: { surface: "operation_panel", operationId: "op-a" } });
      }
      expect(executions).toBe(0);
      // 켜면 같은 연결·같은 토큰으로 다음 호출이 통과한다. 재연결도 재시작도 없다.
      allow(true);
      expect(onOperationUse).not.toHaveBeenCalled();
      expect((await call("console_context", {})).caller.operationId).toBe("op-a");
      await call("console_operations", {});
      expect(onOperationUse.mock.calls).toEqual([["op-a", true]]);
      expect((await call("console_launch", { requestId: "empty", theaterId: "theater-a", text: "   " })).error).toBe("invalid_arguments");
      expect(control.state().actions).toHaveLength(0);
      expect(executions).toBe(0);
      const receipt = await call("console_send", args);
      expect(receipt.status).toBe("accepted");
      expect((await call("console_send", args)).id).toBe(receipt.id);
      await vi.waitFor(() => expect(control.getAction(receipt.id)?.status).toBe("finished"));
      expect(executions).toBe(1);
      expect((await call("console_send", args)).id).toBe(receipt.id);
      control.automation({ kind: "operation", operationId: "op-a" }, { name: "Briefing", theaterId: "theater-a", trigger: { kind: "interval", minutes: 5 }, action: { kind: "briefing" }, expiresAt: new Date(time + 3600_000).toISOString(), maxRuns: 1 });
      time += 300_001;
      await control.tick();
      expect(control.state().automations[0]).toMatchObject({ runs: 1, briefing: { total: 1, unknown: 0 } });
      time += 300_001;
      await control.tick();
      expect(control.state().automations[0]?.status).toBe("exhausted");
      const automated = control.automation({ kind: "operation", operationId: "op-a" }, { name: "Check on idle", theaterId: "theater-a", trigger: { kind: "activity", operationId: "op-a", activity: "idle" }, action: { kind: "send", operationId: "op-a", text: "Run approved check" }, expiresAt: new Date(time + 3600_000).toISOString(), maxRuns: 1 });
      activity = "running"; await control.tick();
      activity = "idle"; await control.tick();
      await vi.waitFor(() => expect(executions).toBe(2));
      await control.tick();
      expect(control.state().automations.find((a) => a.id === automated.id)?.status).toBe("exhausted");
      const pending = control.automation({ kind: "operation", operationId: "op-a" }, { name: "Later", theaterId: "theater-a", trigger: { kind: "interval", minutes: 5 }, action: { kind: "briefing" }, expiresAt: new Date(time + 3600_000).toISOString(), maxRuns: 2 });
      // 허용을 거두면 이미 예약된 자동 운영도 더는 돌지 않는다 — 도구 호출만 막으면 여기가 우회로가 된다.
      allow(false);
      await vi.waitFor(() => expect(onOperationUse).toHaveBeenLastCalledWith("op-a", false));
      time += 300_001;
      await control.tick();
      expect(control.state().automations.find((a) => a.id === pending.id)).toMatchObject({ runs: 0, status: "paused", lastError: "owner_not_authorized" });
      allow(true);
      const cursor = (await control.readEvents()).cursor;
      control.dispose();
      const saved = JSON.parse(readFileSync(path.join(directory, "state.json"), "utf8"));
      const legacy = (row: { caller: { operationId: string } }) => { const { caller, ...rest } = row; return { ...rest, callerOperationId: caller.operationId }; };
      writeFileSync(path.join(directory, "state.json"), JSON.stringify({ version: 1, actions: saved.actions.map(legacy), automations: saved.automations.map(legacy) }));
      const restarted = createConsoleControl(deps);
      try {
        expect(restarted.state().automations.find((a) => a.id === pending.id)?.status).toBe("paused");
        expect(restarted.request({ kind: "operation", operationId: "op-a" }, "request-a", { kind: "send", operationId: "op-a", text: "Check build" }).id).toBe(receipt.id);
        await expect(restarted.readEvents(cursor)).rejects.toThrow("cursor_expired");
        for (let i = restarted.state().automations.length; i < 100; i += 1) restarted.automation({ kind: "operation", operationId: "op-a" }, { name: `Briefing ${i}`, theaterId: "theater-a", trigger: { kind: "interval", minutes: 5 }, action: { kind: "briefing" }, expiresAt: new Date(time + 1000).toISOString(), maxRuns: 1 });
        time += 2000;
        expect(() => restarted.automation({ kind: "operation", operationId: "op-a" }, { name: "Next briefing", theaterId: "theater-a", trigger: { kind: "interval", minutes: 5 }, action: { kind: "briefing" }, expiresAt: new Date(time + 3600_000).toISOString(), maxRuns: 1 })).not.toThrow();
        expect(restarted.state().automations.some((a) => a.id === pending.id)).toBe(true);
      } finally { restarted.dispose(); }
    } finally { await host.dispose(); control.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("binds aide execution to the host plugin owner without an Operation and revokes it on unload", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "console-aide-"));
    let granted = true; let available = true; let time = Date.now(); let executions = 0;
    const deps = { directory, now: () => time, operations: () => [], theaters: () => [{ id: "theater-a", name: "Project" }], pluginAvailable: (id: string) => available && id === "scuttlebutt" };
    const control = createConsoleControl(deps);
    control.attach({ observe: () => null, execute: async (_input, assertCurrent, settled) => { assertCurrent(); executions++; settled("succeeded"); return { operationId: "new-op", delivery: "confirmed" }; } });
    const host = createConsoleUseMcpHost({ ...deps, control });
    const aide = host.forPlugin("scuttlebutt").connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true, enabled: () => granted });
    const readOnly = host.forPlugin("scuttlebutt").connect({ tools: CONSOLE_CONTROL_TOOLS });
    const unbound = host.connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true });
    const other = host.forPlugin("other").connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true });
    const call = async (connection: ConsoleUseMcpConnection, name: string, args: unknown = {}) => {
      const endpoint = (await connection.getEndpoint()).servers[0]!;
      const token = connection.issueSessionToken({ label: "scuttlebutt", cwd: directory })[0]!;
      const response = await fetch(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const json = await response.json(); return JSON.parse(json.result.content[0].text);
    };
    try {
      expect(await call(aide, "console_context")).toMatchObject({ caller: { kind: "plugin", pluginId: "scuttlebutt" }, capabilities: { control: true } });
      const args = { requestId: "launch-a", theaterId: "theater-a", text: "Run the requested check" };
      expect((await call(readOnly, "console_launch", args)).error).toBe("permission_required");
      expect((await call(unbound, "console_launch", args)).error).toBe("permission_required");
      expect((await call(aide, "console_launch", { ...args, caller: { kind: "operation", operationId: "forged" } })).error).toBe("invalid_arguments");
      const receipt = await call(aide, "console_launch", args);
      expect(receipt).toMatchObject({ status: "accepted", caller: { kind: "plugin", pluginId: "scuttlebutt" } });
      await vi.waitFor(() => expect(control.getAction(receipt.id)?.status).toBe("finished"));
      expect((await call(aide, "console_launch", args)).id).toBe(receipt.id);
      expect(executions).toBe(1);
      // 영수증 조회 도구는 없다 — 다른 플러그인 소유자는 같은 requestId 로도 남의 영수증을 얻지 못한다(새 영수증이 선다).
      expect((await call(other, "console_launch", args)).id).not.toBe(receipt.id);
      // 자동화는 Console 에 자리가 없어 도구에서 빠졌다 — 남아 있는 정책은 제어층이 그대로 돌리되 연결이 닫혀도 산다.
      const policy = control.automation({ kind: "plugin", pluginId: "scuttlebutt" }, { name: "Briefing", theaterId: "theater-a", trigger: { kind: "interval", minutes: 5 }, action: { kind: "briefing" }, expiresAt: new Date(time + 3600_000).toISOString(), maxRuns: 2 });
      await aide.dispose();
      time += 300_001; await control.tick();
      expect(control.state().automations[0]).toMatchObject({ id: policy.id, runs: 1 });
      const nextChat = host.forPlugin("scuttlebutt").connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true, enabled: () => granted });
      expect((await call(nextChat, "console_context")).caller).toMatchObject({ kind: "plugin", pluginId: "scuttlebutt" });
      granted = false;
      expect((await call(nextChat, "console_launch", { ...args, requestId: "disabled" })).error).toBe("console_read_disabled");
      expect(executions).toBe(1);
      granted = true; available = false;
      expect((await call(nextChat, "console_launch", { ...args, requestId: "unloaded" })).error).toBe("caller_unavailable");
      time += 300_001; await control.tick();
      expect(control.state().automations[0]).toMatchObject({ status: "paused", runs: 1, lastError: "scope_unavailable" });
      control.dispose();
      const restarted = createConsoleControl(deps);
      try { expect(restarted.state().actions[0]?.caller).toEqual({ kind: "plugin", pluginId: "scuttlebutt" }); }
      finally { restarted.dispose(); }
    } finally { await host.dispose(); control.dispose(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("scopes Console reads per connection and revokes access without exposing server paths", async () => {
    let enabled = true;
    const host = createConsoleUseMcpHost({
      theaters: () => [{ id: "theater-a", name: "Project A" }],
      operations: () => [{ id: "op-a", title: "Build", theaterId: "theater-a", type: "agent", pluginId: "terminal", payload: { secret: "/private/transcript" }, geometry: null, ts: { createdAt: 1, updatedAt: 1 } }],
    });
    const a = host.connect({ tools: ["console_operations"], enabled: () => enabled, snapshot: () => ({ takenAt: new Date().toISOString(), theaters: [], operations: [{ id: "op-a", title: "Build", theaterId: "theater-a", type: "agent", activity: "running" }] }) });
    const b = host.connect({ tools: ["console_context", "console_operations"] });
    try {
      const endpointA = (await a.getEndpoint()).servers[0]!;
      const endpointB = (await b.getEndpoint()).servers[0]!;
      const tokenA = a.issueSessionToken({ label: "same-label", cwd: process.cwd() })[0]!;
      const tokenB = b.issueSessionToken({ label: "same-label", cwd: process.cwd() })[0]!;
      async function call(url: string, token: string, name: string, args: unknown = {}) {
        return (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
      }
      const first = await call(endpointA.url, tokenA.token, "console_operations");
      expect(JSON.parse(first.result.content[0].text)).toMatchObject({ snapshotAt: expect.any(String), operations: [{ activity: "running" }] });
      expect(JSON.stringify(first)).not.toContain("/private/transcript");
      const second = await call(endpointB.url, tokenB.token, "console_operations");
      expect(JSON.parse(second.result.content[0].text)).toMatchObject({ snapshotAt: null, operations: [{ activity: "unknown" }] });
      const filtered = await call(endpointB.url, tokenB.token, "console_operations", { activity: "awaiting" });
      expect(JSON.parse(filtered.result.content[0].text)).toMatchObject({ operations: [], coverage: { unknown: 1, complete: false } });
      expect((await call(endpointA.url, tokenA.token, "console_context")).error).toBeDefined();
      expect((await call(endpointB.url, tokenA.token, "console_operations")).error).toBeDefined();
      enabled = false;
      expect((await call(endpointA.url, tokenA.token, "console_operations")).result.isError).toBe(true);
      a.releaseSessionToken("same-label");
      expect((await call(endpointA.url, tokenA.token, "console_operations")).error).toBeDefined();
      expect((await call(endpointB.url, tokenB.token, "console_context")).result).toBeDefined();
      await a.dispose();
      await expect(a.getEndpoint()).rejects.toThrow("disposed");
    } finally { await host.dispose(); }
  });
});
