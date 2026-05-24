import { attachInputStream, LocalTui } from "@dotobokuri/fleet-tui/core";
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
import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";

import { sanitizeCarrierResultReminder, subscribeJobBar } from "./carrier-status/job-bar-register.js";
import { createJobBarState } from "./carrier-status/job-bar-state.js";
import { createCarrierStatusKeybindingHandler } from "./carrier-status/register.js";
import { injectDedicatedCliProfile } from "./agent-cli/injection.js";
import { getDedicatedCliMetadata, resolveDedicatedCliId, resolveDedicatedCliProfile } from "./agent-cli/registry.js";
import { createMissionControlController } from "./mission-control/controller.js";
import type { CreateMissionControlControllerOptions } from "./mission-control/types.js";
import { createDefaultFleetPtyComponent, createDefaultFleetPtySections } from "./sections/default-sections.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "./runtime/runtime.js";

export interface RunAppOptions {
  readonly cliId?: string;
  readonly cursorSync?: boolean;
  readonly model?: string;
  readonly native?: boolean;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
}

type FleetHostKeybindingHandlers = Record<string, () => void>;
type MissionControlProfileConfig = Pick<CreateMissionControlControllerOptions, "cliOptions" | "defaultCliId" | "resolveProfile">;

export interface CreateMissionControlProfileConfigOptions {
  readonly cliId?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly invocationCwd: string;
  readonly model?: string;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
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
    cliOptions: getDedicatedCliMetadata(),
    defaultCliId: resolveDedicatedCliId(options.env, { cliId: options.cliId }),
    resolveProfile: (selectedCliId) =>
      resolveDedicatedCliProfile(options.env, options.invocationCwd, { cliId: selectedCliId, model: options.model }),
  };
}

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const cliId = options.cliId;
  const cursorSync = options.cursorSync !== false;
  const model = options.model;
  const native = options.native ?? false;
  const replaceSystemPrompt = options.replaceSystemPrompt ?? false;
  const enableMetaphor = options.enableMetaphor ?? false;
  const runtimeLifecycle = createFleetRuntimeLifecycle();
  const runtime = await runtimeLifecycle.start();
  const ui = new LocalTui({ cursorSyncEnabled: cursorSync });
  let ptyManager: TuiPtyManager | undefined;
  let modeToggleSuppressed = false;
  let syncCursorPolicy = () => {};
  let sendCarrierResultReminder = (_text: string) => {};
  const scheduleRender = createRenderScheduler(ui, () => syncCursorPolicy());
  const buildSystemPrompt = createSystemPromptBuilder({
    carrierRuntime: runtime.carrierRuntime,
    mcpRegistry: runtime.mcpRegistry,
  }).build;
  const missionControlProfileConfig = createMissionControlProfileConfig({
    cliId,
    env: process.env,
    invocationCwd: resolveInvocationCwd(),
    model,
  });
  const missionControl = createMissionControlController({
    ...missionControlProfileConfig,
    createPtyHost: (profile) => createPtyHost({ profile }),
    injectProfile: (profile) =>
      native
        ? Promise.resolve(profile)
        : injectDedicatedCliProfile(profile, {
            buildSystemPrompt,
            dedicatedMcpSession: runtime.dedicatedMcpSession,
            enableMetaphor,
            replaceSystemPrompt,
          }),
    onExitFleet: () => stop(),
    onRenderRequest: () => {
      ptyManager?.requestResize("programmatic");
      scheduleRender();
    },
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
  const sections = createDefaultFleetPtySections({ jobBarState, native });
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
  const resize = () => ptyManager?.requestResize("terminal-resize");
  const stop = () => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    stopApp(ui, missionControl.ptyHost, resize, disposeInputStream, unsubscribeJobBar, runtimeLifecycle);
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
      "host-interrupt": stop,
      "mode-toggle": handleModeToggleCursorSuppression,
    },
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
    cursorSync,
    fleetPty,
    getMode: router.getMode,
    hasActiveMissionControlPanel: missionControl.hasActivePanel,
    isModeToggleSuppressed: () => modeToggleSuppressed,
    ptyView: missionControl.ptyView,
    ui,
  });

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
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const disableKeyboardProtocol = () => process.stdout.write(KITTY_DISABLE);
  process.on("exit", disableKeyboardProtocol);

  ui.start();
  process.stdout.write(KITTY_ENABLE);
  disposeInputStream = attachInputStream(ui);
}

export function createFleetHostInputKeybindingConfig(options: {
  readonly definitions: readonly KeybindingDefinition[];
  readonly handlers: FleetHostKeybindingHandlers;
}): InputKeybindingConfig {
  const exitKeys = options.definitions
    .filter((definition) => definition.action === "host-exit" || definition.action === "host-interrupt")
    .map((definition) => definition.key);
  const modeToggleKeys = options.definitions
    .filter((definition) => definition.action === "mode-toggle")
    .map((definition) => definition.key);
  const registeredKeybindings = options.definitions
    .filter((definition) => definition.action !== "host-exit" && definition.action !== "host-interrupt" && definition.action !== "mode-toggle")
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
