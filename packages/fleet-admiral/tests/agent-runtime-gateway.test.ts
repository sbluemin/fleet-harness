import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
	createFleetGatewayAgentRuntimeLifecycle,
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
		lifecycle = await createFleetGatewayAgentRuntimeLifecycle({
			wikiToolSpecs: WIKI_TOOL_IDS.map(makeToolSpec),
			extraAgentTools: [makeToolSpec("gateway_models")],
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
