// @vitest-environment jsdom

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoginStart, LoginStatus, QuotaSummaryDto } from "@fleet-console/ai-gateway";
import type { CommodoreCliStatusView } from "../features/commodore/shared/contracts/cli-status.js";

import { createClientCapabilities } from "../core/client/src/integration/http-capabilities.js";
import { installCommodoreState, readCommodoreCliStatus } from "../features/commodore/client/commodore-state.js";
import {
  beginClaudeLogin, cancelLogin, disposeLogins, getLoginStates, openExternal, submitLoginCode,
} from "../features/quota/client/provider-login.js";

/**
 * console-e2e 공용 Claude 인증 page fixture(`claude-auth-fixture.mjs`)를 실제 Console client 함수로 소비해 본다.
 *
 * 안전 경계: nativeFetch는 호출되면 실패하는 센티널이다. 실제 브라우저·호스트·계정·Keychain·외부 호출은 없고, 합성 로그인 URL은
 * `.invalid`라 해석되지 않으며 `window.open`은 기록용 스텁이다. 통과는 client 계약을 합성 응답으로 소비했다는 뜻이다 —
 * 호스트 라우트·어댑터·실제 CLI·실제 인증의 증거가 아니고, fixture가 호스트 부팅의 다른 외부 경로를 막는다는 뜻도 아니다
 * (그 범위는 claude-auth-fixture.test.ts와 claude-login.test.ts 몫이고, 호스트 부팅의 외부 경로는 미검증이다).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE = path.join(repoRoot, ".claude/skills/console-e2e/scripts/claude-auth-fixture.mjs");
const ORIGIN = "http://localhost";

interface Fixture {
  readonly state: string;
  readonly loginUrl: string;
  readonly code: string;
  readonly routes: readonly { readonly method: string; readonly path: string }[];
  readonly hits: readonly { readonly method: string; readonly path: string; readonly outcome: string; readonly status: number }[];
  readonly opened: readonly string[];
  readonly fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
  install(target: object): void;
}
interface FixtureModule {
  createClaudeAuthFixture(options: { state: string; origin: string; nativeFetch: (...args: unknown[]) => unknown }): Fixture;
  buildInitScript(state: string): string;
  FIXTURE_STATES: readonly string[];
  FIXTURE_LOGIN_URL: string;
  FIXTURE_CODE: string;
}
const mod = (await import(pathToFileURL(MODULE).href)) as FixtureModule;

const sentinel = vi.fn((..._args: unknown[]): Promise<Response> => { throw new Error("nativeFetch must not be called"); });
const globals = globalThis as { fetch: unknown; open: unknown };
const originals = { fetch: globals.fetch, open: globals.open };
const roots: string[] = [];

function make(state: string): Fixture {
  return mod.createClaudeAuthFixture({ state, origin: ORIGIN, nativeFetch: sentinel });
}
function installOnPage(fixture: Fixture): void {
  fixture.install(window);
  globals.fetch = fixture.fetch;
  globals.open = window.open;
}
async function call(fixture: Fixture, method: string, route: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fixture.fetch(`${ORIGIN}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json() };
}
const client = () => createClientCapabilities().api;
const loginState = () => getLoginStates().claude;

beforeEach(() => { sentinel.mockClear(); disposeLogins(); });
afterEach(() => {
  globals.fetch = originals.fetch;
  globals.open = originals.open;
  disposeLogins();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("claude auth page fixture with the real Console client", () => {
  it("missing: cli-status reads missing and the sign-in start is refused locally", async () => {
    const fixture = make("missing");
    installOnPage(fixture);
    installCommodoreState({ api: client(), consoleEvents: { subscribe: () => () => undefined }, experiments: { read: () => null, subscribe: () => () => undefined } } as never);
    expect(await readCommodoreCliStatus("c-1")).toBe("missing");
    await beginClaudeLogin(client());
    expect(loginState()).toMatchObject({ phase: "failed", reason: "failed" });
    expect(fixture.hits.map((hit) => `${hit.method} ${hit.path} ${hit.outcome} ${hit.status}`)).toEqual([
      "POST /api/v1/commodore/cli-status synthetic 200",
      "POST /api/v1/quota/connect synthetic 200",
      "POST /api/v1/quota/claude/start synthetic 502",
    ]);
    expect(sentinel).not.toHaveBeenCalled();
    expect(fixture.opened).toEqual([]);
  });

  it("signedout: the client reaches a pending card with the synthetic page, accepts only the fixed code, and cancel ends it", async () => {
    const fixture = make("signedout");
    installOnPage(fixture);
    installCommodoreState({ api: client(), consoleEvents: { subscribe: () => () => undefined }, experiments: { read: () => null, subscribe: () => () => undefined } } as never);
    expect(await readCommodoreCliStatus("c-1")).toBe("signedout");
    await beginClaudeLogin(client());
    const pending = loginState();
    expect(pending).toMatchObject({ phase: "pending", url: mod.FIXTURE_LOGIN_URL, userCode: "", codeInUrl: false });
    expect(new URL(mod.FIXTURE_LOGIN_URL).hostname.endsWith(".invalid")).toBe(true);
    expect(await submitLoginCode(client(), "claude", "real-looking#code")).toBe("invalid");
    expect(await submitLoginCode(client(), "claude", mod.FIXTURE_CODE)).toBe("accepted");
    expect(loginState().phase).toBe("pending"); // signedout는 완료 신호를 주지 않는다.
    expect(await readCommodoreCliStatus("c-1")).toBe("signedout");
    cancelLogin(client(), "claude");
    expect(loginState().phase).toBe("idle");
    const id = (pending as { loginId: string }).loginId;
    await expect.poll(async () => (await call(fixture, "GET", `/api/v1/quota/claude/status?loginId=${id}`)).json).toEqual({ state: "cancelled" });
    expect((await call(fixture, "POST", "/api/v1/quota/claude/paste", { loginId: id, code: mod.FIXTURE_CODE })).status).toBe(409);
    expect(await readCommodoreCliStatus("c-1")).toBe("signedout"); // 취소 뒤 성공 후속 없음
    openExternal((pending as { url: string }).url);
    expect(fixture.opened).toEqual([mod.FIXTURE_LOGIN_URL]);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("success: a fixed synthetic code moves the client to signed_in and cli-status to ready", async () => {
    const fixture = make("success");
    installOnPage(fixture);
    installCommodoreState({ api: client(), consoleEvents: { subscribe: () => () => undefined }, experiments: { read: () => null, subscribe: () => () => undefined } } as never);
    expect(await readCommodoreCliStatus("c-1")).toBe("signedout");
    await beginClaudeLogin(client());
    expect(loginState().phase).toBe("pending");
    expect(await submitLoginCode(client(), "claude", mod.FIXTURE_CODE)).toBe("accepted");
    await expect.poll(() => loginState().phase, { timeout: 8000 }).toBe("signed_in");
    expect(await readCommodoreCliStatus("c-1")).toBe("ready");
    expect(sentinel).not.toHaveBeenCalled();
    // 코드·본문·쿼리는 어디에도 남지 않는다.
    expect(JSON.stringify(fixture.hits)).not.toContain(mod.FIXTURE_CODE);
    expect(Object.keys(fixture.hits[0]!).sort()).toEqual(["method", "outcome", "path", "status"]);
    expect(fixture.hits.every((hit) => !hit.path.includes("?"))).toBe(true);
  });

  it("fail: a fixed synthetic code moves the client to failed and cli-status stays signedout", async () => {
    const fixture = make("fail");
    installOnPage(fixture);
    installCommodoreState({ api: client(), consoleEvents: { subscribe: () => () => undefined }, experiments: { read: () => null, subscribe: () => () => undefined } } as never);
    await beginClaudeLogin(client());
    expect(await submitLoginCode(client(), "claude", mod.FIXTURE_CODE)).toBe("accepted");
    await expect.poll(() => loginState().phase, { timeout: 8000 }).toBe("failed");
    expect(await readCommodoreCliStatus("c-1")).toBe("signedout");
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("returns state skeletons shaped like the product DTOs, with no usage numbers", async () => {
    const fixture = make("success");
    const connect = await call(fixture, "POST", "/api/v1/quota/connect", { provider: "claude", connected: true });
    const expected: QuotaSummaryDto = {
      providers: {
        anthropic: { status: "not_connected" }, claude: { status: "signed_out" }, codex: { status: "not_connected" }, gemini: { status: "not_connected" },
        "muse-code": { status: "not_connected" }, opencode: { status: "not_connected" }, xai: { status: "not_connected" },
      },
    };
    expect(connect.json).toEqual(expected);
    expect((await call(fixture, "GET", "/api/v1/quota/summary?stale=1")).json).toEqual(expected);
    const start = (await call(fixture, "POST", "/api/v1/quota/claude/start", {})).json as LoginStart & { loginId: string };
    const shape: Omit<LoginStart, "loginId" | "expiresAt"> = { userCode: "", verificationUri: mod.FIXTURE_LOGIN_URL, interval: 1 };
    expect(start).toMatchObject(shape);
    const status: LoginStatus = (await call(fixture, "GET", `/api/v1/quota/claude/status?loginId=${start.loginId}`)).json as LoginStatus;
    expect(status).toEqual({ state: "pending" });
    const cli: CommodoreCliStatusView = (await call(fixture, "POST", "/api/v1/commodore/cli-status", { commodoreId: "c-1" })).json as CommodoreCliStatusView;
    expect(cli).toEqual({ status: "signedout" });
  });

  it("never passes a protected request to nativeFetch: other routes, direct Gateway paths, odd variants and Request inputs are refused locally", async () => {
    const fixture = make("success");
    const refused: [string, string, unknown?][] = [
      ["POST", "/api/v1/ai-gateway/oauth/claude/start", {}],
      ["POST", "/api/v1/ai-gateway/oauth/claude/paste", { loginId: "x", code: "a#b" }],
      ["GET", "/api/v1/ai-gateway/oauth/claude/status?loginId=x"],
      ["POST", "/api/v1/ai-gateway/oauth/codex/start", {}],
      ["POST", "/api/v1/ai-gateway/oauth/xai/logout", {}],
      ["GET", "/api/v1/ai-gateway/quota?force=1"],
      ["GET", "/api/v1/ai-gateway/quota?forceProvider=claude"],
      ["POST", "/api/v1/ai-gateway/quota/gemini-budget", { usd: "1" }],
      ["POST", "/api/v1/quota/codex/start", {}],
      ["POST", "/api/v1/quota/claude/logout", {}],
      ["POST", "/api/v1/quota/gemini-budget", { usd: "1" }],
      ["POST", "/api/v1/quota/connect", { provider: "codex", connected: true }],
      ["POST", "/api/v1/quota/connect", { provider: "claude", connected: true, extra: 1 }],
      ["POST", "/api/v1/quota/summary", {}],
      ["GET", "/api/v1/quota/summary?forceProvider=claude"],
      ["GET", "/api/v1/quota/connect"],
      ["PUT", "/api/v1/quota/claude/start", {}],
      ["POST", "/api/v1/quota/claude/start", { extra: 1 }],
      ["POST", "/api/v1/quota/claude/paste", { loginId: "x" }],
      ["GET", "/api/v1/quota/claude/status"],
      ["GET", "/api/v1/quota/claude/status?loginId=x&extra=1"],
      ["POST", "/api/v1/quota/claude/start/", {}],
      ["POST", "/api/v1/quota//claude/start", {}],
      ["POST", "/api/v1/quota%2Fclaude%2Fstart", {}],
      ["POST", "/api/v1/QUOTA/claude/start", {}],
      ["POST", "/api/v1/ai-gateway/oauth/../oauth/claude/start", {}],
      ["POST", "/api/v1/commodore/cli-status", {}],
      ["POST", "/api/v1/commodore/cli-status/extra", { commodoreId: "c" }],
      ["GET", "/api/v1/commodore/cli-status"],
      ["POST", "https://elsewhere.example/api/v1/quota/claude/start", {}],
      ["POST", "https://elsewhere.example/api/v1/ai-gateway/oauth/claude/start", {}],
      ["POST", "https://claude.com/api/v1/quota/connect", { provider: "claude", connected: true }],
    ];
    for (const [method, route, body] of refused) {
      const response = await fixture.fetch(route.startsWith("http") ? route : `${ORIGIN}${route}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${route}`).toBeGreaterThanOrEqual(400);
      expect(response.status, `${method} ${route}`).toBeLessThan(500);
    }
    // Request·URL 입력과 init 없는 본문도 같은 규칙이다.
    const asRequest = new Request(`${ORIGIN}/api/v1/ai-gateway/oauth/claude/start`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect((await fixture.fetch(asRequest)).status).toBe(404);
    expect((await fixture.fetch(new URL(`${ORIGIN}/api/v1/ai-gateway/quota`))).status).toBe(404);
    expect((await fixture.fetch(new Request(`${ORIGIN}/api/v1/quota/claude/start`, { method: "POST", body: "{}" }))).status).toBe(200);
    expect(sentinel).not.toHaveBeenCalled();
    expect(fixture.hits.filter((hit) => hit.outcome === "rejected").length).toBeGreaterThanOrEqual(refused.length);
  });

  it("passes requests outside the protected scope to nativeFetch unchanged", async () => {
    const forwarded = vi.fn(async () => new Response("{}", { status: 200 }));
    const fixture = mod.createClaudeAuthFixture({ state: "success", origin: ORIGIN, nativeFetch: forwarded as never });
    const init = { method: "GET" };
    await fixture.fetch(`${ORIGIN}/api/v1/agent/state`, init);
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveBeenCalledWith(`${ORIGIN}/api/v1/agent/state`, init);
    expect(fixture.hits).toEqual([]);
  });

  it("keeps two fixtures independent: one success and one failure do not touch each other", async () => {
    const a = make("success");
    const b = make("fail");
    const startA = (await call(a, "POST", "/api/v1/quota/claude/start", {})).json as { loginId: string };
    const startB = (await call(b, "POST", "/api/v1/quota/claude/start", {})).json as { loginId: string };
    expect(startA.loginId).toBe(startB.loginId); // 같은 번호가 나오는 별개 상태 — 서로 모른다.
    expect((await call(a, "POST", "/api/v1/quota/claude/paste", { loginId: startA.loginId, code: mod.FIXTURE_CODE })).status).toBe(200);
    expect((await call(a, "GET", `/api/v1/quota/claude/status?loginId=${startA.loginId}`)).json).toEqual({ state: "signed_in" });
    expect((await call(a, "POST", "/api/v1/commodore/cli-status", { commodoreId: "c" })).json).toEqual({ status: "ready" });
    expect((await call(b, "GET", `/api/v1/quota/claude/status?loginId=${startB.loginId}`)).json).toEqual({ state: "pending" });
    expect((await call(b, "POST", "/api/v1/commodore/cli-status", { commodoreId: "c" })).json).toEqual({ status: "signedout" });
    expect((await call(b, "POST", "/api/v1/quota/claude/paste", { loginId: startB.loginId, code: mod.FIXTURE_CODE })).status).toBe(200);
    expect((await call(b, "GET", `/api/v1/quota/claude/status?loginId=${startB.loginId}`)).json).toMatchObject({ state: "failed" });
    // B의 실패가 A의 성공을 지우지 않고, 새 fixture는 다시 미로그인에서 시작한다(정리 = 버리면 상태가 사라진다).
    expect((await call(a, "POST", "/api/v1/commodore/cli-status", { commodoreId: "c" })).json).toEqual({ status: "ready" });
    expect((await call(make("success"), "POST", "/api/v1/commodore/cli-status", { commodoreId: "c" })).json).toEqual({ status: "signedout" });
    expect(a.hits).toHaveLength(5);
    expect(b.hits).toHaveLength(5);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("generates a pre-navigation script from the same implementation, and the CLI refuses unsafe arguments", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-init-"));
    roots.push(root);
    const run = (args: string[]) => new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, [MODULE, ...args], { env: {} }, (error, stdout) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout }));
    });
    const out = path.join(root, "nested", "init.js");
    expect((await run(["--state", "success", "--out", out])).code).toBe(0);
    const script = fs.readFileSync(out, "utf8");
    expect((await run(["--state", "fail", "--out", out])).code).toBe(2);
    expect(fs.readFileSync(out, "utf8")).toBe(script);
    // 생성된 파일을 페이지처럼 실행해, 공개 명령의 결과로 동일한 차단 규칙을 적용할 수 있는지 본다.
    const page = { fetch: sentinel, open: undefined as unknown, __fleetE2EClaudeAuth: undefined as unknown };
    new Function("window", "location", script)(page, { origin: ORIGIN });
    const wrapped = page.fetch as (input: string, init?: RequestInit) => Promise<Response>;
    expect(wrapped).not.toBe(sentinel);
    expect((await wrapped(`${ORIGIN}/api/v1/ai-gateway/oauth/claude/start`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await wrapped(`${ORIGIN}/api/v1/quota/summary`)).status).toBe(200);
    expect((page.open as (url: string) => unknown)(mod.FIXTURE_LOGIN_URL)).toBeNull();
    expect((page.__fleetE2EClaudeAuth as { opened: string[] }).opened).toEqual([mod.FIXTURE_LOGIN_URL]);
    expect(sentinel).not.toHaveBeenCalled();
    expect((await run(["--state", "success", "--out", "relative.js"])).code).toBe(2);
    expect((await run(["--state", "pending", "--out", path.join(root, "x.js")])).code).toBe(2);
    expect((await run(["--state", "success", "--out", path.join(root, "x.txt")])).code).toBe(2);
    expect(fs.existsSync(path.join(root, "x.js"))).toBe(false);
    const link = path.join(root, "link.js");
    fs.symlinkSync(path.join(root, "elsewhere.js"), link);
    expect((await run(["--state", "success", "--out", link])).code).toBe(2);
    expect(fs.existsSync(path.join(root, "elsewhere.js"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
    expect(fs.existsSync(out)).toBe(false);
  });
});
