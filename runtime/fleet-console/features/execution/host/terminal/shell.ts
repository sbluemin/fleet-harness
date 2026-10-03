import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { RouteHandler } from "@fleet-console/sdk/routing";

import type { ConsoleRuntimeContext } from "../context.js";
import { registerRouter } from "../context.js";

import { readSocketRole } from "./index.js";
import type { TerminalRuntime } from "./index.js";
import { createShellTerminalLaunchResolver } from "./pty.js";
import { applyShellCwdIntegration } from "./shell-cwd-integration.js";

type TicketBody = {
  readonly theaterId?: unknown;
  readonly colorScheme?: unknown;
  readonly role?: unknown;
};

type OpenAtBody = {
  readonly theaterId?: unknown;
  readonly path?: unknown;
};

/**
 * 브라우저가 받는 Shell 상태. 절대 경로는 싣지 않는다 — cwd는 그것을 품은 등록 Theater(가장 깊은
 * 루트)와 그 안의 상대 경로로만 말한다. 어느 Theater에도 속하지 않으면 둘 다 null이다.
 */
export interface ShellSessionState {
  readonly open: boolean;
  readonly pinnedTheaterId: string | null;
  readonly cwd: { readonly theaterId: string | null; readonly relative: string | null } | null;
  /** cwd가 셸의 보고(OSC 7)를 따르는가. false면 spawn 위치에서 멈춘 값이다. */
  readonly cwdTracked: boolean;
  /** PTY 전경 프로세스가 셸 자신인가. 모르면 false — 모르는 상태에 입력을 쓰지 않는다. */
  readonly atPrompt: boolean;
  /** PTY가 새로 만들어질 때마다 커진다. 기동 시각에서 출발하므로 서버 재시작을 넘어도 겹치지 않는다. */
  readonly generation: number;
}

/** Shell 상태가 바뀔 때 같은 모양을 내보내는 SSE 채널. */
export const SHELL_SESSION_EVENT_CHANNEL = "terminal:shell-session";

/**
 * Shell은 Operation이 아니다 — 콘솔 하나에 하나뿐인 전역 표면이다.
 *
 * 그래서 세션 키는 Operation id가 아니라 이 상수다. 티켓·소켓·write·terminate가
 * 전부 이 하나를 쓴다. durable state에 들어가지 않으므로 콘솔이 죽으면 셸도 죽고,
 * 복원할 휴면 상태라는 것 자체가 없다.
 */
/**
 * `shell:` 접두를 쓰지 않는다. 세션 매니저는 그 접두를 "상태 미유지 theater-shell"의 표식으로
 * 읽어, 마지막 소켓이 떨어지고 4초 뒤 PTY를 정리한다. 전역 셸은 정반대 약속을 지고 있다 —
 * 레일에서 잠깐 치워 둔 셸은 돌아왔을 때 그 자리에 있어야 하고, cwd 고정도 함께 살아 있어야
 * 한다. 접두 하나가 그 약속을 4초짜리로 만든다.
 */
const GLOBAL_SHELL_SESSION_ID = "console-shell";
const GLOBAL_SHELL_OPERATION_TYPE = "shell";
const SHELL_INTEGRATION_DIR = "shell-integration";
/** 재시작이 옛 PTY 자식의 실제 종료를 기다리는 상한. 넘겨도 새 PTY는 세션 매니저의 옛-필자 관문이 막는다. */
const SHELL_RESTART_EXIT_WAIT_MS = 5_000;

export function registerShellRoutes(ctx: ConsoleRuntimeContext, runtime: TerminalRuntime): void {
  /**
   * cwd는 첫 기동 때 활성 Theater 경로로 한 번 못 박고, 사용자가 셸을 명시적으로
   * 끝낼 때까지 유지한다. Theater를 옮겨 다닌다고 발밑이 바뀌면 반쯤 친 명령이
   * 다른 저장소에서 실행된다 — 셸의 현재 위치는 사용자만 바꿀 수 있어야 한다.
   * (`shell/open-at`은 사용자가 명시적으로 고른 이동이라 이 고정을 함께 옮긴다.)
   */
  let pinnedCwd: string | null = null;
  let pinnedTheaterId: string | null = null;
  let generation = Date.now();
  /** 셸이 마지막으로 보고한(또는 spawn한) 절대 cwd. 서버 밖으로 나가지 않는다. */
  let currentCwd: string | null = null;
  let cwdTracked = false;
  let shellName: string | null = null;
  /**
   * 지금 살아 있는 PTY의 세대. 종료 통지가 이 값을 가진 PTY의 것일 때만 고정을 푼다 — 재시작이 이미
   * 정리한 옛 PTY의 통지가 늦게 와도 새 고정을 지우지 못한다.
   */
  let liveGeneration: number | null = null;
  /** 재시작이 옛 PTY를 끝내는 동안 참. 그 종료는 사용자의 `exit`가 아니므로 고정을 풀지 않는다. */
  let restarting = false;
  let lastPublished = "";

  const release = () => {
    pinnedCwd = null;
    pinnedTheaterId = null;
    currentCwd = null;
    cwdTracked = false;
    shellName = null;
  };

  const integrationDir = readIntegrationDir(ctx);
  const baseLaunch = createShellTerminalLaunchResolver();
  // 전역 Shell의 PTY만 cwd 보고를 주입받는다. 같은 operationType을 쓰는 다른 셸은 기본 launch 그대로다.
  ctx.host.lifecycle.registerCleanup(runtime.registerLaunchResolver(GLOBAL_SHELL_OPERATION_TYPE, async (cwd, context) => {
    const launch = await baseLaunch(cwd, { ...context, kind: "shell" });
    if (context?.sessionId !== GLOBAL_SHELL_SESSION_ID) return launch;
    const integrated = applyShellCwdIntegration(launch, integrationDir);
    generation += 1;
    liveGeneration = generation;
    currentCwd = integrated.launch.cwd;
    cwdTracked = integrated.tracked;
    shellName = integrated.shellName;
    // 세션은 이 launch를 받은 뒤 같은 흐름에서 등록된다. 등록된 다음 상태(open)를 내보낸다 —
    // cwd를 보고하지 않는 셸은 이것이 유일한 알림이다.
    setTimeout(publish, 0).unref?.();
    return integrated.launch;
  }));

  ctx.host.lifecycle.registerCleanup(runtime.onCwd(GLOBAL_SHELL_SESSION_ID, (_sessionId, cwd) => {
    currentCwd = cwd;
    // 셸은 프롬프트를 그리기 직전마다 보고하므로, 이 순간의 atPrompt도 함께 새로 나간다.
    publish();
  }));

  // PTY가 스스로 끝나면(exit, 사용자가 `exit` 입력) 고정도 함께 풀린다 —
  // 다음 기동은 그때의 활성 Theater에서 새로 시작한다.
  const unsubscribeExit = runtime.onExit((sessionId) => {
    if (sessionId !== GLOBAL_SHELL_SESSION_ID) return;
    if (restarting || liveGeneration === null) {
      // 재시작이 끝낸 PTY거나 이미 정리한 PTY의 늦은 통지다. 새 고정은 그대로 둔다.
      liveGeneration = null;
      publish();
      return;
    }
    liveGeneration = null;
    release();
    publish();
  });
  ctx.host.lifecycle.registerCleanup(unsubscribeExit);
  ctx.host.lifecycle.registerCleanup(ctx.host.events.registerSseChannel(SHELL_SESSION_EVENT_CHANNEL));

  function readState(): ShellSessionState {
    const open = runtime.isLive(GLOBAL_SHELL_SESSION_ID);
    const foreground = open ? runtime.getForegroundProcess(GLOBAL_SHELL_SESSION_ID) : null;
    return {
      open,
      pinnedTheaterId,
      cwd: open && currentCwd ? locateInTheaters(ctx, currentCwd) : null,
      cwdTracked: open && cwdTracked,
      atPrompt: open && shellName !== null && foreground !== null && isShellProcess(foreground, shellName),
      generation,
    };
  }

  function publish(): void {
    const state = readState();
    const serialized = JSON.stringify(state);
    if (serialized === lastPublished) return;
    lastPublished = serialized;
    ctx.host.events.publish(SHELL_SESSION_EVENT_CHANNEL, state);
  }

  registerRouter(ctx, "shell/ticket", async ({ req, res }) => {
    if (req.method !== "POST") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<TicketBody>(req);

    if (pinnedCwd === null) {
      const theaterId = typeof body?.theaterId === "string" ? body.theaterId : null;
      if (!theaterId) {
        ctx.host.http.writeJson(res, 400, { error: "theater_id_required" });
        return true;
      }
      const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
      if (!theaterPath) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      pinnedCwd = theaterPath;
      pinnedTheaterId = theaterId;
    }

    if (!runtime.canAttach(GLOBAL_SHELL_SESSION_ID)) {
      ctx.host.http.writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return true;
    }

    const colorScheme =
      body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
    // 등급은 Console이 정한다. 요청이 control을 원해도 제어를 쥔 원격이 있으면 관전으로 내려간다.
    const role =
      ctx.host.security.resolveTerminalSocketRole(req) === "viewer" ? "viewer" : readSocketRole(body?.role);

    const ticket = runtime.issueTicket({
      cwd: pinnedCwd,
      sessionId: GLOBAL_SHELL_SESSION_ID,
      operationId: GLOBAL_SHELL_SESSION_ID,
      operationType: GLOBAL_SHELL_OPERATION_TYPE,
      pluginId: null,
      ...(pinnedTheaterId ? { theaterId: pinnedTheaterId } : {}),
      kind: "shell",
      ...(colorScheme ? { colorScheme } : {}),
      ...(role ? { role } : {}),
    });
    // 이 티켓이 붙을 PTY의 세대 — 살아 있으면 그것, 없으면 이 티켓의 부착이 만들 다음 것.
    const ticketGeneration = runtime.isLive(GLOBAL_SHELL_SESSION_ID) ? generation : generation + 1;
    ctx.host.http.writeJson(res, 200, { ...ticket, pinnedTheaterId, generation: ticketGeneration });
    return true;
  }, {
    method: "POST",
    path: "",
    summary: "Issue a ticket for the console-global Shell.",
    category: "Console Execution",
    gate: "origin-write",
    transport: "http",
  });

  registerRouter(ctx, "shell/session", ({ req, res }) => {
    if (req.method !== "DELETE" && req.method !== "GET") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method === "GET") {
      ctx.host.http.writeJson(res, 200, readState());
      return true;
    }
    runtime.terminate(GLOBAL_SHELL_SESSION_ID);
    release();
    publish();
    ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
  }, [{
    method: "GET",
    path: "",
    summary: "Read the console-global Shell state (Theater-relative cwd, prompt state, generation).",
    category: "Console Execution",
    gate: "loopback",
    transport: "http",
  }, {
    method: "DELETE",
    path: "",
    summary: "Terminate the console-global Shell session.",
    category: "Console Execution",
    gate: "origin-write",
    transport: "http",
  }]);

  /**
   * Shell을 Theater 안의 한 디렉터리로 옮긴다. 셸이 없으면 그 자리를 다음 기동 위치로 못 박고,
   * 프롬프트에 있으면 `cd`를 입력한다. 그 밖에는 아무것도 쓰지 않고 409로 답한다.
   * - `shell_busy`: 프로그램이 돌고 있거나(그 프로그램이 `cd …`를 입력으로 받는다), 셸이 프롬프트를
   *   보고하지 않아 줄이 비었는지 알 수 없다.
   * - `shell_input_pending`: 마지막 프롬프트 뒤로 사용자가 무언가 쳤다. 치다 만 `rm -rf ` 뒤에 `cd …`가
   *   붙어 실행될 수 있고, 그 줄을 말없이 지우는 것도 사용자의 입력을 버리는 일이다.
   */
  registerRouter(ctx, "shell/open-at", async ({ req, res }) => {
    if (req.method !== "POST") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const target = await readMoveTarget(req, res);
    if (!target) return true;
    const { theaterId } = target;

    if (!runtime.isLive(GLOBAL_SHELL_SESSION_ID)) {
      pinnedCwd = target.directory;
      pinnedTheaterId = theaterId;
      publish();
      ctx.host.http.writeJson(res, 200, { ok: true, action: "pinned", state: readState() });
      return true;
    }
    const state = readState();
    if (!state.atPrompt || !state.cwdTracked) {
      ctx.host.http.writeJson(res, 409, { error: "shell_busy" });
      return true;
    }
    if (runtime.hasInputSincePrompt(GLOBAL_SHELL_SESSION_ID)) {
      ctx.host.http.writeJson(res, 409, { error: "shell_input_pending" });
      return true;
    }
    if (!runtime.write(GLOBAL_SHELL_SESSION_ID, `cd -- ${quotePosixArgument(target.directory)}\r`)) {
      ctx.host.http.writeJson(res, 409, { error: "shell_busy" });
      return true;
    }
    pinnedCwd = target.directory;
    pinnedTheaterId = theaterId;
    publish();
    ctx.host.http.writeJson(res, 200, { ok: true, action: "cd", state: readState() });
    return true;
  }, {
    method: "POST",
    path: "",
    summary: "Move the console-global Shell to a directory inside a Theater (cd at the prompt, or pin the next launch).",
    category: "Console Execution",
    gate: "origin-write",
    transport: "http",
  });

  /**
   * 지금 Shell을 끝내고(돌고 있는 프로그램째) 요청 위치를 다음 기동 위치로 못 박는다. 파괴적이므로
   * 호출 쪽이 사용자의 확인을 받은 뒤에만 부른다.
   *
   * 옛 PTY의 종료와 새 고정 사이에 틈이 없어야 한다. 종료 통지는 `terminateAndWait`의 동기 구간에서
   * 나가므로 그동안만 `restarting`을 세워 그 통지가 고정을 풀지 않게 하고, 같은 동기 흐름에서 새
   * 고정을 쓴다 — 그 뒤에 들어오는 티켓은 처음부터 새 위치를 받는다. 새 PTY의 실제 기동은 세션
   * 매니저가 옛 자식이 사라질 때까지 붙잡는다.
   */
  registerRouter(ctx, "shell/restart-at", async ({ req, res }) => {
    if (req.method !== "POST") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const target = await readMoveTarget(req, res);
    if (!target) return true;

    let exited: Promise<boolean>;
    restarting = true;
    try {
      exited = runtime.terminateAndWait(GLOBAL_SHELL_SESSION_ID, SHELL_RESTART_EXIT_WAIT_MS);
    } finally {
      restarting = false;
    }
    liveGeneration = null;
    release();
    pinnedCwd = target.directory;
    pinnedTheaterId = target.theaterId;
    publish();
    await exited.catch(() => false);
    ctx.host.http.writeJson(res, 200, { ok: true, action: "pinned", state: readState() });
    return true;
  }, {
    method: "POST",
    path: "",
    summary: "End the console-global Shell (including a running program) and pin its next launch inside a Theater.",
    category: "Console Execution",
    gate: "origin-write",
    transport: "http",
  });

  /** 이동 요청의 공통 검사 — 등급·Theater·경로. 실패면 응답을 쓰고 null. */
  async function readMoveTarget(req: Parameters<RouteHandler>[0]["req"], res: Parameters<RouteHandler>[0]["res"]): Promise<{ theaterId: string; directory: string } | null> {
    // 관전 등급은 PTY에 입력을 쓸 수 없다 — 티켓이 관전으로 내려가는 것과 같은 판정이다.
    if (ctx.host.security.resolveTerminalSocketRole(req) === "viewer") {
      ctx.host.http.writeJson(res, 403, { error: "shell_read_only" });
      return null;
    }
    const body = await ctx.host.http.readJsonBody<OpenAtBody>(req);
    const theaterId = typeof body?.theaterId === "string" ? body.theaterId : null;
    if (!theaterId) {
      ctx.host.http.writeJson(res, 400, { error: "theater_id_required" });
      return null;
    }
    const theaterRoot = ctx.host.paths.resolveTheaterPath(theaterId);
    if (!theaterRoot) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return null;
    }
    const requested = body?.path === undefined || body.path === null ? "" : body.path;
    if (typeof requested !== "string") {
      ctx.host.http.writeJson(res, 400, { error: "invalid_path" });
      return null;
    }
    const target = resolveTheaterDirectory(theaterRoot, requested);
    if (!target.ok) {
      ctx.host.http.writeJson(res, target.status, { error: target.error });
      return null;
    }
    return { theaterId, directory: target.directory };
  }
}

type DirectoryResolution =
  | { readonly ok: true; readonly directory: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404; readonly error: "invalid_path" | "outside_theater" | "not_found" };

/**
 * Theater 상대 경로를 그 Theater 안의 실제 디렉터리로 바꾼다. 어휘 검사(절대 경로·NUL·루트 위로
 * 오르는 `..`) 뒤에 realpath 포함 검사를 한 번 더 한다 — 어휘로는 안쪽인 심볼릭 링크가 밖을 가리킬
 * 수 있다. 파일이면 그 부모 디렉터리다.
 */
export function resolveTheaterDirectory(theaterRoot: string, relative: string): DirectoryResolution {
  if (relative.includes("\0")) return { ok: false, status: 400, error: "invalid_path" };
  const posix = relative.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return { ok: false, status: 400, error: "invalid_path" };
  const normalized = path.posix.normalize(posix === "" ? "." : posix);
  if (normalized === ".." || normalized.startsWith("../")) return { ok: false, status: 403, error: "outside_theater" };

  let root: string;
  let resolved: string;
  try {
    root = realpathSync.native(theaterRoot);
    resolved = realpathSync.native(path.join(root, ...normalized.split("/")));
  } catch {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (!isInside(root, resolved)) return { ok: false, status: 403, error: "outside_theater" };
  try {
    return { ok: true, directory: statSync(resolved).isDirectory() ? resolved : path.dirname(resolved) };
  } catch {
    return { ok: false, status: 404, error: "not_found" };
  }
}

/** 절대 cwd를 품은 가장 깊은 등록 Theater와 그 안의 상대 경로(POSIX). 어디에도 없으면 둘 다 null. */
function locateInTheaters(ctx: ConsoleRuntimeContext, cwd: string): { theaterId: string | null; relative: string | null } {
  let real: string;
  try {
    real = realpathSync.native(cwd);
  } catch {
    real = path.resolve(cwd);
  }
  let best: { theaterId: string; root: string } | null = null;
  for (const theaterId of ctx.host.paths.listTheaterIds?.() ?? []) {
    const root = ctx.host.paths.resolveTheaterPath(theaterId);
    if (!root || !isInside(root, real)) continue;
    if (!best || root.length > best.root.length) best = { theaterId, root };
  }
  if (!best) return { theaterId: null, relative: null };
  return { theaterId: best.theaterId, relative: path.relative(best.root, real).split(path.sep).join("/") };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isShellProcess(foreground: string, shellName: string): boolean {
  // 로그인 셸은 `-zsh`처럼 앞에 `-`가 붙어 보인다.
  const name = path.basename(foreground).replace(/^-/, "").replace(/\.exe$/i, "");
  return name === shellName;
}

function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readIntegrationDir(ctx: ConsoleRuntimeContext): string | null {
  const consoleDataDir = ctx.host.paths.consoleDataDir;
  return typeof consoleDataDir === "string" && consoleDataDir.length > 0 ? path.join(consoleDataDir, SHELL_INTEGRATION_DIR) : null;
}

export { GLOBAL_SHELL_SESSION_ID };
