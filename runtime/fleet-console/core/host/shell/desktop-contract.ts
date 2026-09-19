import type http from "node:http";

import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import type { ConsoleThemeId } from "../../../features/settings/host/settings-domain.js";

export const DESKTOP_FULLSCREEN_PATH = "/api/v1/desktop/fullscreen";
export const DESKTOP_FULLSCREEN_EVENT = "desktop:fullscreen";

export interface DesktopFullscreenSnapshot {
  readonly fullscreen: boolean;
}

export const desktopFullscreenSnapshot = (fullscreen: boolean): DesktopFullscreenSnapshot => ({ fullscreen });

export function isDesktopFullscreenSnapshot(value: unknown): value is DesktopFullscreenSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 1 && typeof entry.fullscreen === "boolean";
}

interface DesktopFullscreenRouteDeps {
  readonly getFullscreen: () => boolean;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly setFullscreen: (fullscreen: boolean) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
}

interface DesktopFullscreenRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export const DESKTOP_FULLSCREEN_API_CATALOG: readonly ApiCatalogEntry[] = [{
  method: "PUT",
  path: DESKTOP_FULLSCREEN_PATH,
  summary: "Update the ephemeral Desktop native fullscreen snapshot.",
  category: "Desktop",
  gate: "origin-strict",
  transport: "http",
}];

export function createDesktopFullscreenRouter(deps: DesktopFullscreenRouteDeps): (context: DesktopFullscreenRouteContext) => Promise<boolean> {
  return async ({ req, res, pathname }) => {
    if (pathname !== DESKTOP_FULLSCREEN_PATH) return false;
    if (req.method !== "PUT") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await deps.readJsonBody<unknown>(req);
    if (!isDesktopFullscreenSnapshot(body)) {
      deps.writeJson(res, 400, { error: "invalid_desktop_fullscreen" });
      return true;
    }
    if (deps.getFullscreen() !== body.fullscreen) deps.setFullscreen(body.fullscreen);
    deps.writeNoContent(res);
    return true;
  };
}

export const DESKTOP_SHELL_PATH = "/api/v1/desktop/shell";
/**
 * 게시가 도착할 때마다 그 창의 Operation 스트림에 실리는 이벤트. 화면은 뜨자마자 한 번 묻지만,
 * 콘솔이 재기동한 뒤 셸이 다시 게시하는 순간은 그 물음보다 늦을 수 있다 — 그 뒤늦은 답을
 * 화면까지 나르는 길이 이것이다.
 */
export const DESKTOP_SHELL_EVENT = "desktop:shell";

/**
 * 창을 들고 있는 셸이 자기에 대해 알려 주는 한 가지 사실: 이 앱이 처음 띄운 콘솔이 어디인가.
 *
 * 콘솔은 이것을 스스로 알 수 없다. 원격 콘솔이 서빙한 화면에서 "이 컴퓨터"로 돌아가려면
 * 그 화면은 자기가 아닌 다른 origin을 가리켜야 하는데, 그 주소를 아는 것은 셸뿐이다.
 * 브라우저 단독으로 열었을 때는 비어 있고, 그때는 돌아갈 곳도 없다.
 */
export interface DesktopShellSnapshot {
  readonly homeOrigin: string | null;
  /** 창을 든 Desktop 앱의 버전. 도움말 메뉴가 "어느 Desktop이 이 창을 들고 있는가"를 적는 데 쓴다. 옛 Desktop은 보내지 않는다. */
  readonly version?: string;
}

export const emptyDesktopShell = (): DesktopShellSnapshot => ({ homeOrigin: null });

const DESKTOP_VERSION_SHAPE = /^[0-9A-Za-z.+-]{1,64}$/u;

function isDesktopShellSnapshot(value: unknown): value is DesktopShellSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (!keys.includes("homeOrigin") || keys.some((key) => key !== "homeOrigin" && key !== "version")) return false;
  if ("version" in entry && (typeof entry.version !== "string" || !DESKTOP_VERSION_SHAPE.test(entry.version))) return false;
  return entry.homeOrigin === null || (typeof entry.homeOrigin === "string" && isConsoleOriginShape(entry.homeOrigin));
}

/** 돌아갈 곳도 origin이어야 한다 — 경로가 섞이면 셸이 아무 데나 항해한다. */
function isConsoleOriginShape(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

interface DesktopShellRouteDeps {
  /** 요청자에 따라 답이 달라진다 — 이 값을 되돌려 받을 자격은 게시한 창에만 있다. */
  readonly getShell: (req: http.IncomingMessage) => DesktopShellSnapshot;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly setShell: (req: http.IncomingMessage, snapshot: DesktopShellSnapshot) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
}

export const DESKTOP_SHELL_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: DESKTOP_SHELL_PATH,
    summary: "Read where the Desktop that published it can send this window home; every other viewer reads nothing.",
    category: "Desktop",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "PUT",
    path: DESKTOP_SHELL_PATH,
    summary: "Publish the console the attached Desktop launched, so this window can go back to it.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "http",
  },
];

export function createDesktopShellRouter(deps: DesktopShellRouteDeps): (context: DesktopFullscreenRouteContext) => Promise<boolean> {
  return async ({ req, res, pathname }) => {
    if (pathname !== DESKTOP_SHELL_PATH) return false;
    if (req.method === "GET") {
      deps.writeJson(res, 200, deps.getShell(req));
      return true;
    }
    if (req.method !== "PUT") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await deps.readJsonBody<unknown>(req);
    if (!isDesktopShellSnapshot(body)) {
      deps.writeJson(res, 400, { error: "invalid_desktop_shell" });
      return true;
    }
    deps.setShell(req, body);
    deps.writeNoContent(res);
    return true;
  };
}

export interface DesktopTitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export interface DesktopThemeSnapshot {
  readonly theme: ConsoleThemeId;
  readonly titleBarOverlay: DesktopTitleBarOverlay;
}

export const DESKTOP_THEME_PATH = "/api/v1/desktop/theme";
export const DESKTOP_THEME_EVENTS_PATH = "/api/v1/desktop/theme/events";
export const DESKTOP_THEME_EVENT = "desktop:theme";

const DESKTOP_TITLE_BAR_OVERLAYS: Readonly<Record<ConsoleThemeId, DesktopThemeSnapshot["titleBarOverlay"]>> = {
  instrument: { color: "#03080e", symbolColor: "#989fa6", height: 35 },
  maritime: { color: "#041729", symbolColor: "#c8c4b7", height: 35 },
  carbon: { color: "#101215", symbolColor: "#bfc1c3", height: 35 },
  whites: { color: "#f1f0ec", symbolColor: "#424038", height: 35 },
};

export function desktopThemeSnapshot(theme: ConsoleThemeId): DesktopThemeSnapshot {
  return { theme, titleBarOverlay: { ...DESKTOP_TITLE_BAR_OVERLAYS[theme] } };
}

interface DesktopThemeRouteDeps {
  readonly getTheme: () => ConsoleThemeId;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly subscribe: (res: http.ServerResponse, snapshot: DesktopThemeSnapshot) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface DesktopThemeRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export const DESKTOP_THEME_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: DESKTOP_THEME_PATH,
    summary: "Get the Console-owned Desktop title bar theme.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "http",
  },
  {
    method: "GET",
    path: DESKTOP_THEME_EVENTS_PATH,
    summary: "Stream server-confirmed Desktop title bar theme changes.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "sse",
  },
];

export function createDesktopThemeRouter(deps: DesktopThemeRouteDeps): (context: DesktopThemeRouteContext) => boolean {
  return ({ req, res, pathname }) => {
    if (pathname !== DESKTOP_THEME_PATH && pathname !== DESKTOP_THEME_EVENTS_PATH) return false;
    if (req.method !== "GET") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const snapshot = desktopThemeSnapshot(deps.getTheme());
    if (pathname === DESKTOP_THEME_PATH) {
      deps.writeJson(res, 200, snapshot);
      return true;
    }
    deps.subscribe(res, snapshot);
    return true;
  };
}

/**
 * 이 콘솔이 스스로 갈아 끼울 수 없는 설치 레이아웃일 때, 업데이트를 실제로 수행하는 것은
 * 창을 들고 있는 셸이다. 페이지는 셸에게 말을 걸 수 없고 걸어서도 안 되므로(렌더러는
 * 샌드박스이고 preload도 IPC도 없다), 방향은 반대로 흐른다 — 셸이 이 라우트의 구독자다.
 * 테마 동기화가 이미 쓰는 길과 같은 모양이며, 새 통로를 뚫지 않는다.
 *
 * 여기 실리는 것은 "요청됐다"는 사실 하나뿐이다. 무엇을 어떻게 설치할지는 셸의 강화된
 * 진입-흐름 트랜잭션이 정하며, 콘솔은 그 결정에 관여하지 않는다.
 */
export const DESKTOP_UPDATE_PATH = "/api/v1/desktop/update";
export const DESKTOP_UPDATE_EVENTS_PATH = "/api/v1/desktop/update/events";
export const DESKTOP_UPDATE_EVENT = "desktop:update";

export interface DesktopUpdateRequestSnapshot {
  /** 요청된 목표 버전. 대기 중인 요청이 없으면 null. */
  readonly requestedVersion: string | null;
  /** 이 요청의 표. 셸이 같은 요청을 두 번 수행하지 않기 위한 값이다. */
  readonly requestId: string | null;
}

export const emptyDesktopUpdateRequest = (): DesktopUpdateRequestSnapshot => ({ requestedVersion: null, requestId: null });

interface DesktopUpdateRouteDeps {
  readonly getUpdateRequest: () => DesktopUpdateRequestSnapshot;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly subscribe: (res: http.ServerResponse, snapshot: DesktopUpdateRequestSnapshot) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export const DESKTOP_UPDATE_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: DESKTOP_UPDATE_PATH,
    summary: "Read whether an update was requested for the shell that owns this window to perform.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "http",
  },
  {
    method: "GET",
    path: DESKTOP_UPDATE_EVENTS_PATH,
    summary: "Stream update requests the owning shell must perform.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "sse",
  },
];

export function createDesktopUpdateRouter(deps: DesktopUpdateRouteDeps): (context: DesktopFullscreenRouteContext) => boolean {
  return ({ req, res, pathname }) => {
    if (pathname !== DESKTOP_UPDATE_PATH && pathname !== DESKTOP_UPDATE_EVENTS_PATH) return false;
    if (req.method !== "GET") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const snapshot = deps.getUpdateRequest();
    if (pathname === DESKTOP_UPDATE_PATH) {
      deps.writeJson(res, 200, snapshot);
      return true;
    }
    deps.subscribe(res, snapshot);
    return true;
  };
}

/**
 * 셸이 자기 자신을 갱신하는 일의 상태와 명령.
 *
 * 방향이 둘이라 길도 둘이다. 상태는 수행자인 셸만 알므로 셸이 게시하고 창이 읽는다(`shell-update`) —
 * 변화는 화면이 이미 열어 둔 Operation 스트림에 `desktop:shell-update`로 실린다(집 주소와 같은 문법).
 * 명령은 창에서만 나오므로 창이 보내고 셸이 구독한다(`shell-update/command`) — 렌더러는 샌드박스이고
 * preload도 IPC도 없으니, 셸에게 말을 거는 길은 이 콘솔을 거치는 것뿐이다.
 *
 * Console 갱신 요청(`desktop/update`)과 섞지 않는다. 그쪽은 "관리형 Console을 갈아 끼워 달라"는
 * 한 가지 요청만 나르며, 옛 셸이 그 신호를 받으면 즉시 재시작한다 — 내려받기 명령이 그 길로 흘러가면
 * 사용자가 누른 적 없는 재시작이 일어난다.
 */
export const DESKTOP_SHELL_UPDATE_PATH = "/api/v1/desktop/shell-update";
export const DESKTOP_SHELL_UPDATE_COMMAND_PATH = "/api/v1/desktop/shell-update/command";
export const DESKTOP_SHELL_UPDATE_COMMAND_EVENTS_PATH = "/api/v1/desktop/shell-update/command/events";
export const DESKTOP_SHELL_UPDATE_EVENT = "desktop:shell-update";
export const DESKTOP_SHELL_UPDATE_COMMAND_EVENT = "desktop:shell-update-command";

/**
 * `available`과 `ready` 사이에 `downloading`이 있는 것이 이 설계의 핵심이다 — 설치본은 미리 받아 두지
 * 않으므로, 사용자가 누른 뒤에야 받기 시작하고 그 기다림이 화면에 보여야 한다.
 */
export type DesktopShellUpdateStage = "idle" | "available" | "downloading" | "ready" | "error";

export interface DesktopShellUpdateSnapshot {
  readonly stage: DesktopShellUpdateStage;
  /** 갱신 후보 버전. idle이면 null. */
  readonly version: string | null;
  /** downloading일 때 0–100의 정수, 그 밖에는 null. */
  readonly percent: number | null;
  /** 실패를 짧게 설명하는 코드. error가 아니면 null. */
  readonly failure: string | null;
}

export const emptyDesktopShellUpdate = (): DesktopShellUpdateSnapshot => ({ stage: "idle", version: null, percent: null, failure: null });

const SHELL_UPDATE_STAGES: readonly DesktopShellUpdateStage[] = ["idle", "available", "downloading", "ready", "error"];
const SHELL_UPDATE_VERSION_SHAPE = /^[0-9A-Za-z.+-]{1,64}$/u;
const SHELL_UPDATE_FAILURE_SHAPE = /^[A-Za-z0-9_]{1,64}$/u;

export function isDesktopShellUpdateSnapshot(value: unknown): value is DesktopShellUpdateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (keys.length !== 4 || keys.join(",") !== "failure,percent,stage,version") return false;
  if (typeof entry.stage !== "string" || !SHELL_UPDATE_STAGES.includes(entry.stage as DesktopShellUpdateStage)) return false;
  if (entry.version !== null && (typeof entry.version !== "string" || !SHELL_UPDATE_VERSION_SHAPE.test(entry.version))) return false;
  if (entry.percent !== null && (typeof entry.percent !== "number" || !Number.isInteger(entry.percent) || entry.percent < 0 || entry.percent > 100)) return false;
  if (entry.failure !== null && (typeof entry.failure !== "string" || !SHELL_UPDATE_FAILURE_SHAPE.test(entry.failure))) return false;
  // 단계가 말하는 것과 값이 어긋나면 화면이 앞뒤 없는 문장을 쓴다 — 여기서 막는다.
  if (entry.stage === "downloading" && entry.percent === null) return false;
  if ((entry.stage === "available" || entry.stage === "downloading" || entry.stage === "ready") && entry.version === null) return false;
  if (entry.stage === "error" && entry.failure === null) return false;
  return true;
}

/** 창이 셸에게 시킬 수 있는 일. 확인과 내려받기와 재시작, 그 셋뿐이다. */
export type DesktopShellUpdateCommandKind = "check" | "download" | "restart";

export interface DesktopShellUpdateCommandSnapshot {
  readonly command: DesktopShellUpdateCommandKind | null;
  /** 이 명령의 표. 셸이 같은 명령을 두 번 수행하지 않기 위한 값이다. */
  readonly commandId: string | null;
}

export const emptyDesktopShellUpdateCommand = (): DesktopShellUpdateCommandSnapshot => ({ command: null, commandId: null });

const SHELL_UPDATE_COMMANDS: readonly DesktopShellUpdateCommandKind[] = ["check", "download", "restart"];
const SHELL_UPDATE_COMMAND_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/u;

export function isDesktopShellUpdateCommandSnapshot(value: unknown): value is DesktopShellUpdateCommandSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (keys.length !== 2 || keys.join(",") !== "command,commandId") return false;
  if (entry.command === null && entry.commandId === null) return true;
  if (typeof entry.command !== "string" || !SHELL_UPDATE_COMMANDS.includes(entry.command as DesktopShellUpdateCommandKind)) return false;
  return typeof entry.commandId === "string" && SHELL_UPDATE_COMMAND_ID_SHAPE.test(entry.commandId);
}

/** 창이 보내는 명령 요청. 표는 서버가 붙인다 — 창이 고른 표를 믿으면 한 창이 다른 창의 명령을 덮어쓸 수 있다. */
export function isDesktopShellUpdateCommandRequest(value: unknown): value is { readonly command: DesktopShellUpdateCommandKind } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 1) return false;
  return typeof entry.command === "string" && SHELL_UPDATE_COMMANDS.includes(entry.command as DesktopShellUpdateCommandKind);
}

export const DESKTOP_SHELL_UPDATE_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: DESKTOP_SHELL_UPDATE_PATH,
    summary: "Read what the shell that owns this window knows about its own update.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "http",
  },
  {
    method: "PUT",
    path: DESKTOP_SHELL_UPDATE_PATH,
    summary: "Publish the owning shell's own update state.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "http",
  },
  {
    method: "POST",
    path: DESKTOP_SHELL_UPDATE_COMMAND_PATH,
    summary: "Ask the owning shell to check, download, or install its own update.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "http",
  },
  {
    method: "GET",
    path: DESKTOP_SHELL_UPDATE_COMMAND_PATH,
    summary: "Read the pending shell update command.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "http",
  },
  {
    method: "GET",
    path: DESKTOP_SHELL_UPDATE_COMMAND_EVENTS_PATH,
    summary: "Stream shell update commands the owning shell must perform.",
    category: "Desktop",
    gate: "origin-strict",
    transport: "sse",
  },
];

interface DesktopShellUpdateRouteDeps {
  readonly getUpdate: (req: http.IncomingMessage) => DesktopShellUpdateSnapshot;
  readonly setUpdate: (req: http.IncomingMessage, snapshot: DesktopShellUpdateSnapshot) => void;
  readonly getCommand: (req: http.IncomingMessage) => DesktopShellUpdateCommandSnapshot;
  readonly requestCommand: (req: http.IncomingMessage, command: DesktopShellUpdateCommandKind) => void;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly subscribeCommand: (req: http.IncomingMessage, res: http.ServerResponse, snapshot: DesktopShellUpdateCommandSnapshot) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
}

export function createDesktopShellUpdateRouter(deps: DesktopShellUpdateRouteDeps): (context: DesktopFullscreenRouteContext) => Promise<boolean> {
  const paths = new Set<string>([DESKTOP_SHELL_UPDATE_PATH, DESKTOP_SHELL_UPDATE_COMMAND_PATH, DESKTOP_SHELL_UPDATE_COMMAND_EVENTS_PATH]);
  return async ({ req, res, pathname }) => {
    if (!paths.has(pathname)) return false;
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (pathname === DESKTOP_SHELL_UPDATE_PATH) {
      if (req.method === "GET") {
        deps.writeJson(res, 200, deps.getUpdate(req));
        return true;
      }
      if (req.method !== "PUT") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      const body = await deps.readJsonBody<unknown>(req);
      if (!isDesktopShellUpdateSnapshot(body)) {
        deps.writeJson(res, 400, { error: "invalid_desktop_shell_update" });
        return true;
      }
      deps.setUpdate(req, body);
      deps.writeNoContent(res);
      return true;
    }
    if (pathname === DESKTOP_SHELL_UPDATE_COMMAND_PATH) {
      if (req.method === "GET") {
        deps.writeJson(res, 200, deps.getCommand(req));
        return true;
      }
      if (req.method !== "POST") {
        deps.writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      const body = await deps.readJsonBody<unknown>(req);
      if (!isDesktopShellUpdateCommandRequest(body)) {
        deps.writeJson(res, 400, { error: "invalid_desktop_shell_update_command" });
        return true;
      }
      deps.requestCommand(req, body.command);
      deps.writeNoContent(res);
      return true;
    }
    if (req.method !== "GET") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    deps.subscribeCommand(req, res, deps.getCommand(req));
    return true;
  };
}
