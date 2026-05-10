import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@sbluemin/fleet-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FLEET_ROOT = join(__dirname, "..", "..", "..");

export function createFleetUpdatePrompt(fleetRoot: string): string {
  return [
    "Please update the fleet-harness repository.",
    "",
    `1. Move to the local repository at the absolute path \`${fleetRoot}\`.`,
    "2. Identify the current active branch and synchronize it with the remote latest state. Run fetch followed by pull as needed.",
    "3. Follow the update procedure described in the repository root `SETUP.md`. Do not skip any step it specifies (dependency installation, link refresh, build, verification, etc.).",
    "4. Report the actions taken and verification results concisely.",
  ].join("\n");
}

export function registerSystemSettingsCommand(ctx: ExtensionAPI): void {
  ctx.registerCommand("fleet:system:settings", {
    description: "시스템 설정 (업데이트)",
    handler: async (_args, commandCtx) => {
      const choice = await commandCtx.ui.select("시스템 설정:", ["fleet-harness 업데이트 실행"]);
      if (choice === undefined) return;

      if (choice.startsWith("fleet-harness")) {
        ctx.sendUserMessage(createFleetUpdatePrompt(FLEET_ROOT));
        commandCtx.ui.notify("fleet-harness 업데이트 작업을 AI에게 전달했습니다.", "info");
      }
    },
  });
}
