import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isHostSessionToolAllowed } from "@fleet-console/agent-runtime/fleet";
import { createFleetCliRuntime, type FleetCliRuntime } from "../../cli/runtime/runtime.js";

describe("fleet-cli gateway MCP composition", () => {
  let runtime: FleetCliRuntime | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("gives a fleet session no MCP server of its own", async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-cli-runtime-"));
    runtime = await createFleetCliRuntime({ dataDir });
    const endpoint = await runtime.dedicatedMcpSession.getEndpoint();
    const tokens = await runtime.dedicatedMcpSession.issueSessionToken({
      label: "gateway-host",
      cwd: process.cwd(),
      includeTool: (toolId) => isHostSessionToolAllowed(toolId),
    });

    // 이 런타임은 자기 세션에 아무 MCP 서버도 싣지 않는다. 한때는 라우팅 가이드와 모델
    // 로스터를 읽히려고 게이트웨이 서버 하나를 실었는데, 배정이 Console로 옮겨간 뒤로
    // 읽힐 것이 없다. Codex Wiki 같은 다른 표면이 이 자리로 새어 들어오지 않는 것이
    // 이 줄이 지키는 계약이다.
    expect(endpoint.servers).toEqual([]);
    expect(tokens).toEqual([]);
  });
});
