import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getShellPopupBridge } from "../../../shell/tui/types.js";
import { buildLaunchCommand } from "@sbluemin/fleet-core";
import { buildBridgeCommand } from "./command.js";
import type { ActiveBridgeSession } from "./types.js";
import type { CliType } from "@sbluemin/unified-agent";

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

  const launchData = buildLaunchCommand({ scope: "default" });
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
  const launchData = buildLaunchCommand({ scope: "default" });
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
