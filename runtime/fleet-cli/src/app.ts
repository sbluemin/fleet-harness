import { attachInputStream } from "./tui/input-stream.js";
import { LocalTui } from "./tui/renderer.js";
import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";
import {
  assertInputContract,
  createCursorPolicySync,
  createDedicatedMouseRouter,
  createInputKeybindingConfig,
  createInputRouter,
  createKeybindingRegistry,
  createProgrammaticInput,
  createPtyHost,
  createRenderScheduler,
  createTuiPtyManager,
  KITTY_DISABLE,
  KITTY_ENABLE,
  toggleFleetInputMode,
  type InputKeybindingConfig,
  type KeybindingDefinition,
  type KeybindingRegistration,
  type PtyHost,
  createCsiUInputNormalizer,
  type TuiPtyManager,
} from "./controls/index.js";

import { injectAgentCliProfile } from "./agent-cli/injection.js";
import { getAgentCliMetadata, getDefaultAgentCliId, parseAgentCliId, resolveAgentCliId, resolveAgentCliProfile } from "./agent-cli/registry.js";
import type { FleetCliOptions } from "./cli-args.js";
import { createMissionControlController } from "./mission-control/controller.js";
import { discoverMissionControlCounts, readFleetCliRelease } from "./mission-control/loaded-counts.js";
import { createWikiProcessController } from "./mission-control/menu/wiki-panel.js";
import type { CreateMissionControlControllerOptions } from "./mission-control/types.js";
import { createMissionBridgeController } from "./mission-bridge/controller.js";
import { createSessionOptionsRuntime } from "./mission-control/options/runtime.js";
import type { SessionOptions } from "./mission-control/options/types.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "./runtime/runtime.js";
import { checkForUpdate } from "./update/check.js";

export interface RunAppOptions {
  readonly cursorSync?: boolean;
  readonly argvOptions?: FleetCliOptions;
}

type FleetHostKeybindingHandlers = Record<string, () => void>;
type MissionControlProfileConfig = Pick<CreateMissionControlControllerOptions, "cliOptions" | "initialCliId" | "resolveProfile">;

export interface CreateMissionControlProfileConfigOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly invocationCwd: string;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const DOUBLE_TAP_WINDOW_MS = 2_000;
const INTERRUPT_DEDUPE_WINDOW_MS = 100;
const DEFAULT_HOST_KEYBINDINGS: readonly KeybindingDefinition[] = [
  { action: "host-exit", key: "\x11", label: "Ctrl+Q" },
  { action: "host-interrupt", key: "\x03", label: "Ctrl+C" },
  { action: "mode-toggle", key: "\x14", label: "Ctrl+T" },
];

export function createMissionControlProfileConfig(
  options: CreateMissionControlProfileConfigOptions,
): MissionControlProfileConfig {
  return {
    cliOptions: getAgentCliMetadata(),
    initialCliId: resolveAgentCliId(options.env),
    resolveProfile: (selectedCliId, launchOptions?: SessionOptions) =>
      resolveAgentCliProfile(options.env, options.invocationCwd, { cliId: selectedCliId, model: launchOptions?.model }),
  };
}

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const runtimeLifecycle = createFleetRuntimeLifecycle();
  const agentCliCleanupCallbacks = new Set<() => void>();
  const runtime = await runtimeLifecycle.start();
  const argvOptions = options.argvOptions ?? createRunAppArgOptions(options);
  const sessionOptionsRuntime = createSessionOptionsRuntime({
    argv: argvOptions,
    defaults: {
      cliId: getDefaultAgentCliId(),
      enableMetaphor: false,
      native: false,
      replaceSystemPrompt: true,
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
  let modeToggleSuppressed = false;
  let syncCursorPolicy = () => {};
  let sendCarrierResultReminder = (_text: string) => {};
  const scheduleRender = createRenderScheduler(ui, () => syncCursorPolicy());
  const buildSystemPrompt = createSystemPromptBuilder({
    carrierRuntime: runtime.carrierRuntime,
    mcpRegistry: runtime.mcpRegistry,
  }).build;
  const invocationCwd = resolveInvocationCwd();
  const missionControlProfileConfig = createMissionControlProfileConfig({
    env: process.env,
    invocationCwd,
  });
  // Composition root에서 실제 Fleet Wiki daemon helper를 쓰는 기본 컨트롤러를 고정한다.
  const wikiController = createWikiProcessController({
    cwd: invocationCwd,
    onChange: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
  });
  const release = readFleetCliRelease();
  const missionControl = createMissionControlController({
    ...missionControlProfileConfig,
    initialCliId: cliId,
    cliOptions: missionControlProfileConfig.cliOptions,
    authService: runtime.infraServices.authService,
    carrierRuntime: runtime.carrierRuntime,
    createPtyHost: (profile) => createPtyHost({ profile }),
    injectProfile: (profile, launchOptions) =>
      (launchOptions ?? sessionOptionsRuntime.getDraft()).native
        ? Promise.resolve(profile)
        : injectAgentCliProfile(profile, {
            buildSystemPrompt,
            carrierRuntime: runtime.carrierRuntime,
            dedicatedMcpSession: runtime.dedicatedMcpSession,
            enableMetaphor: (launchOptions ?? sessionOptionsRuntime.getDraft()).enableMetaphor,
            onCleanup: (cleanup) => agentCliCleanupCallbacks.add(cleanup),
            replaceSystemPrompt: (launchOptions ?? sessionOptionsRuntime.getDraft()).replaceSystemPrompt,
          }),
    loadedCounts: discoverMissionControlCounts({ invocationCwd }),
    onExitFleet: () => stop(),
    onRenderRequest: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
    env: process.env,
    invocationCwd,
    release,
    sessionOptions: sessionOptionsRuntime,
    wikiController,
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
    getNative: () => sessionOptionsRuntime.getDraft().native,
    getRows: () => ptyManager?.getCurrentRequest().fleetRows ?? Math.max(0, ui.rows - missionControl.ptyView.maxRows),
    onCarrierResultReminder: (text) => sendCarrierResultReminder(text),
    onJobBarRenderRequest: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
    requestResize: () => ptyManager?.requestResize("fleet-overlay"),
    requestRender: scheduleRender,
  });
  ptyManager = createTuiPtyManager({
    fleetPty: missionBridge.ptyApi,
    ptyHost: missionControl.ptyHost,
    ptyView: missionControl.ptyView,
    refreshSize: (size) => ui.refreshSize(size),
    requestRender: scheduleRender,
  });
  sendCarrierResultReminder = (text) => {
    const activeProfile = missionControl.getActiveProfile();
    if (activeProfile === undefined) {
      return;
    }
    createProgrammaticInput({
      ...missionControl.ptyHost,
      write: (data) => missionControl.writeChildInput(data),
    }, activeProfile).sendMessage(text);
  };
  let stopping = false;
  let disposeInputStream = () => {};
  let interruptWarningStartedAt = 0;
  let lastInterruptHandledAt = 0;
  let interruptWarningTimer: ReturnType<typeof setTimeout> | undefined;
  const resize = () => ptyManager?.requestResize("terminal-resize");
  const stop = () => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    clearInterruptWarningTimer();
    missionBridge.jobBarState.setPendingExitWarning(false);
    stopApp(ui, missionControl.dispose, missionControl.ptyHost, resize, disposeInputStream, missionBridge.dispose, runtimeLifecycle, agentCliCleanupCallbacks);
  };
  const requestInterrupt = () => {
    const now = Date.now();
    if (now - lastInterruptHandledAt <= INTERRUPT_DEDUPE_WINDOW_MS) {
      return;
    }
    lastInterruptHandledAt = now;

    if (interruptWarningStartedAt !== 0 && now - interruptWarningStartedAt <= DOUBLE_TAP_WINDOW_MS) {
      stop();
      return;
    }

    interruptWarningStartedAt = now;
    missionBridge.jobBarState.setPendingExitWarning(true);
    clearInterruptWarningTimer();
    interruptWarningTimer = setTimeout(() => {
      interruptWarningStartedAt = 0;
      interruptWarningTimer = undefined;
      missionBridge.jobBarState.setPendingExitWarning(false);
    }, DOUBLE_TAP_WINDOW_MS);
    interruptWarningTimer.unref?.();
  };
  const clearInterruptWarningTimer = () => {
    if (interruptWarningTimer === undefined) return;
    clearTimeout(interruptWarningTimer);
    interruptWarningTimer = undefined;
  };
  const handleModeToggleCursorSuppression = () => {
    modeToggleSuppressed = true;
    ui.setCursorAnchorTarget(undefined);
    scheduleRender(() => {
      modeToggleSuppressed = false;
      syncCursorPolicy();
      ui.requestRender();
    });
  };
  const fleetKeybindings = createKeybindingRegistry({ definitions: DEFAULT_HOST_KEYBINDINGS });
  const keybindings = createFleetHostInputKeybindingConfig({
    definitions: fleetKeybindings.list(),
    handlers: {
      "host-exit": stop,
      "host-interrupt": requestInterrupt,
      "mode-toggle": handleModeToggleCursorSuppression,
    },
    routeHostInterruptThroughHandler: true,
  });
  const csiUNormalizer = createCsiUInputNormalizer({
    csiUMap: fleetKeybindings.createCsiUNormalizationMap(),
  });
  const router = createInputRouter({
    getLayout: () =>
      ptyManager?.getCurrentRequest() ?? {
        columns: ui.columns,
        dedicatedRows: missionControl.ptyView.maxRows,
        fleetRows: Math.max(0, ui.rows - missionControl.ptyView.maxRows),
        totalRows: ui.rows,
      },
    initialMode: "MIRROR",
    keybindings,
    onExit: stop,
    onModeChange: handleModeToggleCursorSuppression,
    routeDedicatedMouse: createDedicatedMouseRouter({
      ptyHost: missionControl.ptyHost,
      ptyView: missionControl.ptyView,
      requestRender: scheduleRender,
    }),
    routeFleetInput: (data) => missionBridge.ptyApi.dispatchInput(data),
    routeFleetMouse: (event) => missionBridge.ptyApi.dispatchMouse(event),
    toggleMode: toggleFleetInputMode,
    writeDedicated: (data) => missionControl.ptyHost.write(data),
  });
  syncCursorPolicy = createCursorPolicySync({
    cursorSync: argvOptions.cursorSync,
    cursorSyncExplicitlyEnabled: argvOptions.cursorSyncExplicitlyEnabled,
    fleetPty: missionBridge.ptyApi,
    getActiveAgentProfileId: () => missionControl.getActiveProfile()?.id,
    getMode: router.getMode,
    hasActiveMissionControlPanel: missionControl.hasActivePanel,
    isModeToggleSuppressed: () => modeToggleSuppressed,
    ptyView: missionControl.ptyView,
    ui,
  });

  ui.setChildren([missionControl.component, missionBridge.component]);
  syncCursorPolicy();
  missionBridge.start();
  assertInputContract(keybindings);
  ptyManager.requestResize("initial");
  ui.addInputListener((data) => router.route(csiUNormalizer.normalize(data)));

  process.stdout.on("resize", resize);
  process.on("SIGWINCH", resize);
  process.on("SIGINT", requestInterrupt);
  process.on("SIGTERM", stop);

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
    cursorSyncExplicitlyEnabled: false,
    help: false,
  };
}

export function createFleetHostInputKeybindingConfig(options: {
  readonly definitions: readonly KeybindingDefinition[];
  readonly handlers: FleetHostKeybindingHandlers;
  readonly routeHostInterruptThroughHandler?: boolean;
}): InputKeybindingConfig {
  const routeHostInterruptThroughHandler = options.routeHostInterruptThroughHandler === true;
  const exitKeys = options.definitions
    .filter((definition) =>
      definition.action === "host-exit" ||
      (!routeHostInterruptThroughHandler && definition.action === "host-interrupt")
    )
    .map((definition) => definition.key);
  const modeToggleKeys = options.definitions
    .filter((definition) => definition.action === "mode-toggle")
    .map((definition) => definition.key);
  const registeredKeybindings = options.definitions
    .filter((definition) => definition.action !== "host-exit" && definition.action !== "mode-toggle")
    .filter((definition) => routeHostInterruptThroughHandler || definition.action !== "host-interrupt")
    .map((definition): KeybindingRegistration => {
      const handler = options.handlers[definition.action];
      if (handler === undefined) {
        throw new Error(`Missing Fleet host keybinding handler: ${definition.action}`);
      }

      return {
        action: definition.action,
        handler,
        key: definition.key,
      };
    });

  return createInputKeybindingConfig({
    exitKeys,
    modeToggleKeys,
    registeredKeybindings,
  });
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
  disposeMissionBridge: () => void,
  runtimeLifecycle: FleetRuntimeLifecycle,
  cleanupCallbacks: Iterable<() => void>,
): void {
  process.stdout.off("resize", resize);
  process.off("SIGWINCH", resize);
  disposeInputStream();
  disposeMissionControl();
  disposeMissionBridge();
  process.stdout.write(KITTY_DISABLE);
  ptyHost.kill();
  for (const cleanup of cleanupCallbacks) {
    cleanup();
  }
  ui.stop();
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  timer.unref?.();
  runtimeLifecycle.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}
