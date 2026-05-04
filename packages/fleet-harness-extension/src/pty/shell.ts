// core-shell — PTY 세션 런타임 + 팝업 실행기
// 프로세스 실행, 출력 버퍼링, 뷰포트 렌더링, 팝업 런처를 담당합니다.

import * as pty from "node-pty";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./overlay.js";
import { PopupOverlay } from "./overlay.js";
import type {
  ShellPopupOptions,
  ShellPopupResult,
} from "./overlay.js";

type DsrSegment = { text: string; dsrAfter: boolean };

type CellStyle = {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  fgMode: "default" | "palette" | "rgb";
  fg: number;
  bgMode: "default" | "palette" | "rgb";
  bg: number;
};

export interface PtySessionOptions {
  command: string;
  shell?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  scrollback?: number;
  ansiReemit?: boolean;
}

export interface PtySessionEvents {
  onData?: (data: string) => void;
  onExit?: (exitCode: number, signal?: number) => void;
}

const Terminal = xterm.Terminal;
const MAX_RAW_OUTPUT_SIZE = 1024 * 1024;
const DSR_PATTERN = /\x1b\[\??6n/g;
const OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const APC_REGEX = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ESC_SINGLE_REGEX = /\x1b[@-_]/g;
const CONTROL_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;

const require = createRequire(import.meta.url);
let spawnHelperChecked = false;

let latestContext: ExtensionContext | null = null;
let activePopup: Promise<ShellPopupResult> | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// spawn-helper
// ═══════════════════════════════════════════════════════════════════════════

function ensureSpawnHelperExec(): void {
  if (spawnHelperChecked) return;
  spawnHelperChecked = true;
  if (process.platform !== "darwin") return;

  let pkgPath: string;
  try {
    pkgPath = require.resolve("node-pty/package.json");
  } catch {
    return;
  }

  const base = dirname(pkgPath);
  const targets = [
    join(base, "prebuilds", "darwin-arm64", "spawn-helper"),
    join(base, "prebuilds", "darwin-x64", "spawn-helper"),
  ];

  for (const target of targets) {
    try {
      const stats = statSync(target);
      const mode = stats.mode | 0o111;
      if ((stats.mode & 0o111) !== 0o111) {
        chmodSync(target, mode);
      }
    } catch {
      continue;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WriteQueue
// ═══════════════════════════════════════════════════════════════════════════

class WriteQueue {
  private queue = Promise.resolve();

  enqueue(fn: () => Promise<void> | void): void {
    this.queue = this.queue.then(() => fn()).catch((error) => {
      console.error("[core-shell] WriteQueue 오류:", error);
    });
  }

  async drain(): Promise<void> {
    await this.queue;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PtyTerminalSession
// ═══════════════════════════════════════════════════════════════════════════

export class PtyTerminalSession {
  private readonly ptyProcess: pty.IPty;
  private readonly xterm: XtermTerminal;
  private serializer: SerializeAddon | null = null;
  private _exited = false;
  private _exitCode: number | null = null;
  private _signal: number | undefined;
  private scrollOffset = 0;
  private followBottom = true;
  private rawOutput = "";
  private lastStreamPosition = 0;
  private readonly writeQueue = new WriteQueue();
  private dataHandler: ((data: string) => void) | undefined;
  private exitHandler: ((exitCode: number, signal?: number) => void) | undefined;

  constructor(options: PtySessionOptions, events: PtySessionEvents = {}) {
    const {
      command,
      cwd = process.cwd(),
      env,
      cols = 80,
      rows = 24,
      scrollback = 5000,
      ansiReemit = true,
    } = options;

    this.dataHandler = events.onData;
    this.exitHandler = events.onExit;

    this.xterm = new Terminal({ cols, rows, scrollback, allowProposedApi: true, convertEol: true });
    if (ansiReemit) {
      this.serializer = new SerializeAddon();
      this.xterm.loadAddon(this.serializer);
    }

    const shell = options.shell ?? (process.platform === "win32"
      ? process.env.COMSPEC || "cmd.exe"
      : process.env.SHELL || "/bin/sh");
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

    const mergedEnv = env ? { ...process.env, ...env } : { ...process.env };
    if (!mergedEnv.TERM) mergedEnv.TERM = "xterm-256color";

    ensureSpawnHelperExec();

    this.ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: mergedEnv,
    });

    this.ptyProcess.onData((data) => {
      const { segments, hasDsr } = splitAroundDsr(data);

      if (!hasDsr) {
        this.writeQueue.enqueue(async () => {
          this.rawOutput += data;
          this.trimRawOutputIfNeeded();
          await new Promise<void>((resolve) => {
            this.xterm.write(data, () => resolve());
          });
          this.dataHandler?.(data);
        });
        return;
      }

      for (const segment of segments) {
        this.writeQueue.enqueue(async () => {
          if (segment.text) {
            this.rawOutput += segment.text;
            this.trimRawOutputIfNeeded();
            await new Promise<void>((resolve) => {
              this.xterm.write(segment.text, () => resolve());
            });
            this.dataHandler?.(segment.text);
          }

          if (segment.dsrAfter) {
            const buffer = this.xterm.buffer.active;
            const response = buildCursorPositionResponse(buffer.cursorY + 1, buffer.cursorX + 1);
            this.ptyProcess.write(response);
          }
        });
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this._exited = true;
      this._exitCode = exitCode;
      this._signal = signal;

      const exitMessage = `\n[Process exited with code ${exitCode}${signal ? ` (signal: ${signal})` : ""}]\n`;
      this.writeQueue.enqueue(async () => {
        this.rawOutput += exitMessage;
        await new Promise<void>((resolve) => {
          this.xterm.write(exitMessage, () => resolve());
        });
      });

      this.writeQueue.drain().then(() => {
        this.exitHandler?.(exitCode, signal);
      });
    });
  }

  private trimRawOutputIfNeeded(): void {
    const trimmed = trimRawOutput(this.rawOutput, this.lastStreamPosition);
    this.rawOutput = trimmed.rawOutput;
    this.lastStreamPosition = trimmed.lastStreamPosition;
  }

  setEventHandlers(events: PtySessionEvents): void {
    this.dataHandler = events.onData;
    this.exitHandler = events.onExit;
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get signal(): number | undefined {
    return this._signal;
  }

  get pid(): number {
    return this.ptyProcess.pid;
  }

  get cols(): number {
    return this.xterm.cols;
  }

  get rows(): number {
    return this.xterm.rows;
  }

  write(data: string): void {
    if (!this._exited) {
      this.ptyProcess.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (cols === this.xterm.cols && rows === this.xterm.rows) return;
    if (cols < 1 || rows < 1) return;
    this.xterm.resize(cols, rows);
    if (!this._exited) {
      this.ptyProcess.resize(cols, rows);
    }
  }

  private renderLineFromCells(lineIndex: number, cols: number): string {
    const buffer = this.xterm.buffer.active;
    const line = buffer.getLine(lineIndex);

    let currentStyle: CellStyle = {
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      fgMode: "default",
      fg: 0,
      bgMode: "default",
      bg: 0,
    };
    let currentKey = styleKey(currentStyle);
    let output = sgrForStyle(currentStyle);

    for (let x = 0; x < cols; x++) {
      const cell: IBufferCell | undefined = line?.getCell(x);
      const width = cell?.getWidth() ?? 1;
      if (width === 0) continue;

      const chars = cell?.getChars() ?? " ";
      const cellChars = chars.length === 0 ? " " : chars;

      const rawFgMode: CellStyle["fgMode"] = cell?.isFgDefault()
        ? "default"
        : cell?.isFgRGB()
          ? "rgb"
          : cell?.isFgPalette()
            ? "palette"
            : "default";
      const rawBgMode: CellStyle["bgMode"] = cell?.isBgDefault()
        ? "default"
        : cell?.isBgRGB()
          ? "rgb"
          : cell?.isBgPalette()
            ? "palette"
            : "default";

      const fg = normalizePaletteColor(rawFgMode, cell?.getFgColor() ?? 0);
      const bg = normalizePaletteColor(rawBgMode, cell?.getBgColor() ?? 0);

      const nextStyle: CellStyle = {
        bold: !!cell?.isBold(),
        dim: !!cell?.isDim(),
        italic: !!cell?.isItalic(),
        underline: !!cell?.isUnderline(),
        inverse: !!cell?.isInverse(),
        invisible: !!cell?.isInvisible(),
        strikethrough: !!cell?.isStrikethrough(),
        fgMode: fg.mode,
        fg: fg.value,
        bgMode: bg.mode,
        bg: bg.value,
      };
      const nextKey = styleKey(nextStyle);
      if (nextKey !== currentKey) {
        currentStyle = nextStyle;
        currentKey = nextKey;
        output += sgrForStyle(currentStyle);
      }

      output += cellChars;
    }

    return output + "\u001b[0m";
  }

  getViewportLines(options: { ansi?: boolean } = {}): string[] {
    const buffer = this.xterm.buffer.active;
    const totalLines = buffer.length;
    const lines: string[] = [];

    if (this.followBottom) {
      this.scrollOffset = 0;
    }

    const viewportStart = Math.max(0, totalLines - this.xterm.rows - this.scrollOffset);
    const useAnsi = !!options.ansi;

    if (useAnsi) {
      for (let i = 0; i < this.xterm.rows; i++) {
        const lineIndex = viewportStart + i;
        const rendered = this.renderLineFromCells(lineIndex, this.xterm.cols);
        const plain = buffer.getLine(lineIndex)?.translateToString(true) ?? "";
        const renderedPlain = rendered
          .replace(/\x1b\[[0-9;]*m/g, "")
          .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");

        if (plain.trim().length > 0 && renderedPlain.trim().length === 0) {
          lines.push(sanitizeLine(plain) + "\u001b[0m");
        } else {
          lines.push(rendered);
        }
      }
      return lines;
    }

    for (let i = 0; i < this.xterm.rows; i++) {
      const lineIndex = viewportStart + i;
      if (lineIndex < totalLines) {
        lines.push(sanitizeLine(buffer.getLine(lineIndex)?.translateToString(true) ?? ""));
      } else {
        lines.push("");
      }
    }

    return lines;
  }

  scrollUp(lines: number): void {
    const buffer = this.xterm.buffer.active;
    const maxScroll = Math.max(0, buffer.length - this.xterm.rows);
    this.scrollOffset = Math.min(this.scrollOffset + lines, maxScroll);
    this.followBottom = false;
  }

  scrollDown(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    if (this.scrollOffset === 0) {
      this.followBottom = true;
    }
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
    this.followBottom = true;
  }

  isScrolledUp(): boolean {
    return this.scrollOffset > 0;
  }

  kill(signal: string = "SIGTERM"): void {
    if (this._exited) return;

    const pid = this.ptyProcess.pid;
    if (process.platform !== "win32" && pid) {
      try {
        process.kill(-pid, signal as NodeJS.Signals);
        return;
      } catch {
        // 프로세스 그룹 종료 실패 시 직접 종료로 폴백합니다.
      }
    }

    try {
      this.ptyProcess.kill(signal);
    } catch {
      // 이미 종료된 경우는 무시합니다.
    }
  }

  dispose(): void {
    this.kill();
    this.xterm.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 팝업 실행기 (launcher)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// 내부 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function splitAroundDsr(input: string): { segments: DsrSegment[]; hasDsr: boolean } {
  const segments: DsrSegment[] = [];
  let lastIndex = 0;
  let hasDsr = false;
  const regex = new RegExp(DSR_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    hasDsr = true;
    if (match.index > lastIndex) {
      segments.push({ text: input.slice(lastIndex, match.index), dsrAfter: true });
    } else {
      segments.push({ text: "", dsrAfter: true });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.length) {
    segments.push({ text: input.slice(lastIndex), dsrAfter: false });
  }

  return { segments, hasDsr };
}

function buildCursorPositionResponse(row = 1, col = 1): string {
  return `\x1b[${row};${col}R`;
}

function trimRawOutput(rawOutput: string, lastStreamPosition: number): {
  rawOutput: string;
  lastStreamPosition: number;
} {
  if (rawOutput.length <= MAX_RAW_OUTPUT_SIZE) {
    return { rawOutput, lastStreamPosition };
  }

  const keepSize = Math.floor(MAX_RAW_OUTPUT_SIZE / 2);
  const trimAmount = rawOutput.length - keepSize;
  return {
    rawOutput: rawOutput.substring(trimAmount),
    lastStreamPosition: Math.max(0, lastStreamPosition - trimAmount),
  };
}

function sanitizeLine(line: string): string {
  let output = line;
  if (output.includes("\u001b")) {
    output = output.replace(OSC_REGEX, "");
    output = output.replace(APC_REGEX, "");
    output = output.replace(DCS_REGEX, "");
    output = output.replace(CSI_REGEX, (match) => (match.endsWith("m") ? match : ""));
    output = output.replace(ESC_SINGLE_REGEX, "");
  }
  if (output.includes("\t")) {
    output = output.replace(/\t/g, "   ");
  }
  if (output.includes("\r")) {
    output = output.replace(/\r/g, "");
  }
  output = output.replace(CONTROL_REGEX, "");
  return output;
}

function styleKey(style: CellStyle): string {
  return [
    style.bold ? "b" : "-",
    style.dim ? "d" : "-",
    style.italic ? "i" : "-",
    style.underline ? "u" : "-",
    style.inverse ? "v" : "-",
    style.invisible ? "x" : "-",
    style.strikethrough ? "s" : "-",
    `fg:${style.fgMode}:${style.fg}`,
    `bg:${style.bgMode}:${style.bg}`,
  ].join("");
}

function rgbToSgr(isFg: boolean, hex: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return isFg ? `38;2;${r};${g};${b}` : `48;2;${r};${g};${b}`;
}

function paletteToSgr(isFg: boolean, idx: number): string {
  return isFg ? `38;5;${idx}` : `48;5;${idx}`;
}

function sgrForStyle(style: CellStyle): string {
  const parts: string[] = ["0"];
  if (style.bold) parts.push("1");
  if (style.dim) parts.push("2");
  if (style.italic) parts.push("3");
  if (style.underline) parts.push("4");
  if (style.inverse) parts.push("7");
  if (style.invisible) parts.push("8");
  if (style.strikethrough) parts.push("9");

  if (style.fgMode === "rgb") parts.push(rgbToSgr(true, style.fg));
  else if (style.fgMode === "palette") parts.push(paletteToSgr(true, style.fg));

  if (style.bgMode === "rgb") parts.push(rgbToSgr(false, style.bg));
  else if (style.bgMode === "palette") parts.push(paletteToSgr(false, style.bg));

  return `\u001b[${parts.join(";")}m`;
}

function normalizePaletteColor(
  mode: "default" | "palette" | "rgb",
  value: number,
): { mode: "default" | "palette" | "rgb"; value: number } {
  if (mode !== "palette") return { mode, value };
  if (value < 0 || value > 255) {
    return { mode: "default", value: 0 };
  }
  return { mode: "palette", value };
}
