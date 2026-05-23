import { describe, expect, it } from "vitest";
import { resolveBuiltinExternalMcpServers } from "../../src/agent/external-mcp.js";
import { assertInternalMcpTokensNotShared } from "../../src/agent/internal/executor-engine.js";

describe("resolveBuiltinExternalMcpServers", () => {
  it("allowed가 없으면 빈 배열을 반환한다", () => {
    expect(resolveBuiltinExternalMcpServers()).toEqual([]);
    expect(resolveBuiltinExternalMcpServers([])).toEqual([]);
  });

  it("catalog에 없는 ID는 throw", () => {
    expect(() => resolveBuiltinExternalMcpServers(["missing_server"])).toThrow(/missing_server/);
  });

  it("내부 Fleet MCP 예약 ID는 throw", () => {
    expect(() => resolveBuiltinExternalMcpServers(["fleet-carriers"])).toThrow(/fleet-carriers/);
    expect(() => resolveBuiltinExternalMcpServers(["fleet-tools"])).toThrow(/fleet-tools/);
    expect(() => resolveBuiltinExternalMcpServers(["fleet-wiki"])).toThrow(/fleet-wiki/);
  });

  it("정규식 위반 ID는 throw", () => {
    expect(() => resolveBuiltinExternalMcpServers(["Bad.Server"])).toThrow(/Bad\.Server/);
  });

  it("정상 케이스에서 Authorization과 headers를 포함하지 않는다", () => {
    const servers = resolveBuiltinExternalMcpServers(["grep_app"]);

    expect(servers).toEqual([{
      type: "http",
      name: "grep_app",
      url: "https://mcp.grep.app",
      toolTimeout: 1800,
    }]);
    expect(servers[0]!.headers).toBeUndefined();
    expect(JSON.stringify(servers)).not.toContain("Authorization");
  });

  it("내부 MCP 토큰 재사용과 external 누수를 거부한다", () => {
    expect(() => assertInternalMcpTokensNotShared([], [
      { serverName: "fleet-carriers", token: "same-token" },
      { serverName: "fleet-wiki", token: "same-token" },
    ])).toThrow(/reused/);

    expect(() => assertInternalMcpTokensNotShared([
      {
        type: "http",
        name: "grep_app",
        url: "https://mcp.grep.app",
        headers: [{ name: "Authorization", value: "Bearer carriers-token" }],
      },
    ], [
      { serverName: "fleet-carriers", token: "carriers-token" },
      { serverName: "fleet-wiki", token: "wiki-token" },
    ])).toThrow(/leaked/);
  });
});
