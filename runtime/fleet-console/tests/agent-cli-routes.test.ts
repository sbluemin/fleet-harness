import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createAgentCliRouter } from "../src/agent-cli-routes.js";
import type { AgentCliStatus } from "../src/agent-cli-types.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

const SAMPLE: readonly AgentCliStatus[] = [
  { id: "claude", displayName: "Claude Code", available: true, version: "2.1.0" },
  { id: "codex", displayName: "Codex CLI", available: false, version: null },
];

describe("agent cli routes", () => {
  it("GET /agent-cli/state returns the detected cli list", async () => {
    const harness = createRouterHarness(SAMPLE);
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/agent-cli/state" });
    expect(handled).toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: { clis: SAMPLE } }]);
  });

  it("never serializes a filesystem path into the payload", async () => {
    const harness = createRouterHarness(SAMPLE);
    await harness.router({ req: req("GET"), res: res(), pathname: "/agent-cli/state" });
    const body = harness.writes[0]?.body as { clis: readonly Record<string, unknown>[] };
    for (const entry of body.clis) {
      expect(entry).not.toHaveProperty("path");
    }
  });

  it("GET /agent-cli/state rejects non-GET methods with 405", async () => {
    const harness = createRouterHarness(SAMPLE);
    await harness.router({ req: req("POST"), res: res(), pathname: "/agent-cli/state" });
    expect(harness.writes[0]?.status).toBe(405);
    expect(harness.detectCalls).toBe(0);
  });

  it("returns false for unknown paths so the host can fall through", async () => {
    const harness = createRouterHarness(SAMPLE);
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/agent-cli/unknown" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
  });
});

function createRouterHarness(clis: readonly AgentCliStatus[]) {
  const writes: WriteJsonCall[] = [];
  let detectCalls = 0;
  const router = createAgentCliRouter({
    detect: async () => {
      detectCalls += 1;
      return clis;
    },
    writeJson: (_res, status, body) => {
      writes.push({ status, body });
    },
  });
  return { router, writes, get detectCalls() { return detectCalls; } };
}

function req(method: string): http.IncomingMessage {
  return { method, headers: {} } as unknown as http.IncomingMessage;
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}
