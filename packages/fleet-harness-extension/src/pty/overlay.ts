// core-shell — 순수 쉘 팝업 오버레이 + 설정 + 타입
// PTY 세션을 오버레이 TUI로 렌더링하고 입력을 중계합니다.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { PtyTerminalSession } from "./shell.js";
import { encodeKeyToken } from "./key-encoding.js";

// ═══════════════════════════════════════════════════════════════════════════
// 타입
// ═══════════════════════════════════════════════════════════════════════════

/** 팝업 실행 결과 */
export interface ShellPopupResult {
  exitCode: number | null;
  signal?: number;
  cancelled: boolean;
}

/** 팝업 실행 옵션 — 명령어를 받아 PTY 팝업으로 띄움 */
export interface ShellPopupOptions {
  /** 실행할 쉘 명령어 */
  command: string;
  /** 팝업 타이틀 */
  title?: string;
  /** 작업 디렉토리 */
  cwd?: string;
  /** 자식 프로세스에 병합할 환경 변수 (process.env에 override) */
  env?: Record<string, string>;
}

export type PopupState = "interactive" | "exited";

/** shell popup 브릿지 */
export type InteractiveShellBridge = {
  open(opts: ShellPopupOptions): Promise<ShellPopupResult | void>;
  isOpen(): boolean;
};

export interface PopupConfig {
  exitAutoCloseDelay: number;
  overlayWidthPercent: number;
  overlayHeightPercent: number;
  scrollbackLines: number;
  ansiReemit: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// 상수
// ═══════════════════════════════════════════════════════════════════════════

export const HEADER_LINES = 4;
export const FOOTER_LINES = 2;

const DEFAULT_CONFIG: PopupConfig = {
  exitAutoCloseDelay: 3,
  overlayWidthPercent: 95,
  overlayHeightPercent: 60,
  scrollbackLines: 5000,
  ansiReemit: true,
};

let shellPopupBridge: InteractiveShellBridge | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// 설정 로드
// ═══════════════════════════════════════════════════════════════════════════

export function loadConfig(cwd: string): PopupConfig {
  const projectPath = join(cwd, ".pi", "core-shell.json");
  const globalPath = join(getAgentDir(), "core-shell.json");

  let globalConfig: Partial<PopupConfig> = {};
  let projectConfig: Partial<PopupConfig> = {};

  if (existsSync(globalPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalPath, "utf-8")) as Partial<PopupConfig>;
    } catch (error) {
      console.error(`[core-shell] 전역 설정 파싱 실패: ${String(error)}`);
    }
  }

  if (existsSync(projectPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectPath, "utf-8")) as Partial<PopupConfig>;
    } catch (error) {
      console.error(`[core-shell] 프로젝트 설정 파싱 실패: ${String(error)}`);
    }
  }

  const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };

  return {
    exitAutoCloseDelay: clampInt(merged.exitAutoCloseDelay, DEFAULT_CONFIG.exitAutoCloseDelay, 0, 30),
    overlayWidthPercent: clampInt(merged.overlayWidthPercent, DEFAULT_CONFIG.overlayWidthPercent, 10, 100),
    overlayHeightPercent: clampInt(merged.overlayHeightPercent, DEFAULT_CONFIG.overlayHeightPercent, 20, 90),
    scrollbackLines: clampInt(merged.scrollbackLines, DEFAULT_CONFIG.scrollbackLines, 200, 50000),
    ansiReemit: merged.ansiReemit !== false,
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ═══════════════════════════════════════════════════════════════════════════
// 브릿지
// ═══════════════════════════════════════════════════════════════════════════

export function getShellPopupBridge(): InteractiveShellBridge | null {
  return shellPopupBridge;
}

export function setShellPopupBridge(bridge: InteractiveShellBridge | null): void {
  shellPopupBridge = bridge;
}

// ═══════════════════════════════════════════════════════════════════════════
// PopupOverlay TUI 컴포넌트
// ═══════════════════════════════════════════════════════════════════════════

/** 리사이즈 단축키 한 번당 변화량 (%) */
const RESIZE_STEP = 5;
/** 최소 높이 (%) */
const MIN_HEIGHT_PERCENT = 20;
/** 최대 높이 (%) */
const MAX_HEIGHT_PERCENT = 90;

/**
 * 모듈 레벨 — 마지막으로 사용한 높이 비율을 기억합니다.
 * 팝업을 닫았다 다시 열어도 리사이즈 상태가 유지됩니다.
 * (프로세스 메모리 내에서만 유지, 디스크 영속성 없음)
 */
let lastHeightPercent: number | null = null;

export class PopupOverlay implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: ShellPopupResult) => void;
  private readonly options: ShellPopupOptions;
  private readonly config: PopupConfig;
  private readonly session: PtyTerminalSession;

  private state: PopupState = "interactive";
  private exitCountdown = 0;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private renderTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  private finished = false;

  /** 현재 오버레이 높이 비율 (%) — Ctrl+Up/Down으로 동적 변경 */
  private currentHeightPercent: number;

  constructor(
    tui: TUI,
    theme: Theme,
    options: ShellPopupOptions,
    config: PopupConfig,
    done: (result: ShellPopupResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.config = config;
    this.done = done;
    this.currentHeightPercent = Math.min(
      MAX_HEIGHT_PERCENT,
      Math.max(MIN_HEIGHT_PERCENT, lastHeightPercent ?? config.overlayHeightPercent),
    );

    const overlayWidth = Math.floor((tui.terminal.columns * this.config.overlayWidthPercent) / 100);
    const overlayHeight = Math.floor((tui.terminal.rows * this.currentHeightPercent) / 100);
    const cols = Math.max(20, overlayWidth - 4);
    const rows = Math.max(3, overlayHeight - (HEADER_LINES + FOOTER_LINES + 2));

    this.session = new PtyTerminalSession(
      {
        command: options.command,
        cwd: options.cwd,
        env: options.env,
        cols,
        rows,
        scrollback: this.config.scrollbackLines,
        ansiReemit: this.config.ansiReemit,
      },
      {
        onData: () => {
          this.debouncedRender();
        },
        onExit: () => {
          if (this.finished) return;
          this.state = "exited";
          this.exitCountdown = this.config.exitAutoCloseDelay;
          this.startExitCountdown();
          this.tui.requestRender();
        },
      },
    );
  }

  private debouncedRender(): void {
    if (this.renderTimeout) return;
    this.renderTimeout = setTimeout(() => {
      this.renderTimeout = null;
      this.tui.requestRender();
    }, 16);
  }

  private startExitCountdown(): void {
    this.stopCountdown();
    if (this.exitCountdown <= 0) {
      this.finishWithExit();
      return;
    }

    this.countdownInterval = setInterval(() => {
      this.exitCountdown -= 1;
      if (this.exitCountdown <= 0) {
        this.finishWithExit();
        return;
      }
      this.tui.requestRender();
    }, 1000);
  }

  private stopCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  private finishWithExit(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopCountdown();
    this.session.dispose();
    this.done({
      exitCode: this.session.exitCode,
      signal: this.session.signal,
      cancelled: false,
    });
  }

  private resizeOverlay(delta: number): void {
    const next = this.currentHeightPercent + delta;
    this.currentHeightPercent = Math.min(MAX_HEIGHT_PERCENT, Math.max(MIN_HEIGHT_PERCENT, next));
    lastHeightPercent = this.currentHeightPercent;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.tui.requestRender();
  }

  killSession(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopCountdown();
    this.session.kill();
    this.session.dispose();
    this.done({
      exitCode: this.session.exitCode,
      signal: this.session.signal,
      cancelled: true,
    });
  }

  handleInput(data: string): void {
    if (this.state === "exited") {
      if (data.length > 0) {
        this.finishWithExit();
      }
      return;
    }

    if (matchesKey(data, "ctrl+q")) {
      this.killSession();
      return;
    }

    if (matchesKey(data, "ctrl+shift+up")) {
      this.resizeOverlay(RESIZE_STEP);
      return;
    }

    if (matchesKey(data, "ctrl+shift+down")) {
      this.resizeOverlay(-RESIZE_STEP);
      return;
    }

    if (matchesKey(data, "shift+up")) {
      this.session.scrollUp(Math.max(1, this.session.rows - 2));
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "shift+down")) {
      this.session.scrollDown(Math.max(1, this.session.rows - 2));
      this.tui.requestRender();
      return;
    }

    this.session.write(this.translateForPty(data));
  }

  private translateForPty(data: string): string {
    const printable = decodeKittyPrintable(data);
    if (printable !== undefined) return printable;

    const keyId = parseKey(data);
    if (keyId) {
      try {
        return encodeKeyToken(keyId);
      } catch {
        // encodeKeyToken이 지원하지 않는 키 → raw data를 그대로 전달
      }
    }

    return data;
  }

  render(width: number): string[] {
    width = Math.max(4, width);

    const border = (text: string) => this.theme.fg("border", text);
    const accent = (text: string) => this.theme.fg("accent", text);
    const dim = (text: string) => this.theme.fg("dim", text);
    const warning = (text: string) => this.theme.fg("warning", text);

    const innerWidth = width - 4;
    const pad = (text: string, targetWidth: number) => {
      const visible = visibleWidth(text);
      return text + " ".repeat(Math.max(0, targetWidth - visible));
    };
    const row = (content: string) => border("│ ") + pad(content, innerWidth) + border(" │");
    const emptyRow = () => row("");

    const lines: string[] = [];
    const titleBase = (this.options.title ?? this.options.command).replace(/\s+/g, " ").trim();
    const title = truncateToWidth(titleBase, innerWidth - 18, "...");
    const pid = `PID: ${this.session.pid}`;

    lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
    lines.push(
      row(
        accent(title) +
          " ".repeat(Math.max(1, innerWidth - visibleWidth(title) - pid.length)) +
          dim(pid),
      ),
    );
    lines.push(row(dim("Native popup · Direct input")));
    lines.push(border("├" + "─".repeat(width - 2) + "┤"));

    const overlayHeight = Math.floor((this.tui.terminal.rows * this.currentHeightPercent) / 100);
    const chrome = HEADER_LINES + FOOTER_LINES + 2;
    const termRows = Math.max(3, overlayHeight - chrome);

    if (innerWidth !== this.lastWidth || termRows !== this.lastHeight) {
      this.session.resize(innerWidth, termRows);
      this.lastWidth = innerWidth;
      this.lastHeight = termRows;
      this.session.scrollToBottom();
    }

    const viewportLines = this.session.getViewportLines({ ansi: this.config.ansiReemit });
    for (const line of viewportLines) {
      lines.push(row(truncateToWidth(line, innerWidth, "")));
    }

    if (this.session.isScrolledUp()) {
      const hintText = "── ↑ scrolled (Shift+Down) ──";
      const padLen = Math.max(0, Math.floor((width - 2 - visibleWidth(hintText)) / 2));
      lines.push(
        border("├") +
          dim(
            " ".repeat(padLen) +
              hintText +
              " ".repeat(width - 2 - padLen - visibleWidth(hintText)),
          ) +
          border("┤"),
      );
    } else {
      lines.push(border("├" + "─".repeat(width - 2) + "┤"));
    }

    const footerLines: string[] = [];
    if (this.state === "exited") {
      const exitMessage = this.session.exitCode === 0
        ? this.theme.fg("success", "✓ Exited normally")
        : warning(`✗ Exit code ${this.session.exitCode}`);
      footerLines.push(row(exitMessage));
      footerLines.push(row(dim(`Auto-close in ${this.exitCountdown}s · Press any key to dismiss`)));
    } else {
      footerLines.push(row(dim("Ctrl+Q quit · Shift+Up/Down scroll · Ctrl+Shift+Up/Down resize")));
      footerLines.push(row(dim("Ctrl+C / Ctrl+D / Arrow keys are passed directly to the shell")));
    }

    while (footerLines.length < FOOTER_LINES) {
      footerLines.push(emptyRow());
    }
    lines.push(...footerLines);
    lines.push(border("╰" + "─".repeat(width - 2) + "╯"));

    return lines;
  }

  invalidate(): void {
    this.lastWidth = 0;
    this.lastHeight = 0;
  }

  destroy(): void {
    this.dispose();
  }

  dispose(): void {
    this.stopCountdown();
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    if (!this.finished) {
      this.session.kill();
      this.session.dispose();
      this.finished = true;
    }
  }
}
