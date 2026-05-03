/**
 * admiralty/register.ts — Admiralty 역할 facade
 *
 * 이벤트, 도구, 런타임, Status Bar/Overlay owner를 role별 모듈에 위임한다.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { getState } from "../state.js";
import { FleetRegistry } from "./fleet-registry.js";
import { registerAdmiraltyPiEvents } from "./events.js";
import { registerAdmiraltyTools } from "./tools.js";
import { getKeybindAPI } from "../../keybinds.js";
import { openAdmiraltyStatusOverlay } from "./status-overlay.js";
import {
  ensureAdmiraltyRuntime,
  readAdmiraltyRuntime,
  setAdmiraltyPresenter,
} from "./runtime.js";

export default function registerAdmiralty(pi: ExtensionAPI): void {
  const runtime = ensureAdmiraltyRuntime();
  getState().socketPath = runtime.socketPath;
  setAdmiraltyPresenter(pi);
  registerAdmiraltyStatusOverlayKeybind();
  registerAdmiraltyPiEvents(pi);
  registerAdmiraltyTools(pi);
}

export function getFleetRegistry(): FleetRegistry | null {
  return readAdmiraltyRuntime()?.registry as FleetRegistry | null;
}

let activeStatusPopup: Promise<void> | null = null;

function registerAdmiraltyStatusOverlayKeybind(): void {
  const keybind = getKeybindAPI();
  keybind.register({
    extension: "grand-fleet",
    action: "status-overlay",
    defaultKey: "alt+g",
    description: "Grand Fleet Status 오버레이",
    category: "Grand Fleet",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      if (activeStatusPopup) return;

      activeStatusPopup = openAdmiraltyStatusOverlay(ctx);

      try {
        await activeStatusPopup;
      } finally {
        activeStatusPopup = null;
      }
    },
  });
}
