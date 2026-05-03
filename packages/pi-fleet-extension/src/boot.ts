import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import registerBoot from "./fleet.js";
import registerFleetWiki from "./wiki/ui.js";
import registerGrandFleet from "./grand-fleet/index.js";
import { registerJob } from "./jobs.js";
import { registerProviderGuardCommand } from "./provider.js";
import { syncModelConfig } from "./panel/config.js";
import { bootBridge } from "./bridge/handler.js";
import { registerFleetPiCommands } from "./fleet.js";
import {
  getFleetRuntime,
  bootstrapFleetState,
  initializeFleetRuntime,
  resolveFleetDataDir,
  shouldBootFleet,
  wireFleetPiEvents,
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
import { createHudEditorState, registerHudLifecycle, registerHudCommand } from "./hud/state.js";
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
  registerHudLifecycle(ctx, hudState);
  registerShellLifecycle(ctx);
  registerCoreKeybinds(ctx);
  registerWelcome(ctx);
  registerHudCommand(ctx, hudState);

  registerAgentPanelShortcut();
  registerCarrierStatusKeybind(ctx);
  bindPanelBackgroundJobAnimation();

  const fleetServices = getFleetRuntime().fleet;
  initStreamEventHandler();
  registerProviderRuntime(ctx, fleetServices, streamAcp);
  registerFleet(ctx, fleetEnabled);
  registerGrandFleet(ctx);
  registerFleetWiki(ctx as any);
  registerMetaphorDomain(ctx, fleetEnabled);
  if (fleetEnabled) registerJob(ctx);
  registerSettings(ctx);
  registerLog(ctx, fleetEnabled);
  registerToolRegistry(ctx, fleetEnabled);
  registerProviderGuardCommand(ctx);
}

function registerStreamingHandler(pi: ExtensionAPI): void {
  unregisterStreamingHandler?.();
  bindCarrierJobStreamPi(pi);
  unregisterStreamingHandler = getFleetRuntime().jobs.streaming.register(handleCarrierJobStreamEvent);
  pi.on("session_shutdown", () => {
    unregisterStreamingHandler?.();
    unregisterStreamingHandler = null;
    bindCarrierJobStreamPi(null);
  });
}

function registerFleet(pi: ExtensionAPI, fleetEnabled: boolean): void {
  if (!fleetEnabled) return;

  bootstrapFleetState(pi);
  syncModelConfig();
  wireFleetPiEvents(pi);
  bootBridge(pi);
  registerFleetPiCommands(pi);
}

function registerMetaphorDomain(pi: ExtensionAPI, fleetEnabled: boolean): void {
  if (!fleetEnabled) return;
  registerMetaphor(pi);
}

function registerLog(pi: ExtensionAPI, fleetEnabled: boolean): void {
  if (!fleetEnabled) return;
  registerLogDomain(pi);
}
