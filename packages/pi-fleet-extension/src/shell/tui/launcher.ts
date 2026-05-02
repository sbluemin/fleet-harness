/**
 * core-shell — 팝업 실행기
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { PopupOverlay } from "./overlay-component.js";
import type {
  ShellPopupOptions,
  ShellPopupResult,
} from "./types.js";

let latestContext: ExtensionContext | null = null;
let activePopup: Promise<ShellPopupResult> | null = null;

export function setShellPopupContext(ctx: ExtensionContext): void {
  latestContext = ctx;
}

export async function openShellPopup(opts: ShellPopupOptions): Promise<ShellPopupResult | void> {
  const ctx = latestContext;
  if (!ctx) {
    throw new Error("No active session context found.");
  }
  if (!ctx.hasUI) {
    throw new Error("Shell popup is only available in interactive TUI mode.");
  }
  if (activePopup) {
    return;
  }

  const config = loadConfig(ctx.cwd);
  const launch = normalizeLaunchOptions(ctx, opts);

  activePopup = ctx.ui.custom<ShellPopupResult>(
    (tui, theme, _keyboard, done) =>
      new PopupOverlay(
        tui,
        theme,
        launch,
        config,
        done,
      ),
    {
      overlay: true,
      overlayOptions: {
        width: `${config.overlayWidthPercent}%`,
        maxHeight: `${Math.max(config.overlayHeightPercent, 90)}%`,
        anchor: "center",
        margin: 1,
      },
    },
  );

  try {
    return await activePopup;
  } finally {
    activePopup = null;
  }
}

export function isShellPopupOpen(): boolean {
  return activePopup !== null;
}

function normalizeLaunchOptions(
  ctx: ExtensionContext,
  opts: ShellPopupOptions,
): ShellPopupOptions {
  const command = opts.command.trim();
  if (!command) {
    throw new Error("Command string is empty.");
  }

  return {
    command,
    title: opts.title?.trim() || extractDefaultTitle(command),
    cwd: opts.cwd ?? ctx.cwd,
    env: opts.env,
  };
}

function extractDefaultTitle(command: string): string {
  const [head] = command.split(/\s+/, 1);
  return head?.trim() || command;
}
