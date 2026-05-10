import type { ExtensionAPI } from "@sbluemin/fleet-coding-agent";

import registerBoot from "./fleet.js";
import registerFleetWiki from "./wiki/ui.js";
import { registerJob } from "./jobs.js";
import { registerSystemSettingsCommand } from "./system.js";
import {
  getFleetRuntime,
  initializeFleetRuntime,
  registerFleetLifecycle,
  resolveFleetDataDir,
  shouldBootFleet,
} from "./fleet.js";
import { initStreamEventHandler, registerProviderRuntime, streamAcp } from "./provider.js";
import { registerAgentPanelShortcut, bindPanelBackgroundJobAnimation } from "./panel/ui.js";
import { registerCarrierStatusKeybind } from "./carrier-status/overlay.js";
import { bindCarrierJobStreamPi, handleCarrierJobStreamEvent } from "./streaming.js";
import { registerLog as registerLogDomain } from "./logs.js";
import { registerMetaphor } from "./metaphor.js";
import { registerSettings } from "./settings.js";
import { registerToolRegistry } from "./tools.js";
import { prepareKeybindBridgeForExtensionLoad } from "./keybinds.js";
import { createHudEditorState, registerHudLifecycle } from "./hud/state.js";
import registerCoreKeybinds, { reregisterCoreKeybinds } from "./keybinds.js";
import registerShellLifecycle from "./pty/register.js";
import registerWelcome from "./welcome.js";

let unregisterStreamingHandler: (() => void) | null = null;

export function bootFleet(ctx: ExtensionAPI): void {
  registerBoot(ctx);
  const fleetEnabled = shouldBootFleet();

  if (fleetEnabled) {
    initializeFleetRuntime(resolveFleetDataDir());
    registerStreamingHandler(ctx);
  }

  const hudState = createHudEditorState();

  prepareKeybindBridgeForExtensionLoad();
  ctx.on("session_start", (event) => {
    if (event.reason === "startup") return;
    reregisterCoreKeybinds(ctx);
  });
  // fleet 첫 진입 시 이전 셸 출력과 scrollback을 비워 깨끗한 첫 화면을 보장한다.
  ctx.on("session_start", (event, sessionCtx) => {
    if (event.reason === "resume" || event.reason === "new") return;
    if (!sessionCtx.hasUI) return;
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  });
  registerHudLifecycle(ctx, hudState);
  registerShellLifecycle(ctx);
  registerCoreKeybinds(ctx);
  registerWelcome(ctx);

  registerAgentPanelShortcut();
  registerCarrierStatusKeybind(ctx);
  bindPanelBackgroundJobAnimation();

  const fleetServices = getFleetRuntime().admiral;
  initStreamEventHandler();
  registerProviderRuntime(ctx, fleetServices, streamAcp);
  const { fleetEnabled: activeFleet } = registerFleetLifecycle(ctx);
  registerFleetWiki(ctx as any);
  registerMetaphorDomain(ctx, activeFleet);
  if (activeFleet) registerJob(ctx);
  registerSettings(ctx);
  registerLog(ctx, activeFleet);
  registerToolRegistry(ctx, activeFleet);
  registerSystemSettingsCommand(ctx);
}

function registerStreamingHandler(pi: ExtensionAPI): void {
  unregisterStreamingHandler?.();
  bindCarrierJobStreamPi(pi);
  unregisterStreamingHandler = getFleetRuntime().admiral.carrierJobs.streaming.register(handleCarrierJobStreamEvent);
  pi.on("session_shutdown", () => {
    unregisterStreamingHandler?.();
    unregisterStreamingHandler = null;
    bindCarrierJobStreamPi(null);
  });
}

function registerMetaphorDomain(pi: ExtensionAPI, fleetEnabled: boolean): void {
  if (!fleetEnabled) return;
  registerMetaphor(pi);
}

function registerLog(pi: ExtensionAPI, fleetEnabled: boolean): void {
  if (!fleetEnabled) return;
  registerLogDomain(pi);
}
