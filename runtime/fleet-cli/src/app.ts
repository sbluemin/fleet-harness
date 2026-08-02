import {
  createCarrierResultReminderRouter,
  createSystemPromptBuilder,
  getAgentCliMetadata,
  getDefaultAgentCliId,
  injectAgentCliProfile,
  parseAgentCliId,
  resolveAgentCliId,
  resolveAgentCliProfile,
} from "@dotobokuri/fleet-admiral";

import {
  assertInputContract,
  createCursorPolicySync,
  createDedicatedMouseRouter,
  createInputKeybindingConfig,
  createInputRouter,
  createPtyHost,
  createRenderScheduler,
  createTuiPtyManager,
  KITTY_DISABLE,
  KITTY_ENABLE,
  type PtyHost,
  type TuiPtyManager,
} from "./controls/index.js";
import {
  runCodexCommand,
  withFleetMarketplaceLock,
} from "./agent-cli/host-hooks.js";
import type { FleetCliOptions } from "./cli-args.js";
import { createMissionControlController } from "./mission-control/controller.js";
import { discoverMissionControlCounts } from "./mission-control/loaded-counts.js";
import { createSessionOptionsRuntime } from "./mission-control/options/runtime.js";
import type { SessionOptions } from "./mission-control/options/runtime.js";
import type { CreateMissionControlControllerOptions } from "./mission-control/types.js";
import { createMissionBridgeController } from "./mission-bridge/controller.js";
import { readFleetCliRelease } from "./release.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "./runtime/runtime.js";
import { attachInputStream } from "./tui/input-stream.js";
import { LocalTui } from "./tui/renderer.js";
import { checkForUpdate } from "./update/check.js";

export interface RunAppOptions {
  readonly cursorSync?: boolean;
  readonly argvOptions?: FleetCliOptions;
}

type MissionControlProfileConfig = Pick<CreateMissionControlControllerOptions, "cliOptions" | "initialCliId" | "resolveProfile">;
type ProcessFatalEvent = "uncaughtException" | "unhandledRejection";

export interface CreateMissionControlProfileConfigOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly invocationCwd: string;
}

const SHUTDOWN_TIMEOUT_MS = 8_000;

export function createMissionControlProfileConfig(
  options: CreateMissionControlProfileConfigOptions,
): MissionControlProfileConfig {
  return {
    cliOptions: getAgentCliMetadata(),
    initialCliId: resolveAgentCliId(options.env),
    resolveProfile: (selectedCliId, launchOptions?: SessionOptions) =>
      resolveAgentCliProfile(options.env, options.invocationCwd, {
        cliId: selectedCliId,
        model: launchOptions?.model,
      }),
  };
}

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const invocationCwd = resolveInvocationCwd();
  const argvOptions = options.argvOptions ?? createRunAppArgOptions(options);
  const runtimeLifecycle = createFleetRuntimeLifecycle();
  const agentCliCleanupCallbacks = new Set<() => void>();
  const runtime = await runtimeLifecycle.start();
  const sessionOptionsRuntime = createSessionOptionsRuntime({
    argv: argvOptions,
    defaults: {
      cliId: getDefaultAgentCliId(),
      enableMetaphor: false,
    },
    env: process.env,
    globalOptionsService: runtime.infraServices.globalOptionsService,
    onStatusChange: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
    parseCliId: parseAgentCliId,
  });
  const initialSessionOptions = sessionOptionsRuntime.getResolved().values;
  const cliId = initialSessionOptions.cliId;
  const ui = new LocalTui({ cursorSyncEnabled: true });
  let ptyManager: TuiPtyManager | undefined;
  let syncCursorPolicy = () => {};
  let disposeCarrierReminderSubscription = () => {};
  const scheduleRender = createRenderScheduler(ui, () => syncCursorPolicy());
  const buildSystemPrompt = createSystemPromptBuilder({
    carrierRuntime: runtime.carrierRuntime,
  }).build;
  const missionControlProfileConfig = createMissionControlProfileConfig({
    env: process.env,
    invocationCwd,
  });
  const release = readFleetCliRelease();
  const missionControl = createMissionControlController({
    ...missionControlProfileConfig,
    authService: runtime.infraServices.authService,
    initialCliId: cliId,
    cliOptions: missionControlProfileConfig.cliOptions,
    carrierRuntime: runtime.carrierRuntime,
    createPtyHost: (profile) => createPtyHost({ profile }),
    injectProfile: (profile, launchOptions) =>
      injectAgentCliProfile(profile, {
        buildSystemPrompt,
        codexCommandRunner: runCodexCommand,
        dataDir: runtime.dataDir,
        dedicatedMcpSession: runtime.dedicatedMcpSession,
        enableMetaphor: (launchOptions ?? sessionOptionsRuntime.getDraft()).enableMetaphor,
        onCleanup: (cleanup) => agentCliCleanupCallbacks.add(cleanup),
        withMarketplaceLock: withFleetMarketplaceLock,
      }),
    loadedCounts: discoverMissionControlCounts({ dataDir: runtime.dataDir, invocationCwd }),
    onExitFleet: () => stop(),
    onRenderRequest: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
    env: process.env,
    invocationCwd,
    release,
    sessionOptions: sessionOptionsRuntime,
  });
  checkForUpdate(release)
    .then((latestVersion) => {
      if (latestVersion !== undefined) {
        missionControl.setRelease({ ...release, latestVersion });
      }
    })
    .catch(() => {});
  const missionBridge = createMissionBridgeController({
    addInputListener: (listener) => ui.addInputListener(listener),
    carrierRuntime: runtime.carrierRuntime,
    getColumns: () => ui.columns,
    getRows: () => ptyManager?.getCurrentRequest().fleetRows ?? Math.max(0, ui.rows - missionControl.ptyView.maxRows),
    onJobBarRenderRequest: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
    requestResize: () => ptyManager?.requestResize("fleet-overlay"),
    requestRender: scheduleRender,
  });
  disposeCarrierReminderSubscription = createCarrierResultReminderRouter({
    streamRegister: runtime.carrierRuntime.jobs.streaming.register,
    resolveSink: () => {
      if (missionControl.getActiveProfile() === undefined) {
        return undefined;
      }
      return {
        write: (data) => missionControl.writeChildInput(data),
      };
    },
    resolvePolicy: () => missionControl.getActiveProfile()?.messagePolicy ?? {},
    // 활성 child는 단일하므로 상수 키로 지연 제출을 직렬화한다(동시 도착 리마인더 뒤섞임 방지).
    resolveSessionKey: () => (missionControl.getActiveProfile() === undefined ? undefined : "cli-active-child"),
  });
  ptyManager = createTuiPtyManager({
    fleetPty: missionBridge.ptyApi,
    ptyHost: missionControl.ptyHost,
    ptyView: missionControl.ptyView,
    refreshSize: (size) => ui.refreshSize(size),
    requestRender: scheduleRender,
  });
  let stopping = false;
  let disposeInputStream = () => {};
  let shutdownExitCode = 0;
  const resize = () => ptyManager?.requestResize("terminal-resize");
  const stop = () => {
    if (stopping) {
      process.exit(shutdownExitCode === 0 ? 1 : shutdownExitCode);
      return;
    }
    stopping = true;
    stopApp(
      ui,
      missionControl.dispose,
      missionControl.ptyHost,
      resize,
      disposeInputStream,
      disposeCarrierReminderSubscription,
      missionBridge.dispose,
      runtimeLifecycle,
      agentCliCleanupCallbacks,
      shutdownExitCode,
    );
  };
  const stopAfterFatal = (event: ProcessFatalEvent, reason: unknown) => {
    shutdownExitCode = 1;
    logProcessFatal(event, reason);
    stop();
  };
  const keybindings = createInputKeybindingConfig({});
  const router = createInputRouter({
    getLayout: () =>
      ptyManager?.getCurrentRequest() ?? {
        columns: ui.columns,
        dedicatedRows: missionControl.ptyView.maxRows,
        fleetRows: Math.max(0, ui.rows - missionControl.ptyView.maxRows),
        totalRows: ui.rows,
      },
    keybindings,
    routeDedicatedMouse: createDedicatedMouseRouter({
      ptyHost: missionControl.ptyHost,
      ptyView: missionControl.ptyView,
      requestRender: scheduleRender,
    }),
    routeFleetMouse: (event) => missionBridge.ptyApi.dispatchMouse(event),
    writeDedicated: (data) => missionControl.ptyHost.write(data),
  });
  syncCursorPolicy = createCursorPolicySync({
    cursorSync: argvOptions.cursorSync,
    fleetPty: missionBridge.ptyApi,
    hasActiveMissionControlPanel: missionControl.hasActivePanel,
    ptyView: missionControl.ptyView,
    ui,
  });

  ui.setChildren([missionControl.component, missionBridge.component]);
  syncCursorPolicy();
  missionBridge.start();
  assertInputContract(keybindings);
  ptyManager.requestResize("initial");
  ui.addInputListener((data) => router.route(data));

  process.stdout.on("resize", resize);
  process.on("SIGWINCH", resize);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  process.on("uncaughtException", (error) => stopAfterFatal("uncaughtException", error));
  process.on("unhandledRejection", (reason) => stopAfterFatal("unhandledRejection", reason));

  const disableKeyboardProtocol = () => process.stdout.write(KITTY_DISABLE);
  process.on("exit", disableKeyboardProtocol);

  ui.start();
  process.stdout.write(KITTY_ENABLE);
  disposeInputStream = attachInputStream(ui);
}

function createRunAppArgOptions(options: RunAppOptions): FleetCliOptions {
  return {
    argvOverrides: {
      cursorSync: options.cursorSync === false,
    },
    cursorSync: options.cursorSync !== false,
    help: false,
  };
}

function resolveInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

function stopApp(
  ui: LocalTui,
  disposeMissionControl: () => void,
  ptyHost: PtyHost,
  resize: () => void,
  disposeInputStream: () => void,
  disposeCarrierReminderSubscription: () => void,
  disposeMissionBridge: () => void,
  runtimeLifecycle: FleetRuntimeLifecycle,
  cleanupCallbacks: Iterable<() => void>,
  exitCode: number,
): void {
  process.stdout.off("resize", resize);
  process.off("SIGWINCH", resize);
  disposeInputStream();
  disposeCarrierReminderSubscription();
  disposeMissionControl();
  disposeMissionBridge();
  process.stdout.write(KITTY_DISABLE);
  ptyHost.kill();
  for (const cleanup of cleanupCallbacks) {
    cleanup();
  }
  ui.stop();
  const timer = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
  timer.unref?.();
  runtimeLifecycle.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(exitCode);
  });
}

function logProcessFatal(event: ProcessFatalEvent, reason: unknown): void {
  const formattedReason = formatProcessFatalReason(reason);
  // 치명 오류에서도 ACP disconnect 체인을 타도록 먼저 로그를 남기고 graceful stop으로 넘긴다.
  process.stderr.write(`[fleet-cli] ${event}: ${formattedReason}\n`);
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
