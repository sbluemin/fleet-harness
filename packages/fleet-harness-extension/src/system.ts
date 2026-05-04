import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { toggleProviderGuardForCommand } from "./provider.js";
import { getGuardState } from "./provider.js";
import { createFleetUpdatePrompt, FLEET_ROOT } from "./welcome.js";

export function registerSystemSettingsCommand(ctx: ExtensionAPI): void {
  ctx.registerCommand("fleet:system:settings", {
    description: "시스템 설정 (Provider Guard, 업데이트)",
    handler: async (_args, commandCtx) => {
      const guardEnabled = getGuardState().enabled;
      const options = [
        `Provider Guard: ${guardEnabled ? "ON" : "OFF"}`,
        "fleet-harness 업데이트 실행",
      ];

      const choice = await commandCtx.ui.select("시스템 설정:", options);
      if (choice === undefined) return;

      if (choice.startsWith("Provider Guard")) {
        toggleProviderGuardForCommand(ctx, commandCtx);
      } else if (choice.startsWith("fleet-harness")) {
        ctx.sendUserMessage(createFleetUpdatePrompt(FLEET_ROOT));
        commandCtx.ui.notify("fleet-harness 업데이트 작업을 AI에게 전달했습니다.", "info");
      }
    },
  });
}
