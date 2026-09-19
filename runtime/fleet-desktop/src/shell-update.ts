import type { AppUpdater } from "electron-updater";

import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream, parseDesktopSseFrame, type DesktopEventStream } from "./desktop-event-stream.js";

/**
 * 셸이 자기 자신을 갈아 끼우는 일.
 *
 * 설치본은 미리 받아 두지 않는다. 확인만 주기적으로 하고, 내려받기는 사용자가 창에서 누른 뒤에
 * 시작한다 — 쓰지도 않을 설치본으로 남의 회선과 디스크를 먼저 쓰지 않기 위한 제품 결정이다.
 * 그래서 종료할 때 몰래 설치하는 동작도 끈다: 받아 둔 것이 없으면 설치할 것도 없고, 켜 두면
 * 사용자가 누른 적 없는 교체가 앱을 끄는 순간에 일어난다.
 *
 * 재시작은 설치본에게 맡긴다. Windows 설치본은 `--force-run`으로, macOS는 시스템 갱신기가
 * 직접 앱을 다시 띄운다. 여기에 Console 갱신이 쓰는 "종료 예약 후 스스로 다시 켜기"를 겹치면
 * 재실행이 두 번 일어나므로, 이 경로는 그 예약을 쓰지 않는다.
 */

const SHELL_UPDATE_PATH = "/api/v1/desktop/shell-update";
const SHELL_UPDATE_COMMAND_PATH = "/api/v1/desktop/shell-update/command";
const SHELL_UPDATE_COMMAND_EVENTS_PATH = "/api/v1/desktop/shell-update/command/events";
const SHELL_UPDATE_COMMAND_EVENT = "desktop:shell-update-command";
const MAX_SHELL_UPDATE_SSE_BUFFER_CHARS = 8 * 1024;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SHELL_UPDATE_COMMANDS = ["check", "download", "restart"] as const;

export type ShellUpdateCommand = (typeof SHELL_UPDATE_COMMANDS)[number];
export type ShellUpdateStage = "idle" | "available" | "downloading" | "ready" | "error";

export interface ShellUpdateSnapshot {
  readonly stage: ShellUpdateStage;
  readonly version: string | null;
  readonly percent: number | null;
  readonly failure: string | null;
}

interface ShellUpdateCommandSnapshot {
  readonly command: ShellUpdateCommand | null;
  readonly commandId: string | null;
}

export interface ShellUpdater {
  /** 주기 확인과 창에서 온 확인이 같은 길을 쓴다 — 결과를 말하는 자리가 하나여야 한다. */
  check(): Promise<void>;
  download(): Promise<void>;
  restart(): void;
  snapshot(): ShellUpdateSnapshot;
}

export interface CreateShellUpdaterDeps {
  readonly updater: AppUpdater;
  readonly currentVersion: () => string;
  readonly publish: (snapshot: ShellUpdateSnapshot) => void;
  readonly log: (message: string) => void;
  /**
   * 개발 실행에서 이 동선을 실제로 밟아 보기 위한 갱신 설정 파일. 패키징된 앱은 언제나 자기 릴리스
   * 설정을 쓰므로 이 값을 받지 않는다 — 제품 경로를 바꾸는 스위치가 아니라, 제품 경로를 개발에서 열어
   * 보는 창이다. 주소만 따로 꽂지 않고 설정 파일을 통째로 가리키는 이유는, 내려받기와 설치가 확인과
   * 달리 이 파일을 다시 읽기 때문이다 — 둘이 갈라지면 확인은 되고 내려받기만 실패한다.
   */
  readonly developmentConfigPath?: string;
}

const idle = (): ShellUpdateSnapshot => ({ stage: "idle", version: null, percent: null, failure: null });

export function createShellUpdater(deps: CreateShellUpdaterDeps): ShellUpdater {
  const { updater } = deps;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = null;
  if (deps.developmentConfigPath) {
    updater.forceDevUpdateConfig = true;
    updater.updateConfigPath = deps.developmentConfigPath;
  }

  let state: ShellUpdateSnapshot = idle();

  const publish = (next: ShellUpdateSnapshot): void => {
    state = next;
    deps.publish(next);
  };

  updater.on("download-progress", (progress: { readonly percent?: number }) => {
    if (state.version === null) return;
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
    publish({ stage: "downloading", version: state.version, percent, failure: null });
  });
  updater.on("update-downloaded", (info: { readonly version?: string }) => {
    const version = info.version ?? state.version;
    if (!version) return;
    publish({ stage: "ready", version, percent: null, failure: null });
  });
  updater.on("error", (error: Error) => {
    deps.log(`shell update failed: ${error.message}`);
    // 사용자가 받기를 기다리던 중이었다면 그 기다림을 실패로 닫는다. 그 밖의 실패는 조용히
    // idle로 돌아간다 — 주기 확인이 못 닿았다는 사실까지 화면에 세울 이유는 없다.
    if (state.stage === "downloading" || state.stage === "ready") publish({ stage: "error", version: state.version, percent: null, failure: "download_failed" });
    else publish(idle());
  });

  const check = async (): Promise<void> => {
    // 받는 중이거나 받아 둔 것이 있으면 확인이 그 상태를 지우지 않는다.
    if (state.stage === "downloading" || state.stage === "ready") return;
    try {
      const result = await updater.checkForUpdates();
      const version = result?.updateInfo?.version ?? null;
      if (version === null || version === deps.currentVersion()) {
        publish(idle());
        return;
      }
      publish({ stage: "available", version, percent: null, failure: null });
    } catch (error) {
      deps.log(`shell update check failed: ${error instanceof Error ? error.message : String(error)}`);
      publish(state.stage === "available" ? state : idle());
    }
  };

  const download = async (): Promise<void> => {
    if (state.stage !== "available" || state.version === null) return;
    publish({ stage: "downloading", version: state.version, percent: 0, failure: null });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      deps.log(`shell update download failed: ${error instanceof Error ? error.message : String(error)}`);
      publish({ stage: "error", version: state.version, percent: null, failure: "download_failed" });
    }
  };

  const restart = (): void => {
    if (state.stage !== "ready") return;
    // 설치본이 앱을 다시 띄운다. 여기서 재시작을 따로 예약하면 두 번 뜬다.
    updater.quitAndInstall();
  };

  return { check, download, restart, snapshot: () => state };
}

export type ShellUpdateCommandSynchronizer = DesktopEventStream;

export interface ShellUpdateCommandSynchronizerDeps {
  /** 창이 시킨 일. 같은 표로 두 번 불리지 않는다. */
  readonly perform: (command: ShellUpdateCommand) => void;
  readonly fetch?: typeof fetch;
  readonly reconnectDelayMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createShellUpdateCommandSynchronizer(deps: ShellUpdateCommandSynchronizerDeps): ShellUpdateCommandSynchronizer {
  const handledCommandIds = new Set<string>();
  return createDesktopEventStream<ShellUpdateCommandSnapshot>({
    snapshotPath: SHELL_UPDATE_COMMAND_PATH,
    eventsPath: SHELL_UPDATE_COMMAND_EVENTS_PATH,
    eventName: SHELL_UPDATE_COMMAND_EVENT,
    parseSnapshot: parseShellUpdateCommand,
    apply: (snapshot) => {
      if (snapshot.commandId === null || snapshot.command === null) return;
      // 재연결하면 콘솔은 걸려 있던 명령을 다시 들려준다. 그 반복을 두 번의 수행으로 받아들이면
      // 사용자는 앱이 저 혼자 재시작하는 것을 본다.
      if (handledCommandIds.has(snapshot.commandId)) return;
      handledCommandIds.add(snapshot.commandId);
      deps.perform(snapshot.command);
    },
    maxFrameChars: MAX_SHELL_UPDATE_SSE_BUFFER_CHARS,
    normalizeOrigin: (origin) => normalizeAnyConsoleOrigin(origin, "desktop_shell_update_origin_invalid"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.reconnectDelayMs !== undefined ? { reconnectDelayMs: deps.reconnectDelayMs } : {}),
    ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
    ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
  });
}

export function parseShellUpdateCommandEvent(frame: string): ShellUpdateCommandSnapshot | null {
  return parseDesktopSseFrame(frame, SHELL_UPDATE_COMMAND_EVENT, parseShellUpdateCommand);
}

export function parseShellUpdateCommand(value: unknown): ShellUpdateCommandSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const { command, commandId } = entry;
  if (command === null && commandId === null) return { command: null, commandId: null };
  if (typeof commandId !== "string" || !COMMAND_ID_PATTERN.test(commandId)) return null;
  if (typeof command !== "string" || !SHELL_UPDATE_COMMANDS.includes(command as ShellUpdateCommand)) return null;
  return { command: command as ShellUpdateCommand, commandId };
}

/**
 * 상태는 셸만 알고 창은 읽기만 한다. 게시가 닿지 않아도(옛 콘솔이면 404) 갱신 자체는 계속 돈다 —
 * 그때 잃는 것은 화면의 표시뿐이다.
 */
export function createShellUpdatePublisher(deps: {
  readonly fetch: typeof fetch;
  readonly origin: () => string | null;
  readonly log: (message: string) => void;
}): (snapshot: ShellUpdateSnapshot) => void {
  return (snapshot) => {
    const origin = deps.origin();
    if (origin === null) return;
    void deps.fetch(`${origin}${SHELL_UPDATE_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(snapshot),
    }).then((response) => {
      if (!response.ok && response.status !== 401 && response.status !== 404) {
        deps.log(`shell update publish rejected with ${response.status}`);
      }
    }).catch((error: unknown) => {
      deps.log(`shell update publish failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}
