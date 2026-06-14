import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";
import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";
import type { IDisposable, IPty } from "node-pty";

import { injectAgentCliProfile, type FleetHookCommandEntry } from "./agent-cli/injection.js";
import type { AgentCliProfile } from "./agent-cli/types.js";
import { getAgentCliMetadata, getDefaultAgentCliId, parseAgentCliId } from "./agent-cli/registry.js";
import { createMissionControlProfileConfig, type RunAppOptions } from "./app.js";
import { type FleetCliOptions } from "./cli-args.js";
import {
  createProgrammaticInput,
  KITTY_DISABLE,
  KITTY_ENABLE,
  type PtyExitEvent,
  type PtyHost,
} from "./controls/index.js";
import { sanitizeCarrierResultReminder } from "./mission-bridge/job-bar/register.js";
import { createMissionControlController } from "./mission-control/controller.js";
import { discoverMissionControlCounts } from "./mission-control/loaded-counts.js";
import { createWikiProcessController } from "./mission-control/menu/wiki-panel.js";
import { createSessionOptionsRuntime } from "./mission-control/options/runtime.js";
import type { MissionControlLaunchProfile, MissionControlLaunchProfileOptions } from "./mission-control/types.js";
import { readFleetCliRelease } from "./release.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "./runtime/runtime.js";
import { startShell, type ShellStarter } from "./controls/pty/shell.js";
import { LocalTui } from "./tui/renderer.js";
import { getTerminalSize } from "./tui/terminal-size.js";
import { checkForUpdate } from "./update/check.js";

export interface NativeTerminalLaunchStrategyDeps {
  readonly detachInput: () => void;
  readonly getTerminalSize?: () => { readonly columns: number; readonly rows: number };
  readonly onActiveChildChange?: (child: NativeActiveChild | undefined) => void;
  readonly onAfterResume?: () => void;
  readonly registerInput: () => void;
  readonly runCleanup: () => void;
  readonly startShell?: ShellStarter;
  readonly stdin?: NativeInputStream;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly ui: Pick<LocalTui, "refreshSize" | "start" | "stop">;
}

export interface NativeRawPtyBridge {
  readonly kill: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly writeRaw: (data: string) => void;
}

export interface NativeActiveChild {
  readonly bridge: NativeRawPtyBridge;
  readonly dispose: () => void;
  readonly profile: AgentCliProfile;
}

interface NativeInputStream {
  on(event: "data", listener: (data: Buffer | string) => void): NativeInputStream;
  off(event: "data", listener: (data: Buffer | string) => void): NativeInputStream;
  resume(): NativeInputStream;
  setEncoding(encoding: BufferEncoding): NativeInputStream;
  setRawMode?(mode: boolean): NativeInputStream;
  readonly isRaw?: boolean;
  readonly isTTY?: boolean;
}

interface NativeRawPtySession {
  readonly bridge: NativeRawPtyBridge;
  readonly dispose: () => void;
  readonly waitExit: () => Promise<PtyExitEvent>;
}

type ProcessFatalEvent = "uncaughtException" | "unhandledRejection";

export async function runNativeApp(options: RunAppOptions = {}): Promise<void> {
  const argvOptions = options.argvOptions ?? createRunNativeAppArgOptions(options);
  const runtimeLifecycle = createFleetRuntimeLifecycle({ consoleRegister: argvOptions.headless });
  const agentCliCleanupCallbacks = new Set<() => void>();
  const runtime = await runtimeLifecycle.start();
  const invocationCwd = resolveInvocationCwd();
  const ui = new LocalTui({ cursorSyncEnabled: true });
  const initialStdinRaw = process.stdin.isRaw;
  let activeNativeChild: NativeActiveChild | undefined;
  let disposeCarrierReminderSubscription = () => {};
  let disposeInputStream = () => {};
  let disposeMissionControlInput = () => {};
  let stopping = false;
  let shutdownExitCode = 0;
  let missionControlDispose = () => {};
  const runAgentCliCleanup = () => {
    for (const cleanup of agentCliCleanupCallbacks) {
      cleanup();
    }
    agentCliCleanupCallbacks.clear();
  };
  const scheduleRender = () => {
    ui.requestRender();
  };
  const sessionOptionsRuntime = createSessionOptionsRuntime({
    argv: argvOptions,
    defaults: {
      cliId: getDefaultAgentCliId(),
      enableMetaphor: false,
      replaceSystemPrompt: true,
    },
    env: process.env,
    globalOptionsService: runtime.infraServices.globalOptionsService,
    onStatusChange: scheduleRender,
    parseCliId: parseAgentCliId,
  });
  const buildSystemPrompt = createSystemPromptBuilder({
    carrierRuntime: runtime.carrierRuntime,
  }).build;
  const missionControlProfileConfig = createMissionControlProfileConfig({
    authService: runtime.infraServices.authService,
    env: process.env,
    invocationCwd,
  });
  const wikiController = createWikiProcessController({
    cwd: invocationCwd,
    onChange: scheduleRender,
  });
  const release = readFleetCliRelease();
  const detachInput = () => {
    disposeInputStream();
    disposeInputStream = () => {};
    disposeMissionControlInput();
    disposeMissionControlInput = () => {};
  };
  const registerInput = () => {
    detachInput();
    disposeMissionControlInput = ui.addInputListener((data) => {
      missionControl.component.handleInput?.(data);
    });
    disposeInputStream = attachNativeInputStream(ui);
  };
  let resumeHook = scheduleRender;
  const launchProfile = createNativeTerminalLaunchStrategy({
    detachInput,
    onActiveChildChange: (child) => {
      activeNativeChild = child;
    },
    onAfterResume: () => resumeHook(),
    registerInput,
    runCleanup: runAgentCliCleanup,
    ui,
  });
  const missionControl = createMissionControlController({
    ...missionControlProfileConfig,
    initialCliId: sessionOptionsRuntime.getResolved().values.cliId,
    cliOptions: getAgentCliMetadata(),
    authService: runtime.infraServices.authService,
    carrierRuntime: runtime.carrierRuntime,
    createPtyHost: () => {
      throw new Error("fleet --native does not create an embedded Agent CLI PTY");
    },
    injectProfile: (profile, launchOptions) =>
      injectAgentCliProfile(profile, {
        buildSystemPrompt,
        carrierRuntime: runtime.carrierRuntime,
        dedicatedMcpSession: runtime.dedicatedMcpSession,
        enableMetaphor: (launchOptions ?? sessionOptionsRuntime.getDraft()).enableMetaphor,
        onCleanup: (cleanup) => agentCliCleanupCallbacks.add(cleanup),
        replaceSystemPrompt: (launchOptions ?? sessionOptionsRuntime.getDraft()).replaceSystemPrompt,
        pluginAssetsDir: options.pluginAssetsDir,
        pluginEntry: options.pluginEntry,
      }),
    launchProfile,
    loadedCounts: discoverMissionControlCounts({ invocationCwd }),
    onExitFleet: () => stop(),
    onRenderRequest: scheduleRender,
    env: process.env,
    invocationCwd,
    release,
    sessionOptions: sessionOptionsRuntime,
    wikiController,
  });
  missionControlDispose = missionControl.dispose;
  disposeCarrierReminderSubscription = subscribeNativeCarrierReminders(
    runtime.carrierRuntime.jobs.streaming.register,
    () => activeNativeChild,
  );
  checkForUpdate(release)
    .then((latestVersion) => {
      if (latestVersion !== undefined) {
        missionControl.setRelease({ ...release, latestVersion });
      }
    })
    .catch(() => {});

  const stop = () => {
    if (stopping) {
      process.exit(shutdownExitCode === 0 ? 1 : shutdownExitCode);
      return;
    }
    stopping = true;
    cleanupTerminal();
    missionControlDispose();
    runAgentCliCleanup();
    const timer = setTimeout(() => process.exit(shutdownExitCode), 8_000);
    timer.unref?.();
    runtimeLifecycle.shutdown().finally(() => {
      clearTimeout(timer);
      process.exit(shutdownExitCode);
    });
  };
  const stopAfterFatal = (event: ProcessFatalEvent, reason: unknown) => {
    shutdownExitCode = 1;
    logProcessFatal(event, reason);
    stop();
  };
  const cleanupTerminal = () => {
    detachInput();
    disposeCarrierReminderSubscription();
    disposeCarrierReminderSubscription = () => {};
    const activeChild = activeNativeChild;
    activeChild?.bridge.kill();
    activeChild?.dispose();
    activeNativeChild = undefined;
    restoreNativeInputRawMode(initialStdinRaw);
    process.stdout.write(KITTY_DISABLE);
    ui.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  process.on("uncaughtException", (error) => stopAfterFatal("uncaughtException", error));
  process.on("unhandledRejection", (reason) => stopAfterFatal("unhandledRejection", reason));
  process.on("exit", cleanupTerminal);

  // native 경로엔 2-pane용 TuiPtyManager가 없으므로, Mission Control 런처에 터미널 크기를
  // 직접 전파해야 한다. 전파하지 않으면 컨트롤러 rows가 0으로 남아 런처가 빈 화면을 렌더한다.
  const applyMissionControlSize = () => {
    const size = getTerminalSize();
    ui.refreshSize(size);
    missionControl.ptyView.resize(size.columns, size.rows);
    ui.requestRender();
  };
  resumeHook = applyMissionControlSize;
  ui.setChildren([missionControl.component]);
  applyMissionControlSize();
  ui.start();
  process.stdout.write(KITTY_ENABLE);
  registerInput();
  const resize = () => {
    const size = getTerminalSize();
    if (activeNativeChild !== undefined) {
      activeNativeChild.bridge.resize(size.columns, size.rows);
      return;
    }
    applyMissionControlSize();
  };
  process.stdout.on("resize", resize);
  process.on("SIGWINCH", resize);
}

export function createNativeTerminalLaunchStrategy(deps: NativeTerminalLaunchStrategyDeps): MissionControlLaunchProfile {
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;
  const readTerminalSize = deps.getTerminalSize ?? getTerminalSize;
  const startShellFn = deps.startShell ?? startShell;

  return async (launch: MissionControlLaunchProfileOptions): Promise<void> => {
    let cleanupRan = false;
    let rawSession: NativeRawPtySession | undefined;
    let resumed = false;
    const runCleanupOnce = () => {
      if (cleanupRan) {
        return;
      }
      cleanupRan = true;
      deps.runCleanup();
    };
    const disposeRawSession = () => {
      rawSession?.dispose();
      rawSession = undefined;
    };
    const resumeFleetOnce = () => {
      if (resumed) {
        return;
      }
      resumed = true;
      disposeRawSession();
      deps.onActiveChildChange?.(undefined);
      deps.ui.refreshSize(readTerminalSize());
      deps.ui.start();
      stdout.write(KITTY_ENABLE);
      deps.registerInput();
      deps.onAfterResume?.();
    };

    deps.detachInput();
    stdout.write(KITTY_DISABLE);
    deps.ui.stop();
    try {
      rawSession = startNativeRawPtySession({
        launch,
        startShell: startShellFn,
        stdin,
        stdout,
      });
      deps.onActiveChildChange?.({
        bridge: rawSession.bridge,
        dispose: disposeRawSession,
        profile: launch.profile,
      });
      launch.onNativeActive(launch.profile);
      const event = await rawSession.waitExit();
      disposeRawSession();
      deps.onActiveChildChange?.(undefined);
      runCleanupOnce();
      launch.onExit(event);
      resumeFleetOnce();
    } catch (error) {
      disposeRawSession();
      deps.onActiveChildChange?.(undefined);
      runCleanupOnce();
      resumeFleetOnce();
      throw error;
    }
  };
}

export function resyncNativeInputRawMode(stdin: NativeInputStream = process.stdin): void {
  if (!stdin.isTTY || stdin.setRawMode === undefined) {
    return;
  }
  // Windows 콘솔 한정 회귀 방어: 직전에 종료된 native child(node-pty/ConPTY)가 실제
  // 콘솔 입력 모드를 cooked(line/echo)로 되돌려 놓지만, libuv `uv_tty_set_mode`는 내부
  // 모드 캐시가 이미 RAW이면 `setRawMode(true)`를 early-return으로 no-op 처리해 실제
  // `SetConsoleMode`를 호출하지 않는다(win/tty.c). 그 결과 콘솔이 cooked로 남아 Mission
  // Control이 키 입력(raw byte)을 받지 못한다. NORMAL을 한 번 경유시켜 libuv 캐시를
  // 무효화하면 다음 `setRawMode(true)`가 실제 콘솔 모드를 RAW로 강제 재설정한다. termios
  // 기반 macOS/Linux는 child PTY가 부모 stdin 모드를 오염시키지 않으므로 토글이 불필요하다.
  if (process.platform === "win32") {
    stdin.setRawMode(false);
  }
  stdin.setRawMode(true);
}

function createRunNativeAppArgOptions(options: RunAppOptions): FleetCliOptions {
  return {
    argvOverrides: {
      cursorSync: options.cursorSync === false,
    },
    cursorSync: options.cursorSync !== false,
    cursorSyncExplicitlyEnabled: false,
    help: false,
    headless: false,
    nativeTerminal: true,
  };
}

function resolveInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

function attachNativeInputStream(ui: LocalTui): () => void {
  const stdin = process.stdin;
  const onData = (data: Buffer | string) => {
    ui.emitInput(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  };

  stdin.setEncoding("utf8");
  resyncNativeInputRawMode(stdin);
  stdin.resume();
  stdin.on("data", onData);

  return createOnce(() => {
    stdin.off("data", onData);
  });
}

function restoreNativeInputRawMode(initialRaw: boolean | undefined): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(Boolean(initialRaw));
  }
}

function startNativeRawPtySession(options: {
  readonly launch: MissionControlLaunchProfileOptions;
  readonly startShell: ShellStarter;
  readonly stdin: NativeInputStream;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
}): NativeRawPtySession {
  const { launch, stdin, stdout } = options;
  const pty = options.startShell({
    profile: {
      ...launch.profile,
      env: { ...launch.profile.env },
    },
  }, {
    cols: launch.cols,
    rows: launch.rows,
  });
  const dataDisposable = pty.onData((chunk) => {
    stdout.write(chunk);
  });
  let exitDisposable: IDisposable | undefined;
  const rawInput = (data: Buffer | string) => {
    pty.write(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  };
  const exitPromise = new Promise<PtyExitEvent>((resolve) => {
    exitDisposable = pty.onExit((event) => {
      exitDisposable?.dispose();
      exitDisposable = undefined;
      resolve({
        exitCode: event.exitCode,
        signal: event.signal,
      });
    });
  });
  const disposeRawInput = createOnce(() => {
    stdin.off("data", rawInput);
  });
  const dispose = createOnce(() => {
    disposeRawInput();
    dataDisposable.dispose();
    exitDisposable?.dispose();
    exitDisposable = undefined;
  });
  const bridge: NativeRawPtyBridge = {
    kill: () => pty.kill(),
    resize: (cols, rows) => pty.resize(cols, rows),
    writeRaw: (data) => pty.write(data),
  };

  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", rawInput);

  return {
    bridge,
    dispose,
    waitExit: () => exitPromise.finally(dispose),
  };
}

function subscribeNativeCarrierReminders(
  register: (handler: (event: CarrierJobStreamEvent) => void) => () => void,
  getActiveChild: () => NativeActiveChild | undefined,
): () => void {
  const unsubscribe = register((event) => {
    const reminder = extractCarrierResultSystemReminder(event);
    if (reminder === undefined) {
      return;
    }
    const activeChild = getActiveChild();
    if (activeChild === undefined) {
      return;
    }
    createProgrammaticInput({
      write: (data) => activeChild.bridge.writeRaw(data),
    } as Pick<PtyHost, "write"> as PtyHost, activeChild.profile).sendMessage(reminder);
  });

  return createOnce(unsubscribe);
}

function extractCarrierResultSystemReminder(event: CarrierJobStreamEvent): string | undefined {
  if (event.type !== "job:finalized") {
    return undefined;
  }
  if (typeof event.systemReminder !== "string" || event.systemReminder.trim().length === 0) {
    return undefined;
  }
  return sanitizeCarrierResultReminder(event.systemReminder);
}

function createOnce(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    callback();
  };
}

function logProcessFatal(event: ProcessFatalEvent, reason: unknown): void {
  process.stderr.write(`[fleet-cli] ${event}: ${formatProcessFatalReason(reason)}\n`);
}

function formatProcessFatalReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}
