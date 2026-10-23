import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect } from "vitest";
import { it } from "vitest";
import { createMcpHttpTransport } from "../core/host/transport/mcp-http.js";
import { createAdmiralMcpHost } from "../features/execution/host/admiral-mcp.js";
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe("Admiral MCP registry", () => {
  it("binds Admiral MCP names, isolates sessions, resolves the caller Operation and its commodore, and pins commodore-bound tools to that commodore through registration and teardown", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-plugin-mcp-"));
    tempDirs.push(dir);
    let origin = "";
    const transport = createMcpHttpTransport(() => origin);
    const listener = http.createServer((req, res) => { if (!transport.handle(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
    // 호출자는 세션 라벨로만 푼다 — 모르는 라벨은 호출자 없이(fail-closed).
    // 사령관은 그 호출자의 소속에서만 나온다 — 호출자가 없으면 사령관도 없다.
    const mcp = createAdmiralMcpHost(transport.transport, {
      resolveCaller: (label) => (label === "op-1" ? { kind: "operation", operationId: "op-1" } : null),
      resolveCommodore: (caller) => (caller.kind === "operation" && caller.operationId === "op-1" ? "cmd-a" : null),
    });
    const first = mcp.connect();
    const second = mcp.connect();
    const unregister = mcp.register("fleet-demo", [{ name: "project", description: "Read session project", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 50 } } },
      execute: async (_args, context) => ({ content: [{ type: "text", text: `${context.cwd}|${context.caller?.kind === "operation" ? context.caller.operationId : "-"}|${context.commodoreId ?? "-"}` }], isError: false }),
    }], { commodoreScoped: true });
    try {
      const endpoint = await first.getEndpoint();
      expect(endpoint.servers.map((server) => server.name)).toEqual(["fleet-demo"]);
      expect(new URL(endpoint.servers[0]!.url).origin).toBe(origin);
      expect((await fetch(endpoint.servers[0]!.url, { method: "POST" })).status).toBe(401);
      expect((await fetch(endpoint.servers[0]!.url, { method: "POST", headers: { Origin: origin, Authorization: "Bearer fake" } })).status).toBe(404);
      const one = first.issueSessionToken({ label: "op-1", cwd: "/first" })[0]!;
      const two = second.issueSessionToken({ label: "op-1", cwd: "/second" })[0]!;
      const ghost = first.issueSessionToken({ label: "ghost", cwd: "/ghost" })[0]!;
      const call = async (token: string, args: Record<string, unknown> = {}) => {
        const response = await fetch(endpoint.servers[0]!.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project", arguments: args } }),
        });
        return { status: response.status, body: await response.json() };
      };
      expect((await call(one.token)).body).toMatchObject({ result: { content: [{ text: "/first|op-1|cmd-a" }] } });
      expect((await call(two.token)).body).toMatchObject({ result: { content: [{ text: "/second|op-1|cmd-a" }] } });
      expect((await call(ghost.token)).body).toMatchObject({ result: { content: [{ text: "/ghost|-|-" }] } });
      // 사령관 묶음(사령관 세션) — 세션 자리가 넘긴 cwd·사령관은 버리고 묶은 값으로만, 호출자 없이 부른다. 인자 선검사는 서빙 경로와 같다.
      const [bound] = mcp.bindCommodore("cmd-b", "/commodore/cmd-b");
      expect(bound?.name).toBe("fleet-demo");
      const boundProject = bound!.tools[0]!;
      expect(await boundProject.execute({}, { cwd: "/elsewhere", commodoreId: "cmd-a" })).toMatchObject({ content: [{ text: "/commodore/cmd-b|-|cmd-b" }] });
      expect(await boundProject.execute({ text: "x".repeat(51) }, { cwd: "/commodore/cmd-b" })).toMatchObject({ isError: true });
      // 플러그인에 닿기 전 선검사도 필드·한도를 알려야 한다. 입력 원문과 검증기 메시지는 싣지 않는다.
      const oversized = "private-answer-".repeat(4);
      const rejected = (await call(one.token, { text: oversized })).body.result;
      expect(rejected).toEqual({ content: [{ type: "text", text: JSON.stringify({ error: "Invalid MCP arguments", issues: [{ path: ["text"], code: "too_big", maximum: 50 }] }) }], isError: true });
      expect(JSON.stringify(rejected)).not.toContain(oversized);
      first.cleanup();
      expect((await call(one.token)).body).toMatchObject({ error: { code: -32602 } });
      expect((await call(two.token)).body).toMatchObject({ result: { content: [{ text: "/second|op-1|cmd-a" }] } });
      unregister();
      expect((await second.getEndpoint()).servers).toEqual([]);
      expect(mcp.bindCommodore("cmd-b", "/commodore/cmd-b")).toEqual([]);
      expect(await boundProject.execute({}, { cwd: "/commodore/cmd-b" })).toMatchObject({ isError: true, content: [{ text: "Admiral MCP is unavailable" }] });
    } finally {
      first.cleanup(); second.cleanup(); await mcp.dispose(); await transport.dispose();
      await new Promise<void>((resolve) => { listener.close(() => resolve()); listener.closeAllConnections(); });
    }
  });

});
