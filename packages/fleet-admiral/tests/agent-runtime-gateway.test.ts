import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
	buildGatewayModelsToolSpec,
	createFleetGatewayAgentRuntimeLifecycle,
	type GatewayLoadout,
	type GatewayQuotaSnapshot,
	isHostSessionToolAllowed,
	type FleetGatewayAgentRuntimeLifecycle,
} from "../src/index.js";

const WIKI_TOOL_IDS = [
	"wiki_briefing",
	"wiki_drydock",
	"wiki_ingest",
	"wiki_orient",
	"wiki_patch_edit",
	"wiki_patch_queue",
	"wiki_compile_source",
	"wiki_query",
	"wiki_read",
	"wiki_resolve",
	"wiki_schema_list",
	"wiki_schema_read",
	"wiki_schema_create",
] as const;

let lifecycle: FleetGatewayAgentRuntimeLifecycle | undefined;

afterEach(async () => {
	await lifecycle?.cleanup();
	lifecycle = undefined;
});

describe("createFleetGatewayAgentRuntimeLifecycle", () => {
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
		lifecycle = await createFleetGatewayAgentRuntimeLifecycle({
			wikiToolSpecs: WIKI_TOOL_IDS.map(makeToolSpec),
			extraAgentTools: [buildGatewayModelsToolSpec({
				readSelection: () => ({ models, providerPriority: ["codex", "xai", "cursor", "antigravity"] }),
				readQuota: () => {
					if (!quota) throw new Error("quota unavailable");
					return quota;
				},
			})],
		});

		const [serverToken] = lifecycle.dedicatedMcpSession.issueSessionToken({
			label: "gateway-host",
			cwd: process.cwd(),
			includeTool: (toolId) => isHostSessionToolAllowed(toolId),
		});
		expect(serverToken?.name).toBe("fleet");
		const endpoint = await lifecycle.dedicatedMcpSession.getEndpoint();
		expect(endpoint.servers).toHaveLength(1);
		expect(endpoint.servers[0]).toMatchObject({ name: "fleet" });
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
		expect(toolIds).toEqual([...WIKI_TOOL_IDS, "gateway_models"].sort());
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
					jsonrpc: "2.0", id: "loadout", method: "tools/call",
					params: { name: "gateway_models", arguments: {} },
				}),
			});
			const payload = await call.json() as {
				result: { content: { type: string; text: string }[]; isError: boolean };
			};
			expect(payload.result.isError).toBe(false);
			return JSON.parse(payload.result.content[0]!.text) as GatewayLoadout;
		}

		const loadout = await readLoadout();
		expect(Object.keys(loadout.providers)).toEqual(["cursor", "antigravity"]);
		expect(loadout.providers.cursor?.models).toHaveLength(1);
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
	});
});

function makeToolSpec(id: string): AgentToolSpec {
	return {
		id,
		tag: id,
		title: id,
		description: id,
		promptSnippet: id,
		whenToUse: [],
		whenNotToUse: [],
		usageGuidelines: [],
		parameters: {},
		async execute() {
			return "ok";
		},
	};
}
