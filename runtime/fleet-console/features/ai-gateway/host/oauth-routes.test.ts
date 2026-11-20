import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { RouteHandler } from "@fleet-console/infra/http/routing";
import { registerConsoleOAuthRoutes, type ConsoleOAuthRoutesTarget } from "./oauth-routes.js";

function mount(target: ConsoleOAuthRoutesTarget) {
  let handler!: RouteHandler;
  const writes: Array<{ status: number; payload: unknown }> = [];
  registerConsoleOAuthRoutes({
    basePath: "/api/v1",
    host: {
      http: {
        readJsonBody: async <T>(req: IncomingMessage) => (req as unknown as { body: T }).body,
        writeJson: (_res: ServerResponse, status: number, payload: unknown) => { writes.push({ status, payload }); },
      },
      security: { isTerminalAuthorized: () => true },
    },
    registerRouter: (_path, next) => { handler = next; },
  }, "claude", "Claude", target);
  const call = async (method: string, route: string, body: unknown = {}) => {
    const req = { method, url: `/api/v1/ai-gateway/oauth/claude${route}`, headers: { "content-type": "application/json" }, body } as unknown as IncomingMessage;
    const handled = await handler({ req, res: {} as ServerResponse, pathname: new URL(req.url!, "http://localhost").pathname } as Parameters<RouteHandler>[0]);
    return { handled, write: writes.at(-1) };
  };
  return { call };
}

describe("Claude sign-in routes", () => {
  // Claude에는 로그아웃이 없다(터미널 로그인까지 끊긴다). 라우트가 서지 않아야 하고, 코드는 응답에 되돌아오지 않아야 한다.
  it("serves paste but no logout, and never echoes a pasted code", async () => {
    const paste = vi.fn((loginId: string, code: unknown) => loginId === "gone" ? "not_found" as const : code === "bad" ? "invalid_code" as const : "accepted" as const);
    const test = mount({ start: vi.fn(), status: vi.fn(), cancel: vi.fn(), paste });
    expect((await test.call("POST", "/logout")).handled).toBe(false);
    const ok = await test.call("POST", "/paste", { loginId: "id", code: "abc#def" });
    expect(ok.write).toEqual({ status: 200, payload: { accepted: true } });
    expect(paste).toHaveBeenCalledWith("id", "abc#def");
    expect((await test.call("POST", "/paste", { loginId: "gone", code: "abc#def" })).write?.status).toBe(404);
    const rejected = await test.call("POST", "/paste", { loginId: "id", code: "bad" });
    expect(rejected.write).toEqual({ status: 400, payload: { error: "invalid_code" } });
    expect(JSON.stringify(rejected.write)).not.toContain("bad#");
    expect((await test.call("POST", "/paste", { loginId: "id" })).write?.status).toBe(400);
    expect((await test.call("POST", "/paste", { loginId: "id", code: "x#y", extra: 1 })).write?.status).toBe(400);
  });

  it("keeps the other providers' routes unchanged: logout, no paste", async () => {
    const test = mount({ start: vi.fn(), status: vi.fn(), cancel: vi.fn(), logout: vi.fn(async () => undefined) });
    expect((await test.call("POST", "/paste", { loginId: "id", code: "a#b" })).handled).toBe(false);
    expect((await test.call("POST", "/logout")).write).toEqual({ status: 200, payload: { signedIn: false } });
  });
});
