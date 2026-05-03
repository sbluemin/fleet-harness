import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getShellPopupBridge } from "../pty/overlay.js";
import { admiral } from "@sbluemin/fleet-core";
import { buildBridgeCommand } from "./command.js";
import {
  BRIDGE_ACTION_ID,
  BRIDGE_COMMAND_ID,
  BRIDGE_DEFAULT_KEY,
  BRIDGE_EXTENSION_ID,
  BRIDGE_KEYBIND_CATEGORY,
} from "./types.js";
import type { ActiveBridgeSession } from "./types.js";
import type { CliType } from "@sbluemin/unified-agent";
import { getKeybindAPI } from "../keybinds.js";

export async function launchBridgeShell(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("Bridge popup is only available in interactive TUI mode.");
  }

  const shellBridge = getShellPopupBridge();
  if (!shellBridge) {
    throw new Error("Interactive shell bridge is not available.");
  }
  if (shellBridge.isOpen()) {
    ctx.ui.notify("브릿지 쉘이 이미 열려 있습니다.", "warning");
    return;
  }

  const launchData = admiral.agent.bridge.buildLaunchCommand({ scope: "default" });
  if (!launchData) {
    throw new Error("기본 bridge scope에 활성 ACP 세션이 없습니다.");
  }

  const command = buildBridgeCommand({
    cli: launchData.cli as CliType,
    model: launchData.backendModel,
    sessionId: launchData.sessionId,
    cwd: launchData.cwd,
    effort: launchData.effort,
  });

  await shellBridge.open({ ...command, env: launchData.env });
}

export function getActiveBridgeSession(): ActiveBridgeSession {
  const launchData = admiral.agent.bridge.buildLaunchCommand({ scope: "default" });
  if (!launchData) {
    throw new Error("기본 bridge scope에 활성 ACP 세션이 없습니다.");
  }

  return {
    cli: launchData.cli as CliType,
    model: launchData.backendModel,
    sessionId: launchData.sessionId,
    cwd: launchData.cwd,
    effort: launchData.effort,
  };
}

export function bootBridge(pi: ExtensionAPI): void {
  registerBridgeCommand(pi);
  ensureBridgeKeybinds();
}

export function ensureBridgeKeybinds(): void {
  registerBridgeKeybind();
}

function registerBridgeCommand(pi: ExtensionAPI): void {
  pi.registerCommand(BRIDGE_COMMAND_ID, {
    description: "활성 ACP Model Provider를 오버레이 쉘로 실행",
    handler: async (_args, ctx) => {
      await launchBridgeShell(ctx);
    },
  });
}

function registerBridgeKeybind(): void {
  const keybind = getKeybindAPI();
  keybind.register({
    extension: BRIDGE_EXTENSION_ID,
    action: BRIDGE_ACTION_ID,
    defaultKey: BRIDGE_DEFAULT_KEY,
    description: "활성 ACP Model Provider bridge 실행",
    category: BRIDGE_KEYBIND_CATEGORY,
    handler: async (ctx) => {
      await launchBridgeShell(ctx);
    },
  });
}
