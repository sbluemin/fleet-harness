// core-shell -- 네이티브 터미널 핸드오프 기반 쉘 팝업 실행기

import { spawnSync } from "node:child_process";
import { getShellConfig } from "@sbluemin/fleet-coding-agent";
import type { ExtensionContext } from "@sbluemin/fleet-coding-agent";

// ═══════════════════════════════════════════════════════════════════════════
// 타입
// ═══════════════════════════════════════════════════════════════════════════

export interface ShellPopupOptions {
  command: string;
  title?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ShellPopupResult {
  exitCode: number | null;
  signal?: NodeJS.Signals;
  cancelled: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// 모듈 상태
// ═══════════════════════════════════════════════════════════════════════════

let latestContext: ExtensionContext | null = null;
let activePopup: Promise<ShellPopupResult> | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// 공개 함수
// ═══════════════════════════════════════════════════════════════════════════

export function setShellPopupContext(ctx: ExtensionContext): void {
  latestContext = ctx;
}

export function isShellPopupOpen(): boolean {
  return activePopup !== null;
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

  const launch = normalizeLaunchOptions(ctx, opts);

  activePopup = ctx.ui.custom<ShellPopupResult>((tui, _theme, _kb, done) => {
    tui.stop();

    process.stdout.write("\x1b[2J\x1b[H");

    const { shell, args } = getShellConfig();
    const result = spawnSync(shell, [...args, launch.command], {
      stdio: "inherit",
      cwd: launch.cwd,
      env: launch.env ? { ...process.env, ...launch.env } : undefined,
    });

    tui.start();
    tui.requestRender(true);

    if (result.error) {
      throw result.error;
    }

    const signal = result.signal ?? undefined;
    const cancelled = signal === "SIGINT" || signal === "SIGTERM";

    done({
      exitCode: result.status,
      signal,
      cancelled,
    });

    return { render: () => [], invalidate: () => {} };
  });

  try {
    return await activePopup;
  } finally {
    activePopup = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 내부 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function normalizeLaunchOptions(ctx: ExtensionContext, opts: ShellPopupOptions): ShellPopupOptions {
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
