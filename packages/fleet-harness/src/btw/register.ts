import type { ExtensionAPI, ExtensionContext } from "@sbluemin/fleet-coding-agent";

import { BtwOverlay } from "./overlay.js";

let activeBtwPopup: Promise<void> | null = null;

export function registerBtwCommand(pi: ExtensionAPI): void {
  pi.registerCommand("fleet:admiral:btw", {
    description: "일회성 멀티턴 질의 오버레이",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (activeBtwPopup) return;

      activeBtwPopup = ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new BtwOverlay(tui, theme, ctx, done),
        {
          overlay: false,
        },
      );

      try {
        await activeBtwPopup;
      } finally {
        activeBtwPopup = null;
      }
    },
  });
}
