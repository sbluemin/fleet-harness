import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

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
  it("scopes Console reads per connection and revokes access without exposing server paths", async () => {
    let enabled = true;
    const host = createConsoleUseMcpHost({
      theaters: () => [{ id: "theater-a", name: "Project A" }],
      operations: () => [{ id: "op-a", title: "Build", theaterId: "theater-a", type: "agent", pluginId: "terminal", payload: { secret: "/private/transcript" }, geometry: null, ts: { createdAt: 1, updatedAt: 1 } }],
    });
    const a = host.connect({ tools: ["console_operations"], enabled: () => enabled, snapshot: () => ({ takenAt: "first", theaters: [], operations: [{ id: "op-a", title: "Build", theaterId: "theater-a", type: "agent", activity: "running" }] }) });
    const b = host.connect({ tools: ["console_theaters", "console_operations"] });
    try {
      const endpointA = (await a.getEndpoint()).servers[0]!;
      const endpointB = (await b.getEndpoint()).servers[0]!;
      const tokenA = a.issueSessionToken({ label: "same-label", cwd: process.cwd() })[0]!;
      const tokenB = b.issueSessionToken({ label: "same-label", cwd: process.cwd() })[0]!;
      async function call(url: string, token: string, name: string) {
        return (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) })).json();
      }
      const first = await call(endpointA.url, tokenA.token, "console_operations");
      expect(JSON.parse(first.result.content[0].text)).toMatchObject({ snapshotAt: "first", operations: [{ activity: "running" }] });
      expect(JSON.stringify(first)).not.toContain("/private/transcript");
      const second = await call(endpointB.url, tokenB.token, "console_operations");
      expect(JSON.parse(second.result.content[0].text)).toMatchObject({ snapshotAt: null, operations: [{ activity: "unknown" }] });
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
