// core-shell — 순수 쉘 팝업 오버레이
// PTY 세션을 오버레이 TUI로 렌더링하고 입력을 중계합니다.

import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { PopupConfig } from "./config.js";
import { PtyTerminalSession } from "./pty-session.js";
import { encodeKeyToken } from "./key-encoding.js";
import {
  FOOTER_LINES,
  HEADER_LINES,
  type ShellPopupOptions,
  type ShellPopupResult,
  type PopupState,
} from "./types.js";

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

  /**
   * 오버레이 높이를 delta(%)만큼 조절합니다.
   * 상/하가 균등하게 확장/축소됩니다 (anchor: center).
   */
  private resizeOverlay(delta: number): void {
    const next = this.currentHeightPercent + delta;
    this.currentHeightPercent = Math.min(MAX_HEIGHT_PERCENT, Math.max(MIN_HEIGHT_PERCENT, next));
    // 모듈 레벨에 기억 — 다음 팝업에도 적용
    lastHeightPercent = this.currentHeightPercent;
    // 크기 변경 시 강제 리렌더 (lastWidth/lastHeight 리셋으로 resize 트리거)
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

    // 팝업 리사이즈: Ctrl+Shift+Up (확대), Ctrl+Shift+Down (축소)
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

    // PTY에 입력 전달 — Kitty CSI u 시퀀스를 레거시 시퀀스로 변환
    this.session.write(this.translateForPty(data));
  }

  /**
   * Pi TUI (Kitty keyboard protocol) 에서 받은 입력을 PTY가 이해하는
   * 레거시 터미널 시퀀스로 변환합니다.
   *
   * Kitty 프로토콜 활성 시 방향키 등이 CSI u 형식으로 들어오는데,
   * PTY 안의 프로그램(bash, claude 등)은 레거시 형식만 이해합니다.
   */
  private translateForPty(data: string): string {
    // 1. Kitty CSI u 인코딩된 일반 문자 (예: 'a', 'A', '1' 등)
    const printable = decodeKittyPrintable(data);
    if (printable !== undefined) return printable;

    // 2. parseKey로 키 이름 파악 후 encodeKeyToken으로 레거시 시퀀스 생성
    const keyId = parseKey(data);
    if (keyId) {
      try {
        return encodeKeyToken(keyId);
      } catch {
        // encodeKeyToken이 지원하지 않는 키 → raw data를 그대로 전달
      }
    }

    // 3. 이미 레거시 시퀀스이거나 일반 텍스트 → 그대로 전달
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
