import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  createCarrierResultReminderRouter,
  createSystemPromptBuilder,
  getAgentCliMetadata,
  getDefaultAgentCliId,
  injectAgentCliProfile,
  parseAgentCliId,
  type AgentCliProfile,
} from "@dotobokuri/fleet-admiral";
import type { IDisposable, IPty } from "node-pty";

import {
  buildFleetHookCommand,
  runCodexCommand,
  withFleetMarketplaceLock,
} from "./agent-cli/host-hooks.js";
import { createMissionControlProfileConfig, type RunAppOptions } from "./app.js";
import { type FleetCliOptions } from "./cli-args.js";
import {
  KITTY_DISABLE,
  KITTY_ENABLE,
  type PtyExitEvent,
} from "./controls/index.js";
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
  readonly getTerminalSize?: () => { readonly columns: number; readonly rows: number };
  readonly onActiveChildChange?: (child: NativeActiveChild | undefined) => void;
  readonly onAfterResume?: () => void;
  readonly runCleanup: () => void;
  readonly startShell?: ShellStarter;
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

interface NativeRawPtySession {
  readonly bridge: NativeRawPtyBridge;
  readonly dispose: () => void;
  readonly waitExit: () => Promise<PtyExitEvent>;
}

type ProcessFatalEvent = "uncaughtException" | "unhandledRejection";
type NativeInputDebugDetail = Readonly<Record<string, unknown>>;

export async function runNativeApp(options: RunAppOptions = {}): Promise<void> {
  const argvOptions = options.argvOptions ?? createRunNativeAppArgOptions(options);
  const runtimeLifecycle = createFleetRuntimeLifecycle();
  const agentCliCleanupCallbacks = new Set<() => void>();
  const runtime = await runtimeLifecycle.start();
  const invocationCwd = resolveInvocationCwd();
  const debugNativeInput = createNativeInputDebugger(invocationCwd);
  const ui = new LocalTui({ cursorSyncEnabled: true });
  const initialStdinRaw = process.stdin.isRaw;
  let activeNativeChild: NativeActiveChild | undefined;
  let disposeCarrierReminderSubscription = () => {};
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
    authEnvResolver: runtime.authEnvResolver,
    authService: runtime.infraServices.authService,
    env: process.env,
    invocationCwd,
  });
  const wikiController = createWikiProcessController({
    cwd: invocationCwd,
    onChange: scheduleRender,
  });
  const release = readFleetCliRelease();
  const onStdinData = (data: Buffer | string) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    const child = activeNativeChild;
    debugNativeInput("stdin-data", {
      flowing: process.stdin.readableFlowing,
      isRaw: process.stdin.isRaw,
      len: text.length,
      sink: child === undefined ? "launcher" : "child",
    });
    if (child !== undefined) {
      child.bridge.writeRaw(text);
      return;
    }
    ui.emitInput(text);
  };
  let resumeHook = scheduleRender;
  const launchProfile = createNativeTerminalLaunchStrategy({
    onActiveChildChange: (child) => {
      activeNativeChild = child;
      if (child !== undefined) {
        debugNativeInput("child-enter", {});
        return;
      }
      debugNativeInput("resume", {
        flowing: process.stdin.readableFlowing,
        isRaw: process.stdin.isRaw,
        listenerCount: process.stdin.listenerCount("data"),
      });
    },
    onAfterResume: () => resumeHook(),
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
        codexCommandRunner: runCodexCommand,
        dataDir: runtime.dataDir,
        dedicatedMcpSession: runtime.dedicatedMcpSession,
        enableMetaphor: (launchOptions ?? sessionOptionsRuntime.getDraft()).enableMetaphor,
        hookExec: profile.id === "claude" || profile.id === "claude-kimi"
          ? buildFleetHookCommand(options.pluginEntry)
          : undefined,
        onCleanup: (cleanup) => agentCliCleanupCallbacks.add(cleanup),
        replaceSystemPrompt: (launchOptions ?? sessionOptionsRuntime.getDraft()).replaceSystemPrompt,
        withMarketplaceLock: withFleetMarketplaceLock,
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
  disposeCarrierReminderSubscription = createOnce(createCarrierResultReminderRouter({
    streamRegister: runtime.carrierRuntime.jobs.streaming.register,
    resolveSink: () => {
      const activeChild = activeNativeChild;
      if (activeChild === undefined) {
        return undefined;
      }
      return {
        write: (data) => activeChild.bridge.writeRaw(data),
      };
    },
    resolvePolicy: () => activeNativeChild?.profile.messagePolicy ?? {},
  }));
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
    process.stdin.off("data", onStdinData);
    disposeMissionControlInput();
    disposeMissionControlInput = () => {};
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
  disposeMissionControlInput = ui.addInputListener((data) => {
    missionControl.component.handleInput?.(data);
  });
  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", onStdinData);
  debugNativeInput("boot-attach", {
    isRaw: process.stdin.isRaw,
    isTTY: process.stdin.isTTY,
    listenerCount: process.stdin.listenerCount("data"),
  });
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
  const readTerminalSize = deps.getTerminalSize ?? getTerminalSize;
  const startShellFn = deps.startShell ?? startShell;

  return async (launch: MissionControlLaunchProfileOptions): Promise<void> => {
    let cleanupRan = false;
    let rawSession: NativeRawPtySession | undefined;
    let activeChildCleared = false;
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
    const clearActiveChildOnce = () => {
      if (activeChildCleared) {
        return;
      }
      activeChildCleared = true;
      deps.onActiveChildChange?.(undefined);
    };
    const resumeFleetOnce = () => {
      if (resumed) {
        return;
      }
      resumed = true;
      disposeRawSession();
      clearActiveChildOnce();
      deps.ui.refreshSize(readTerminalSize());
      deps.ui.start();
      stdout.write(KITTY_ENABLE);
      deps.onAfterResume?.();
    };

    stdout.write(KITTY_DISABLE);
    deps.ui.stop();
    try {
      rawSession = startNativeRawPtySession({
        launch,
        startShell: startShellFn,
        stdout,
      });
      deps.onActiveChildChange?.({
        bridge: rawSession.bridge,
        dispose: disposeRawSession,
        profile: launch.profile,
      });
      activeChildCleared = false;
      launch.onNativeActive(launch.profile);
      const event = await rawSession.waitExit();
      clearActiveChildOnce();
      disposeRawSession();
      runCleanupOnce();
      launch.onExit(event);
      resumeFleetOnce();
    } catch (error) {
      disposeRawSession();
      clearActiveChildOnce();
      runCleanupOnce();
      resumeFleetOnce();
      throw error;
    }
  };
}

function createRunNativeAppArgOptions(options: RunAppOptions): FleetCliOptions {
  return {
    argvOverrides: {
      cursorSync: options.cursorSync === false,
    },
    cursorSync: options.cursorSync !== false,
    help: false,
    nativeTerminal: true,
  };
}

function resolveInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

function createNativeInputDebugger(invocationCwd: string): (event: string, detail: NativeInputDebugDetail) => void {
  const debugValue = process.env.FLEET_DEBUG_NATIVE_INPUT;
  if (debugValue === undefined || debugValue === "" || debugValue === "0") {
    return () => undefined;
  }
  const logPath = debugValue === "1" || debugValue === "true"
    ? join(invocationCwd, "fleet-native-input-debug.log")
    : debugValue;
  return (event, detail) => {
    try {
      appendFileSync(logPath, `${JSON.stringify({ ts: Date.now(), event, ...detail })}\n`);
    } catch {
      // 진단 로그 실패는 native 입력 경로를 방해하지 않는다.
    }
  };
}

function restoreNativeInputRawMode(initialRaw: boolean | undefined): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(Boolean(initialRaw));
  }
}

function startNativeRawPtySession(options: {
  readonly launch: MissionControlLaunchProfileOptions;
  readonly startShell: ShellStarter;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
}): NativeRawPtySession {
  const { launch, stdout } = options;
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
  const dispose = createOnce(() => {
    dataDisposable.dispose();
    exitDisposable?.dispose();
    exitDisposable = undefined;
  });
  const bridge: NativeRawPtyBridge = {
    kill: () => pty.kill(),
    resize: (cols, rows) => pty.resize(cols, rows),
    writeRaw: (data) => pty.write(data),
  };

  return {
    bridge,
    dispose,
    waitExit: () => exitPromise.finally(dispose),
  };
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
