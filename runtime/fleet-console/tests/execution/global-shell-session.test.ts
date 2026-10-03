import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ConsoleRuntimeContext } from "../../features/execution/host/context.js";
import type { RouteHandler } from "@fleet-console/sdk/routing";

import { GLOBAL_SHELL_SESSION_ID, registerShellRoutes } from "../../features/execution/host/terminal/shell.js";
import type { TerminalLaunchResolver, TerminalRuntime, TerminalTicketContext } from "../../features/execution/host/terminal/index.js";

/**
 * Shell은 콘솔 하나에 하나뿐인 전역 표면이다. 이 파일이 지키는 것은 두 가지다 —
 * 세션 키가 Operation id가 아니라 상수라는 것, 그리고 cwd가 첫 기동에 못 박혀
 * 사용자가 끝낼 때까지 Theater를 따라 움직이지 않는다는 것.
 */
describe("console-global Shell session", () => {
  it("keys the PTY on a console-wide constant rather than an Operation id", async () => {
    const { call, issued } = mount();

    await call({ theaterId: "theater-a" });

    expect(issued[0]!.sessionId).toBe(GLOBAL_SHELL_SESSION_ID);
    expect(issued[0]!.operationType).toBe("shell");
  });

  it("refuses the first ticket without a Theater to stand in", async () => {
    const { call, responses, issued } = mount();

    await call({});

    expect(responses.at(-1)).toMatchObject({ status: 400, body: { error: "theater_id_required" } });
    expect(issued).toHaveLength(0);
  });

  it("pins cwd at first launch and keeps it when the active Theater moves", async () => {
    const paths: Record<string, string> = { "theater-a": "/repos/a", "theater-b": "/repos/b" };
    const { call, issued } = mount({ resolveTheaterPath: (id: string) => paths[id] ?? null });

    await call({ theaterId: "theater-a" });
    // 사용자가 다른 Theater로 옮겨 간 뒤 셸을 다시 붙인다.
    await call({ theaterId: "theater-b" });

    expect(issued.map((ticket) => ticket.cwd)).toEqual(["/repos/a", "/repos/a"]);
  });

  it("reports an unknown Theater rather than opening a shell somewhere arbitrary", async () => {
    const { call, responses, issued } = mount({ resolveTheaterPath: () => null });

    await call({ theaterId: "ghost" });

    expect(responses.at(-1)).toMatchObject({ status: 404, body: { error: "theater_not_found" } });
    expect(issued).toHaveLength(0);
  });

  /**
   * `shell/open-at`은 Theater 상대 경로를 받아 셸을 그 자리로 옮긴다. 어휘로 루트 위로 오르는 경로와
   * 어휘로는 안쪽이지만 실제로는 밖을 가리키는 심볼릭 링크는 둘 다 막혀야 하고, 안쪽 파일은 그 부모
   * 디렉터리로 착지해 다음 기동 위치가 된다.
   */
  it("moves the Shell only to real directories inside the Theater", async () => {
    const fixture = makeTheaterFixture();
    try {
      const { openAt, responses, call, issued } = mount({ resolveTheaterPath: (id) => (id === "theater-a" ? fixture.root : null) });

      await openAt({ theaterId: "theater-a", path: "../outside" });
      expect(responses.at(-1)).toMatchObject({ status: 403, body: { error: "outside_theater" } });
      await openAt({ theaterId: "theater-a", path: "escape/secret.txt" });
      expect(responses.at(-1)).toMatchObject({ status: 403, body: { error: "outside_theater" } });

      await openAt({ theaterId: "theater-a", path: "src/app.ts" });
      expect(responses.at(-1)).toMatchObject({ status: 200, body: { ok: true, action: "pinned" } });
      await call({ theaterId: "theater-a" });
      expect(issued.at(-1)!.cwd).toBe(path.join(fixture.root, "src"));
    } finally {
      fixture.dispose();
    }
  });

  it("types cd only at an untouched prompt of the shell itself", async () => {
    const fixture = makeTheaterFixture();
    const previousShell = process.env.SHELL;
    // 프롬프트를 보고하는(cwd 추적) 셸이어야 줄이 비었는지 판정할 수 있다.
    process.env.SHELL = "/bin/zsh";
    try {
      const shell = { live: true, foreground: "vim" as string | null, line: { promptSeen: false, promptOpen: false, inputPending: false } };
      const { openAt, restartAt, call, issued, exit, terminated, responses, writes, launch } = mount({ resolveTheaterPath: () => fixture.root, shell, consoleDataDir: fixture.dataDir });
      const spawned = await launch(fixture.root);

      await openAt({ theaterId: "theater-a", path: "src" });
      expect(responses.at(-1)).toMatchObject({ status: 409, body: { error: "shell_busy" } });
      expect(writes).toHaveLength(0);

      // 셸이 전경이어도 첫 프롬프트 전(rc 실행 중)이면 그 스크립트가 `cd …`를 입력으로 받는다.
      shell.foreground = path.basename(spawned.bin);
      await openAt({ theaterId: "theater-a", path: "src" });
      expect(responses.at(-1)).toMatchObject({ status: 409, body: { error: "shell_busy" } });
      // 프롬프트 뒤에 줄이 실행돼 아직 다음 프롬프트가 없으면(`cd /tmp; read x`의 read) 마찬가지다 —
      // 그 사이의 cwd 보고(chpwd)는 프롬프트를 다시 열지 않는다.
      shell.line = { promptSeen: true, promptOpen: false, inputPending: false };
      await openAt({ theaterId: "theater-a", path: "src" });
      expect(responses.at(-1)).toMatchObject({ status: 409, body: { error: "shell_busy" } });
      expect(writes).toHaveLength(0);

      // 프롬프트에 사용자가 치다 만 글자가 있으면 그 뒤에 `cd …`가 붙어 실행된다.
      shell.line = { promptSeen: true, promptOpen: true, inputPending: true };
      await openAt({ theaterId: "theater-a", path: "src" });
      expect(responses.at(-1)).toMatchObject({ status: 409, body: { error: "shell_input_pending" } });
      expect(writes).toHaveLength(0);

      shell.line = { promptSeen: true, promptOpen: true, inputPending: false };
      await openAt({ theaterId: "theater-a", path: "src" });
      expect(responses.at(-1)).toMatchObject({ status: 200, body: { ok: true, action: "cd" } });
      expect(writes).toEqual([`cd -- '${path.join(fixture.root, "src")}'\r`]);

      // 재시작은 돌고 있는 프로그램째 끝내고 요청 위치를 다음 기동으로 못 박는다. 옛 PTY의 종료 통지가
      // 늦게 한 번 더 와도 그 새 고정을 지우지 못해야 한다.
      shell.foreground = "vim";
      await restartAt({ theaterId: "theater-a", path: "src" });
      expect(responses.at(-1)).toMatchObject({ status: 200, body: { ok: true, action: "pinned" } });
      expect(terminated).toContain(GLOBAL_SHELL_SESSION_ID);
      shell.live = false;
      exit(GLOBAL_SHELL_SESSION_ID);
      await call({ theaterId: "theater-a" });
      expect(issued.at(-1)!.cwd).toBe(path.join(fixture.root, "src"));
    } finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      fixture.dispose();
    }
  });
});

function makeTheaterFixture() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fleet-shell-open-at-")));
  const root = path.join(base, "theater");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "");
  writeFileSync(path.join(outside, "secret.txt"), "");
  symlinkSync(outside, path.join(root, "escape"));
  return { root, dataDir: path.join(base, "console"), dispose: () => rmSync(base, { recursive: true, force: true }) };
}

function mount(options: { resolveTheaterPath?: (id: string) => string | null; shell?: { live: boolean; foreground: string | null; line?: { promptSeen: boolean; promptOpen: boolean; inputPending: boolean } }; consoleDataDir?: string } = {}) {
  const issued: TerminalTicketContext[] = [];
  const responses: Array<{ status: number; body: unknown }> = [];
  const terminated: string[] = [];
  const writes: string[] = [];
  const shell = options.shell ?? { live: false, foreground: null };
  let launchResolver: TerminalLaunchResolver | null = null;
  const exitListeners = new Set<(sessionId: string) => void>();
  const routes = new Map<string, RouteHandler>();
  let requestBody: Record<string, unknown> = {};

  const runtime = {
    issueTicket: (context: TerminalTicketContext) => {
      issued.push(context);
      return { ticket: "ticket", ttlMs: 1_000, role: context.role ?? "control" };
    },
    canAttach: () => true,
    terminate: (sessionId: string) => { terminated.push(sessionId); return true; },
    // 실제 세션 매니저처럼 종료 통지는 호출의 동기 구간에서 나간다.
    terminateAndWait: (sessionId: string) => {
      terminated.push(sessionId);
      for (const listener of exitListeners) listener(sessionId);
      return Promise.resolve(true);
    },
    onExit: (listener: (sessionId: string) => void) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    registerLaunchResolver: (_type: string, resolver: TerminalLaunchResolver) => { launchResolver = resolver; return () => undefined; },
    onCwd: () => () => undefined,
    isLive: () => shell.live,
    getForegroundProcess: () => shell.foreground,
    getShellLineState: () => shell.line ?? null,
    write: (_sessionId: string, data: string) => { writes.push(data); return true; },
  } as unknown as TerminalRuntime;

  const ctx = {
    basePath: "/api/v1",
    registerRouter: (routePath: string, handler: RouteHandler) => { routes.set(routePath, handler); },
    host: {
      paths: { resolveTheaterPath: options.resolveTheaterPath ?? (() => "/repos/a"), consoleDataDir: options.consoleDataDir ?? "" },
      events: { publish: () => undefined, registerSseChannel: () => () => undefined },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { responses.push({ status, body }); },
        readJsonBody: async <T,>() => requestBody as T,
      },
      security: {
        isTerminalAuthorized: () => true,
        resolveTerminalSocketRole: () => "control" as const,
        isWriteAdmitted: () => true,
        expectedOrigin: () => "http://127.0.0.1:1",
      },
      theaterFlags: { register: () => () => undefined },
      lifecycle: { registerCleanup: vi.fn() },
    },
  } as unknown as ConsoleRuntimeContext;

  registerShellRoutes(ctx, runtime);

  const invoke = async (routeKey: string, method: string, body: Record<string, unknown>) => {
    const handler = routes.get(routeKey);
    if (!handler) throw new Error(`${routeKey} was not registered`);
    requestBody = body;
    await handler({
      req: { method, url: `/api/v1/${routeKey}`, headers: {} } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      pathname: `/api/v1/${routeKey}`,
    } as Parameters<RouteHandler>[0]);
  };

  return {
    issued,
    responses,
    terminated,
    writes,
    // 전역 Shell의 PTY가 뜨는 순간 — 등록된 launch를 실제로 지나게 해 셸 이름과 세대를 정하게 한다.
    launch: async (cwd: string) => {
      if (!launchResolver) throw new Error("shell launch resolver was not registered");
      return launchResolver(cwd, { sessionId: GLOBAL_SHELL_SESSION_ID, operationType: "shell" });
    },
    openAt: (body: Record<string, unknown>) => invoke("shell/open-at", "POST", body),
    restartAt: (body: Record<string, unknown>) => invoke("shell/restart-at", "POST", body),
    call: (body: Record<string, unknown>) => invoke("shell/ticket", "POST", body),
    del: () => invoke("shell/session", "DELETE", {}),
    exit: (sessionId: string) => { for (const listener of exitListeners) listener(sessionId); },
  };
}

/**
 * cwd 폴백은 payload에 cwd가 없는 Operation을 Theater 경로로 구제하기 위한 것이다.
 * `readPayloadString`이 없는 키에 빈 문자열을 돌려주므로 `??`로는 절대 넘어가지 않았고,
 * 그래서 cwd가 찍히지 않은 agent Operation은 티켓을 영영 받지 못했다.
 */
