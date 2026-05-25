import { attachInputStream, LocalTui } from "@dotobokuri/fleet-tui/core";
import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";
import { readRecentLogFiles } from "@dotobokuri/fleet-infra/log";
import {
  assertInputContract,
  createCursorPolicySync,
  createDedicatedMouseRouter,
  createFleetPtyApi,
  createFleetPtyViewport,
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

import { sanitizeCarrierResultReminder, subscribeJobBar } from "./carrier-status/job-bar-register.js";
import { createJobBarState } from "./carrier-status/job-bar-state.js";
import { createJobBarSections } from "./carrier-status/job-bar-section.js";
import { createCarrierStatusKeybindingHandler } from "./carrier-status/register.js";
import { injectAgentCliProfile } from "./agent-cli/injection.js";
import { getAgentCliMetadata, getDefaultAgentCliId, parseAgentCliId, resolveAgentCliId, resolveAgentCliProfile } from "./agent-cli/registry.js";
import type { FleetCliOptions } from "./cli-args.js";
import { createMissionControlController } from "./mission-control/controller.js";
import { discoverMissionControlCounts, readFleetCliRelease } from "./mission-control/loaded-counts.js";
import type { CreateMissionControlControllerOptions } from "./mission-control/types.js";
import { createDefaultFleetPtyComponent } from "./sections/default-sections.js";
import { FleetStatusSection } from "./sections/fleet-status-section.js";
import { createSessionOptionsRuntime } from "./mission-control/options/runtime.js";
import type { ResolvedSessionOptions, SessionOptions } from "./mission-control/options/types.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "./runtime/runtime.js";

export interface RunAppOptions {
  readonly cursorSync?: boolean;
  readonly argvOptions?: FleetCliOptions;
}

type FleetHostKeybindingHandlers = Record<string, () => void>;
type MissionControlProfileConfig = Pick<CreateMissionControlControllerOptions, "cliOptions" | "defaultCliId" | "resolveProfile">;

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
  { action: "carrier-status", key: "\x1bo", label: "Alt+O", normalizationAliases: ["\x1bO"] },
];

const STANDARD_KEYBOARD_PROTOCOL_STATE = {
  outerEnabled: false,
  childRequested: false,
  effectiveMode: "passthrough" as const,
};
export function createMissionControlProfileConfig(
  options: CreateMissionControlProfileConfigOptions,
): MissionControlProfileConfig {
  return {
    cliOptions: getAgentCliMetadata(),
    defaultCliId: resolveAgentCliId(options.env),
    resolveProfile: (selectedCliId, launchOptions?: SessionOptions) =>
      resolveAgentCliProfile(options.env, options.invocationCwd, { cliId: selectedCliId, model: launchOptions?.model }),
  };
}

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const runtimeLifecycle = createFleetRuntimeLifecycle();
  const runtime = await runtimeLifecycle.start();
  const argvOptions = options.argvOptions ?? createRunAppArgOptions(options);
  const sessionOptionsRuntime = createSessionOptionsRuntime({
    argv: argvOptions,
    defaults: {
      cliId: getDefaultAgentCliId(),
      cursorSync: true,
      enableMetaphor: false,
      native: false,
      replaceSystemPrompt: true,
    },
    env: process.env,
    parseCliId: parseAgentCliId,
    presetService: runtime.infraServices.presetService,
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
  const optionChips = createMissionControlOptionChips(sessionOptionsRuntime.getResolved());
  const missionControl = createMissionControlController({
    ...missionControlProfileConfig,
    defaultCliId: cliId,
    cliOptions: missionControlProfileConfig.cliOptions.map((entry) => ({
      ...entry,
      optionChips: entry.id === cliId ? optionChips : [],
    })),
    createPtyHost: (profile) => createPtyHost({ profile }),
    injectProfile: (profile, launchOptions) =>
      (launchOptions ?? sessionOptionsRuntime.getDraft()).native
        ? Promise.resolve(profile)
        : injectAgentCliProfile(profile, {
            buildSystemPrompt,
            dedicatedMcpSession: runtime.dedicatedMcpSession,
            enableMetaphor: (launchOptions ?? sessionOptionsRuntime.getDraft()).enableMetaphor,
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
    presetService: runtime.infraServices.presetService,
    readRecentLogFiles,
    release: readFleetCliRelease(),
    sessionOptions: sessionOptionsRuntime,
  });
  const jobBarState = createJobBarState({
    carrierRuntime: runtime.carrierRuntime,
    getKeyboardProtocol: () => missionControl.ptyHost.getKeyboardProtocol?.() ?? STANDARD_KEYBOARD_PROTOCOL_STATE,
    onCarrierResultReminder: (text) => sendCarrierResultReminder(sanitizeCarrierResultReminder(text)),
    onRenderRequest: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
  });
  const sections = [
    { component: new FleetStatusSection({ getNative: () => sessionOptionsRuntime.getDraft().native }), id: "fleet-status-section" },
    ...createJobBarSections(jobBarState),
  ];
  const fleetPty = createFleetPtyApi({
    defaultComponent: createDefaultFleetPtyComponent(sections),
    sections,
  }, {
    addInputListener: (listener) => ui.addInputListener(listener),
    getColumns: () => ui.columns,
    getRows: () => ptyManager?.getCurrentRequest().fleetRows ?? Math.max(0, ui.rows - missionControl.ptyView.maxRows),
    requestResize: () => ptyManager?.requestResize("fleet-overlay"),
    requestRender: scheduleRender,
  });
  ptyManager = createTuiPtyManager({
    fleetPty,
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
  let unsubscribeJobBar = () => {};
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
    jobBarState.setPendingExitWarning(false);
    stopApp(ui, missionControl.ptyHost, resize, disposeInputStream, unsubscribeJobBar, runtimeLifecycle);
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
    jobBarState.setPendingExitWarning(true);
    clearInterruptWarningTimer();
    interruptWarningTimer = setTimeout(() => {
      interruptWarningStartedAt = 0;
      interruptWarningTimer = undefined;
      jobBarState.setPendingExitWarning(false);
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
      "carrier-status": createCarrierStatusKeybindingHandler({
        carrierRuntime: runtime.carrierRuntime,
        missionControl: {
          closePanel: missionControl.closePanel,
          hasActivePanel: missionControl.hasActivePanel,
          openPanel: missionControl.openPanel,
          requestRender: scheduleRender,
        },
      }),
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
    routeFleetInput: (data) => fleetPty.dispatchInput(data),
    routeFleetMouse: (event) => fleetPty.dispatchMouse(event),
    toggleMode: toggleFleetInputMode,
    writeDedicated: (data) => missionControl.ptyHost.write(data),
  });
  syncCursorPolicy = createCursorPolicySync({
    cursorSync: true,
    fleetPty,
    getMode: router.getMode,
    hasActiveMissionControlPanel: missionControl.hasActivePanel,
    isModeToggleSuppressed: () => modeToggleSuppressed,
    ptyView: missionControl.ptyView,
    ui,
  });
  const staticCursorPolicySync = syncCursorPolicy;
  syncCursorPolicy = () => {
    if (!sessionOptionsRuntime.getDraft().cursorSync) {
      ui.setCursorAnchorTarget(undefined);
      return;
    }
    staticCursorPolicySync();
  };

  ui.setChildren([missionControl.component, createFleetPtyViewport(fleetPty)]);
  syncCursorPolicy();
  unsubscribeJobBar = subscribeJobBar({
    jobBarState,
  });
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

function createMissionControlOptionChips(resolved: ResolvedSessionOptions): string[] {
  const { sources, values } = resolved;
  const star = (source: string) => source === "arg" ? "*" : "";
  return [
    values.native ? `Native${star(sources.native)}` : `Fleet prompt${star(sources.native)}`,
    values.replaceSystemPrompt ? `Replace${star(sources.replaceSystemPrompt)}` : `Append${star(sources.replaceSystemPrompt)}`,
    values.enableMetaphor ? `Metaphor${star(sources.enableMetaphor)}` : undefined,
    values.model ? values.model : undefined,
    values.cursorSync ? undefined : `Cursor off${star(sources.cursorSync)}`,
  ].filter((chip): chip is string => chip !== undefined);
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
  ptyHost: PtyHost,
  resize: () => void,
  disposeInputStream: () => void,
  unsubscribeJobBar: () => void,
  runtimeLifecycle: FleetRuntimeLifecycle,
): void {
  process.stdout.off("resize", resize);
  process.off("SIGWINCH", resize);
  disposeInputStream();
  unsubscribeJobBar();
  process.stdout.write(KITTY_DISABLE);
  ptyHost.kill();
  ui.stop();
  const timer = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  timer.unref?.();
  runtimeLifecycle.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}
