import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConsoleControl } from "../../core/host/mcp/console-control.js";
import { CONSOLE_CONTROL_TOOLS } from "@fleet-console/sdk/mcp";

import {
	type GatewayLoadout,
	type GatewayQuotaSnapshot,
	isHostSessionToolAllowed,
} from "@dotobokuri/fleet-admiral";
import { createAiGatewayMcpHost } from "../../core/host/mcp/ai-gateway.js";
import { createConsoleUseMcpHost } from "../../core/host/mcp/console-use.js";
import type { ConsoleUseMcpConnection } from "@fleet-console/sdk/mcp";

let lifecycle: ConsoleUseMcpConnection | undefined;

afterEach(async () => {
	await lifecycle?.dispose();
	lifecycle = undefined;
});

describe("fleet-console-use gateway roster", () => {
  it("requires blanket opt-in, deduplicates actions and bounds automation across restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "console-control-"));
    let time = Date.now();
    let enabled = false;
    let activity: "idle" | "running" = "idle";
    const operations = [{ id: "op-a", title: "Build", theaterId: "theater-a", type: "agent", pluginId: null, payload: {}, geometry: null, ts: { createdAt: 1, updatedAt: 1 } }];
    const deps = { enabled: () => enabled, directory, now: () => time, operations: () => operations, theaters: () => [{ id: "theater-a", name: "Project" }] };
    const control = createConsoleControl(deps);
    let executions = 0;
    const adapter = {
      observe: () => ({ activity, lifecycle: "live" as const, observedAt: new Date(time).toISOString(), source: "host" as const, attention: { kind: "none" as const }, surface: "chat" as const, supportedActions: ["send" as const], output: { status: "unavailable" as const, outcome: "unknown" as const } }),
      execute: async (_input: unknown, assertCurrent: () => void, settled: (result: "succeeded") => void) => { assertCurrent(); executions += 1; settled("succeeded"); return { operationId: "op-a", delivery: "confirmed" as const }; },
    };
    control.attach(adapter);
    const host = createConsoleUseMcpHost({ ...deps, control });
    const connection = host.connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true });
    try {
      const endpoint = (await connection.getEndpoint()).servers[0]!;
      const token = connection.issueSessionToken({ label: "op-a", cwd: directory })[0]!;
      const call = async (name: string, args: unknown) => {
        const response = await fetch(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        const json = await response.json();
        return JSON.parse(json.result.content[0].text);
      };
      expect((await call("console_context", {})).caller.operationId).toBe("op-a");
      const args = { requestId: "request-a", operationId: "op-a", text: "Check build" };
      expect((await call("console_send", args)).error).toBe("console_control_disabled");
      expect(executions).toBe(0);
      enabled = true;
      expect((await call("console_launch", { requestId: "empty", theaterId: "theater-a", text: "   " })).error).toBe("invalid_arguments");
      expect(control.state().actions).toHaveLength(0);
      expect(executions).toBe(0);
      const receipt = await call("console_send", args);
      expect(receipt.status).toBe("accepted");
      expect((await call("console_send", args)).id).toBe(receipt.id);
      await vi.waitFor(() => expect(control.getAction(receipt.id)?.status).toBe("finished"));
      expect(executions).toBe(1);
      expect((await call("console_send", args)).id).toBe(receipt.id);
      const conflicting = control.request({ kind: "operation", operationId: "op-a" }, "request-b", { kind: "send", operationId: "op-a", text: "Check build" });
      activity = "running";
      await vi.waitFor(() => expect(control.getAction(conflicting.id)?.error).toBe("conflict"));
      expect(executions).toBe(1);
      activity = "idle";
      const policy = control.automation({ kind: "operation", operationId: "op-a" }, { name: "Briefing", theaterId: "theater-a", trigger: { kind: "interval", minutes: 5 }, action: { kind: "briefing" }, expiresAt: new Date(time + 3600_000).toISOString(), maxRuns: 1 });
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
      enabled = false;
      time += 300_001;
      await control.tick();
      expect(control.state().automations.find((a) => a.id === pending.id)?.runs).toBe(0);
      expect(() => control.request({ kind: "operation", operationId: "op-a" }, "disabled", { kind: "send", operationId: "op-a", text: "No" })).toThrow("console_control_disabled");
      enabled = true;
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
    let enabled = true; let available = true; let time = Date.now(); let executions = 0;
    const deps = { enabled: () => enabled, directory, now: () => time, operations: () => [], theaters: () => [{ id: "theater-a", name: "Project" }], pluginAvailable: (id: string) => available && id === "scuttlebutt" };
    const control = createConsoleControl(deps);
    control.attach({ observe: () => null, execute: async (_input, assertCurrent, settled) => { assertCurrent(); executions++; settled("succeeded"); return { operationId: "new-op", delivery: "confirmed" }; } });
    const host = createConsoleUseMcpHost({ ...deps, control });
    const aide = host.forPlugin("scuttlebutt").connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true, enabled: () => enabled });
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
      expect((await call(other, "console_action", { actionId: receipt.id })).error).toBe("action_not_found");
      const policy = await call(aide, "console_automation", { mode: "propose", policy: { name: "Briefing", theaterId: "theater-a", trigger: { kind: "interval", minutes: 5 }, action: { kind: "briefing" }, expiresAt: new Date(time + 3600_000).toISOString(), maxRuns: 2 } });
      await aide.dispose();
      time += 300_001; await control.tick();
      expect(control.state().automations[0]).toMatchObject({ id: policy.id, runs: 1 });
      const nextChat = host.forPlugin("scuttlebutt").connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true, enabled: () => enabled });
      expect(await call(nextChat, "console_automation", { mode: "list" })).toHaveLength(1);
      enabled = false;
      expect((await call(nextChat, "console_launch", { ...args, requestId: "disabled" })).error).toBe("console_read_disabled");
      expect(executions).toBe(1);
      enabled = true; available = false;
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
    const b = host.connect({ tools: ["console_theaters", "console_operations"] });
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
      expect((await call(endpointA.url, tokenA.token, "console_theaters")).error).toBeDefined();
      expect((await call(endpointB.url, tokenA.token, "console_operations")).error).toBeDefined();
      enabled = false;
      expect((await call(endpointA.url, tokenA.token, "console_operations")).result.isError).toBe(true);
      a.releaseSessionToken("same-label");
      expect((await call(endpointA.url, tokenA.token, "console_operations")).error).toBeDefined();
      expect((await call(endpointB.url, tokenB.token, "console_theaters")).result).toBeDefined();
      await a.dispose();
      await expect(a.getEndpoint()).rejects.toThrow("disposed");
    } finally { await host.dispose(); }
  });
	it("snapshots only gateway host agent tools and starts a reachable-shaped endpoint", async () => {
		let models = ["cursor--grok-4.5", "codex--gpt-5.6-sol", "antigravity--gemini-3.8-flash"]
			.map((id) => {
				const model = findGatewayModel(id);
				if (!model) throw new Error(`missing catalog model: ${id}`);
				return model;
			});
		let quota: GatewayQuotaSnapshot | undefined = {
			claude: { status: "ok" },
			xai: { status: "ok" },
			codex: { status: "signed_out" },
			cursor: { status: "ok", windows: [{ id: "cycle", scope: "auto", usedPercent: 100 }] },
		};
		const host = createAiGatewayMcpHost({
            readSelection: () => ({ models, providerPriority: ["codex", "xai", "cursor", "antigravity"] }),
            readQuota: () => {
                if (!quota) throw new Error("quota unavailable");
                return quota;
            },
        });
        lifecycle = host.connect();

		const [serverToken] = lifecycle.issueSessionToken({
			label: "gateway-host",
			registeredAgentNames: ["fleet:cursor-grok-4-5-high"],
			cwd: process.cwd(),
			includeTool: (toolId) => isHostSessionToolAllowed(toolId),
		});
		expect(serverToken?.name).toBe("fleet-ai-gateway");
		const endpoint = await lifecycle.getEndpoint();
		expect(endpoint.servers).toHaveLength(1);
		expect(endpoint.servers[0]).toMatchObject({ name: "fleet-ai-gateway" });
		expect(new URL(endpoint.servers[0]!.url).protocol).toBe("http:");

		const response = await fetch(endpoint.servers[0]!.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${serverToken!.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
		});
		const payload = await response.json() as {
			readonly result: { readonly tools: readonly { readonly name: string }[] };
		};
		const toolIds = payload.result.tools.map((tool) => tool.name).sort();
		expect(toolIds).toEqual([]);
		expect(toolIds).not.toContain("carrier_dispatch");
		expect(toolIds).not.toContain("carrier_jobs");

		async function readLoadout(): Promise<GatewayLoadout> {
			const call = await fetch(endpoint.servers[0]!.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${serverToken!.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0", id: "loadout", method: "resources/read",
					params: { uri: "fleet://ai-gateway/models" },
				}),
			});
			const payload = await call.json() as {
				result: { contents: { text: string }[] };
			};
			return JSON.parse(payload.result.contents[0]!.text) as GatewayLoadout;
		}

		async function rpc(method: string, params = {}, token = serverToken!.token) {
			return (await fetch(endpoint.servers[0]!.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) })).json();
		}
		const initialized = await rpc("initialize");
		expect(initialized.result.capabilities).toEqual({ resources: {} });
		expect(initialized.result.instructions).toBeTruthy();
		const listed = await rpc("resources/list");
		expect(listed.result.resources.some((resource: { uri: string }) => resource.uri === "fleet://ai-gateway/models")).toBe(true);
		for (const resource of listed.result.resources) expect((await rpc("resources/read", { uri: resource.uri })).result.contents[0].text).toBeTruthy();
		expect((await rpc("resources/read", { uri: "fleet://ai-gateway/models" }, "foreign-token")).error).toBeDefined();
		expect((await rpc("resources/read", { uri: "file:///private/secret" })).error.code).toBe(-32002);
		const loadout = await readLoadout();
		expect(Object.keys(loadout.providers)).toEqual(["cursor", "antigravity"]);
		expect(loadout.providers.cursor?.models).toHaveLength(1);
		expect(loadout.providers.cursor?.models[0]).toMatchObject({ execution: { high: { availableNow: true, requiresNewSession: false }, low: { availableNow: false, requiresNewSession: true } } });
		expect(loadout.providers.cursor?.quota).toMatchObject({ windows: [{ pressure: "critical" }] });
		expect(loadout.providers.antigravity?.quota.status).toBe("unsupported");
		expect(loadout.quotaConsumptionPriority).toEqual({
			source: "user_settings",
			rankMeaning: "1_consumes_first",
			withinQualityBand: true,
			overridesQuotaPressure: true,
			fallback: "observed_failure_after_retry",
			providers: [{ provider: "cursor", rank: 1 }, { provider: "antigravity", rank: 2 }],
		});
		expect(loadout).not.toHaveProperty("providerPriority");

		quota = undefined;
		const unreadable = await readLoadout();
		expect(unreadable.revision).toBe(loadout.revision);
		expect(Object.keys(unreadable.providers)).toEqual(["cursor", "codex", "antigravity"]);
		expect(Object.values(unreadable.providers).every(({ quota }) => quota.status === "unsupported")).toBe(true);
		expect(unreadable.quotaConsumptionPriority?.providers).toEqual([
			{ provider: "codex", rank: 1 }, { provider: "cursor", rank: 2 }, { provider: "antigravity", rank: 3 },
		]);

		models = [];
		const empty = await readLoadout();
		expect(empty.providers).toEqual({});
		expect(empty).not.toHaveProperty("quotaConsumptionPriority");
		lifecycle.releaseSessionToken("gateway-host");
		expect((await rpc("resources/read", { uri: "fleet://ai-gateway/models" })).error).toBeDefined();
	});
});
