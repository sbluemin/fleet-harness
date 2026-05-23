import { attachInputStream, LocalTui } from "@sbluemin/fleet-tui/core";
import {
  assertInputContract,
  createInputKeybindingConfig,
  createInputRouter,
  createKeybindingRegistry,
  createProgrammaticInput,
  encodeSgrMouseInput,
  type InputKeybindingConfig,
  type KeybindingDefinition,
  type KeybindingRegistration,
  type RoutedMouseInput,
} from "@sbluemin/fleet-tui/input";
import {
  createCsiUInputNormalizer,
  createFleetPtyApi,
  createPtyHost,
  createTuiPtyManager,
  KITTY_DISABLE,
  KITTY_ENABLE,
  PtyView,
  type Component,
  type FleetPtyApi,
  type PtyHost,
  type TuiPtyManager,
} from "@sbluemin/fleet-tui/pty";
import { sanitizeCarrierResultReminder, subscribeJobBar } from "./carrier-status/job-bar-register.js";
import { createJobBarState } from "./carrier-status/job-bar-state.js";
import { createCarrierStatusKeybindingHandler } from "./carrier-status/register.js";
import { toggleFleetInputMode } from "./controls/modes.js";
import { injectDedicatedCliProfile } from "./dedicated-cli/injection.js";
import { resolveDedicatedCliProfile } from "./dedicated-cli/registry.js";
import { createDefaultFleetPtyComponent, createDefaultFleetPtySections } from "./sections/default-sections.js";
import { createSystemPromptBuilder } from "./admiral/prompts.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "./runtime/runtime.js";

export interface RunAppOptions {
  readonly cliId?: string;
  readonly cursorSync?: boolean;
  readonly model?: string;
  readonly native?: boolean;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
}

type FleetInputMode = "MIRROR" | "DEDICATED";
type RenderCallback = () => void;
type RenderScheduler = (afterRender?: RenderCallback) => void;
type FleetHostKeybindingHandlers = Record<string, () => void>;

interface RenderSchedulerUi {
  requestRender(force?: boolean, afterRender?: RenderCallback): void;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const RENDER_THROTTLE_MS = 16;

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
const STANDARD_MOUSE_PROTOCOL_STATE = {
  activeEncoding: "default" as const,
  activeProtocol: "none" as const,
  mouseTrackingEnabled: false,
};
const WHEEL_SCROLL_LINES = 3;

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
  const ptyView = new PtyView(ui.columns, 0);
  let ptyManager: TuiPtyManager | undefined;
  let modeToggleSuppressed = false;
  let syncCursorPolicy = () => {};
  let sendCarrierResultReminder = (_text: string) => {};
  const scheduleRender = createRenderScheduler(ui, () => syncCursorPolicy());
  const baseProfile = await resolveDedicatedCliProfile(process.env, resolveInvocationCwd(), { cliId, model });
  const currentProfile = native
    ? baseProfile
    : await injectDedicatedCliProfile(baseProfile, {
        buildSystemPrompt: createSystemPromptBuilder({
          carrierRuntime: runtime.carrierRuntime,
          mcpRegistry: runtime.mcpRegistry,
        }).build,
        dedicatedMcpSession: runtime.dedicatedMcpSession,
        replaceSystemPrompt,
        enableMetaphor,
      });
  const ptyHost = createPtyHost({
    profile: currentProfile,
  });
  const jobBarState = createJobBarState({
    carrierRuntime: runtime.carrierRuntime,
    getKeyboardProtocol: () => ptyHost.getKeyboardProtocol?.() ?? STANDARD_KEYBOARD_PROTOCOL_STATE,
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
    getRows: () => ptyManager?.getCurrentRequest().fleetRows ?? Math.max(0, ui.rows - ptyView.maxRows),
    requestResize: () => ptyManager?.requestResize("fleet-overlay"),
    requestRender: scheduleRender,
  });
  ptyManager = createTuiPtyManager({
    fleetPty,
    ptyHost,
    ptyView,
    refreshSize: (size) => ui.refreshSize(size),
    requestRender: scheduleRender,
  });
  const programmaticInput = createProgrammaticInput(ptyHost, currentProfile);
  sendCarrierResultReminder = (text) => programmaticInput.sendMessage(text);
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
    stopApp(ui, ptyHost, resize, disposeInputStream, unsubscribeJobBar, runtimeLifecycle);
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
      "carrier-status": createCarrierStatusKeybindingHandler({ carrierRuntime: runtime.carrierRuntime, fleetPty }),
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
        dedicatedRows: ptyView.maxRows,
        fleetRows: Math.max(0, ui.rows - ptyView.maxRows),
        totalRows: ui.rows,
      },
    initialMode: "MIRROR",
    keybindings,
    onExit: stop,
    onModeChange: handleModeToggleCursorSuppression,
    routeDedicatedMouse: createDedicatedMouseRouter({
      ptyHost,
      ptyView,
      requestRender: scheduleRender,
    }),
    routeFleetInput: (data) => fleetPty.dispatchInput(data),
    routeFleetMouse: (event) => fleetPty.dispatchMouse(event),
    toggleMode: toggleFleetInputMode,
    writeDedicated: (data) => ptyHost.write(data),
  });
  syncCursorPolicy = createCursorPolicySync({
    cursorSync,
    fleetPty,
    getMode: router.getMode,
    isModeToggleSuppressed: () => modeToggleSuppressed,
    ptyView,
    ui,
  });

  ui.setChildren([ptyView, createFleetPtyViewport(fleetPty)]);
  syncCursorPolicy();
  unsubscribeJobBar = subscribeJobBar({
    jobBarState,
  });
  assertInputContract(keybindings);
  const initialResize = ptyManager.requestResize("initial");
  ui.addInputListener((data) => router.route(csiUNormalizer.normalize(data)));
  ptyHost.start({ cols: ui.columns, rows: initialResize.dedicatedRows });
  ptyHost.onData((chunk) => {
    ptyView.append(chunk, scheduleRender);
  });

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

export function createRenderScheduler(ui: RenderSchedulerUi, beforeRender: () => void): RenderScheduler {
  let renderPending = false;
  let afterRenderCallbacks: RenderCallback[] = [];
  return (afterRender?: RenderCallback) => {
    if (afterRender !== undefined) {
      afterRenderCallbacks.push(afterRender);
    }

    if (renderPending) {
      return;
    }

    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const callbacks = afterRenderCallbacks;
      afterRenderCallbacks = [];
      beforeRender();
      ui.requestRender(false, () => {
        for (const callback of callbacks) {
          callback();
        }
      });
    }, RENDER_THROTTLE_MS);
  };
}

export function createDedicatedMouseRouter(options: {
  readonly ptyHost: Pick<PtyHost, "getMouseProtocol" | "write">;
  readonly ptyView: Pick<PtyView, "isAlternateBufferActive" | "scrollLines">;
  readonly requestRender: () => void;
}): (event: RoutedMouseInput) => boolean {
  return (event) => {
    const mouseProtocol = options.ptyHost.getMouseProtocol?.() ?? STANDARD_MOUSE_PROTOCOL_STATE;
    if (mouseProtocol.mouseTrackingEnabled) {
      options.ptyHost.write(encodeSgrMouseInput(event, { column: event.localColumn, row: event.localRow }));
      return true;
    }

    if (event.wheelDirection === null) {
      return true;
    }

    if (options.ptyView.isAlternateBufferActive()) {
      options.ptyHost.write(event.wheelDirection === "up" ? "\x1b[A" : "\x1b[B");
      return true;
    }

    const delta = event.wheelDirection === "up" ? -WHEEL_SCROLL_LINES : WHEEL_SCROLL_LINES;
    if (options.ptyView.scrollLines(delta)) {
      options.requestRender();
    }
    return true;
  };
}

function createFleetPtyViewport(fleetPty: FleetPtyApi): Component {
  return {
    handleInput(data: string): void {
      fleetPty.dispatchInput(data);
    },
    invalidate(): void {
      fleetPty.getCurrentRegion().component.invalidate();
    },
    render(width: number): string[] {
      return fleetPty.getCurrentRegion().component.render(width);
    },
  };
}

function resolveInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd();
}

function createCursorPolicySync(options: {
  readonly cursorSync: boolean;
  readonly fleetPty: FleetPtyApi;
  readonly getMode: () => FleetInputMode;
  readonly isModeToggleSuppressed: () => boolean;
  readonly ptyView: PtyView;
  readonly ui: LocalTui;
}): () => void {
  return () => {
    if (!options.cursorSync || options.isModeToggleSuppressed() || options.fleetPty.hasActiveOverlay()) {
      options.ui.setCursorAnchorTarget(undefined);
      return;
    }

    const mode = options.getMode();
    options.ui.setCursorAnchorTarget(mode === "MIRROR" || mode === "DEDICATED" ? options.ptyView : undefined);
  };
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
