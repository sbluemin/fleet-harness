/**
 * core-welcome — 웰컴 화면 확장
 *
 * 세션 시작 시 웰컴 오버레이(또는 헤더)를 표시하고,
 * 에이전트 활동 시작 시 자동으로 해제한다.
 *
 * welcome bridge에 dismiss 함수를 노출하여 다른 shell UI에서도 디스미스를 트리거할 수 있다.
 */

import { execSync } from "node:child_process";
import { readdirSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// 타입
// ═══════════════════════════════════════════════════════════════════════════

export interface WelcomeBridge {
  dismiss: () => void;
}

export interface RecentSession {
  name: string;
  timeAgo: string;
}

export interface LoadedCounts {
  contextFiles: number;
  extensions: number;
  skills: number;
  promptTemplates: number;
}

export interface GitUpdateStatus {
  behind: number;
  branch: string;
  hasRemote: boolean;
  isGitRepo: boolean;
  upstream?: string;
  version?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 상수 + ANSI 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANSI_RESET = "\x1b[0m";

const WELCOME_COLORS: Record<string, string> = {
  sep: "\x1b[38;5;244m",
  model: "\x1b[38;2;215;135;175m",
  path: "\x1b[38;2;0;175;175m",
  gitClean: "\x1b[38;2;95;175;95m",
  accent: "\x1b[38;2;254;188;56m",
  warn: "\x1b[38;2;255;179;71m",
  alert: "\x1b[38;2;255;85;85m",
};

const ansi = {
  reset: ANSI_RESET,
};

function fgOnly(color: string, text: string): string {
  const code = WELCOME_COLORS[color];
  return code ? `${code}${text}` : text;
}

function getFgAnsiCode(color: string): string {
  return WELCOME_COLORS[color] ?? "";
}

const FLEET_BANNER = [
  "████ █    ████ ████ ███",
  "█    █    █    █     █ ",
  "███  █    ███  ███   █ ",
  "█    █    █    █     █ ",
  "█    ████ ████ ████  █ ",
];

const GRADIENT_COLORS = [
  "\x1b[38;5;51m",
  "\x1b[38;5;45m",
  "\x1b[38;5;39m",
  "\x1b[38;5;33m",
  "\x1b[38;5;27m",
  "\x1b[38;5;21m",
];

const MIN_LAYOUT_WIDTH = 44;
const MIN_WELCOME_WIDTH = 76;
const MAX_WELCOME_WIDTH = 96;

interface WelcomeData {
  modelName: string;
  providerName: string;
  recentSessions: RecentSession[];
  loadedCounts: LoadedCounts;
  gitUpdate?: GitUpdateStatus;
}

interface FleetPackageJson {
  version?: unknown;
}

interface WelcomeState {
  dismissFn: (() => void) | null;
  headerActive: boolean;
  shouldDismiss: boolean;
  currentCtx: any | null;
}

export const FLEET_ROOT = join(__dirname, "..", "..", "..");

let welcomeBridge: WelcomeBridge | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// 브릿지
// ═══════════════════════════════════════════════════════════════════════════

export function getWelcomeBridge(): WelcomeBridge | null {
  return welcomeBridge;
}

export function setWelcomeBridge(bridge: WelcomeBridge | null): void {
  welcomeBridge = bridge;
}

// ═══════════════════════════════════════════════════════════════════════════
// WelcomeHeader 컴포넌트
// ═══════════════════════════════════════════════════════════════════════════

export class WelcomeHeader implements Component {
  private data: WelcomeData;

  constructor(
    modelName: string,
    providerName: string,
    recentSessions: RecentSession[] = [],
    loadedCounts: LoadedCounts = { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
    gitUpdate?: GitUpdateStatus,
  ) {
    this.data = { modelName, providerName, recentSessions, loadedCounts, gitUpdate };
  }

  invalidate(): void {}

  render(termWidth: number): string[] {
    if (termWidth < MIN_LAYOUT_WIDTH) {
      return [];
    }

    const boxWidth = getWelcomeBoxWidth(termWidth);
    const hChar = "─";

    const leftCol = 26;
    const rightCol = Math.max(1, boxWidth - leftCol - 3);
    const bottomLine = dim(hChar.repeat(leftCol)) + dim("┴") + dim(hChar.repeat(rightCol));

    const bannerLines = renderUpdateAlertBanner(this.data.gitUpdate, termWidth);
    const lines = renderWelcomeBox(this.data, termWidth, bottomLine);
    if (bannerLines.length > 0) {
      lines.unshift(...bannerLines);
    }
    if (lines.length > 0) {
      lines.push("");
    }
    return lines;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════════════════

export function discoverLoadedCounts(): LoadedCounts {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const cwd = process.cwd();

  let contextFiles = 0;
  let extensions = 0;
  let skills = 0;
  let promptTemplates = 0;

  const agentsMdPaths = [
    join(homeDir, ".pi", "agent", "AGENTS.md"),
    join(homeDir, ".claude", "AGENTS.md"),
    join(cwd, "AGENTS.md"),
    join(cwd, ".pi", "AGENTS.md"),
    join(cwd, ".claude", "AGENTS.md"),
  ];

  for (const path of agentsMdPaths) {
    if (existsSync(path)) contextFiles++;
  }

  const extensionDirs = [
    join(homeDir, ".pi", "agent", "extensions"),
    join(cwd, "extensions"),
    join(cwd, ".pi", "extensions"),
  ];

  const countedExtensions = new Set<string>();

  for (const dir of extensionDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const entryPath = join(dir, entry);
          const stats = statSync(entryPath);

          if (stats.isDirectory()) {
            if (existsSync(join(entryPath, "index.ts")) || existsSync(join(entryPath, "package.json"))) {
              if (!countedExtensions.has(entry)) {
                countedExtensions.add(entry);
                extensions++;
              }
            }
          } else if (entry.endsWith(".ts") && !entry.startsWith(".")) {
            const name = basename(entry, ".ts");
            if (!countedExtensions.has(name)) {
              countedExtensions.add(name);
              extensions++;
            }
          }
        }
      } catch {}
    }
  }

  const skillDirs = [
    join(homeDir, ".pi", "agent", "skills"),
    join(cwd, ".pi", "skills"),
    join(cwd, "skills"),
  ];

  const countedSkills = new Set<string>();

  for (const dir of skillDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const entryPath = join(dir, entry);
          try {
            if (statSync(entryPath).isDirectory()) {
              if (existsSync(join(entryPath, "SKILL.md"))) {
                if (!countedSkills.has(entry)) {
                  countedSkills.add(entry);
                  skills++;
                }
              }
            }
          } catch {}
        }
      } catch {}
    }
  }

  const templateDirs = [
    join(homeDir, ".pi", "agent", "commands"),
    join(homeDir, ".claude", "commands"),
    join(cwd, ".pi", "commands"),
    join(cwd, ".claude", "commands"),
  ];

  const countedTemplates = new Set<string>();

  function countTemplatesInDir(dir: string) {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const entryPath = join(dir, entry);
        try {
          const stats = statSync(entryPath);
          if (stats.isDirectory()) {
            countTemplatesInDir(entryPath);
          } else if (entry.endsWith(".md")) {
            const name = basename(entry, ".md");
            if (!countedTemplates.has(name)) {
              countedTemplates.add(name);
              promptTemplates++;
            }
          }
        } catch {}
      }
    } catch {}
  }

  for (const dir of templateDirs) {
    countTemplatesInDir(dir);
  }

  return { contextFiles, extensions, skills, promptTemplates };
}

export function checkGitUpdateStatus(): GitUpdateStatus {
  const version = readFleetVersion();
  let branch = "";

  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: __dirname,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return { behind: 0, branch: "", hasRemote: false, isGitRepo: false, version };
  }

  try {
    execSync("git fetch", {
      cwd: __dirname,
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    });
  } catch {
    // fetch 실패 시에도 캐시된 ref 기준으로 계속 진행
  }

  try {
    const upstream = execSync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", {
      cwd: __dirname,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const behindRaw = execSync("git rev-list HEAD..@{u} --count", {
      cwd: __dirname,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const behind = Number.parseInt(behindRaw, 10);

    return {
      behind: Number.isFinite(behind) ? behind : 0,
      branch,
      hasRemote: true,
      isGitRepo: true,
      upstream,
      version,
    };
  } catch {
    return { behind: 0, branch, hasRemote: false, isGitRepo: true, version };
  }
}

export function getRecentSessions(maxCount: number = 3): RecentSession[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";

  const sessionsDirs = [
    join(homeDir, ".pi", "agent", "sessions"),
    join(homeDir, ".pi", "sessions"),
  ];

  const sessions: { name: string; mtime: number }[] = [];

  function scanDir(dir: string) {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const entryPath = join(dir, entry);
        try {
          const stats = statSync(entryPath);
          if (stats.isDirectory()) {
            scanDir(entryPath);
          } else if (entry.endsWith(".jsonl")) {
            const parentName = basename(dir);
            let projectName = parentName;
            if (parentName.startsWith("--")) {
              const parts = parentName.split("-").filter(p => p);
              projectName = parts[parts.length - 1] || parentName;
            }
            sessions.push({ name: projectName, mtime: stats.mtimeMs });
          }
        } catch {}
      }
    } catch {}
  }

  for (const sessionsDir of sessionsDirs) {
    scanDir(sessionsDir);
  }

  if (sessions.length === 0) return [];

  sessions.sort((a, b) => b.mtime - a.mtime);

  const seen = new Set<string>();
  const uniqueSessions: typeof sessions = [];
  for (const s of sessions) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      uniqueSessions.push(s);
    }
  }

  const now = Date.now();
  return uniqueSessions.slice(0, maxCount).map(s => ({
    name: s.name.length > 20 ? s.name.slice(0, 17) + "…" : s.name,
    timeAgo: formatTimeAgo(now - s.mtime),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 등록
// ═══════════════════════════════════════════════════════════════════════════

export default function registerWelcome(pi: ExtensionAPI) {
  ensureQuietStartup();

  const state: WelcomeState = {
    dismissFn: null,
    headerActive: false,
    shouldDismiss: false,
    currentCtx: null,
  };

  setWelcomeBridge({
    dismiss: () => dismissWelcome(state.currentCtx, state),
  } satisfies WelcomeBridge);

  pi.on("session_start", async (event, ctx) => {
    state.currentCtx = ctx;

    if (event.reason === "resume" || event.reason === "new") {
      dismissWelcome(ctx, state);
      return;
    }

    state.dismissFn = null;
    state.headerActive = false;
    state.shouldDismiss = false;

    if (!ctx.hasUI) return;

    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setupWelcomeHeader(ctx, state);
  });

  pi.on("session_shutdown", async () => {
    state.dismissFn = null;
    state.headerActive = false;
    state.shouldDismiss = false;
    state.currentCtx = null;
  });

  pi.on("agent_start", async (_event, ctx) => {
    dismissWelcome(ctx, state);
  });

  pi.on("tool_call", async (_event, ctx) => {
    dismissWelcome(ctx, state);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 내부 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function isStaleExtensionContextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("agent listener invoked outside active run")) return true;
  const mentionsExtensionCtx =
    message.includes("extensioncontext") ||
    message.includes("extension ctx") ||
    message.includes("extension context");
  const mentionsStaleSession =
    message.includes("stale") ||
    message.includes("session") ||
    message.includes("replacement") ||
    message.includes("reload");
  return mentionsExtensionCtx && mentionsStaleSession;
}

function dismissWelcome(ctx: any, state: WelcomeState): void {
  if (state.dismissFn) {
    try {
      state.dismissFn();
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
    }
    state.dismissFn = null;
  } else {
    state.shouldDismiss = true;
  }
  if (state.headerActive) {
    state.headerActive = false;
    clearWelcomeHeader(ctx);
  }
}

function clearWelcomeHeader(ctx: any): void {
  if (!ctx?.ui?.setHeader) return;
  try {
    ctx.ui.setHeader(undefined);
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
}

function setupWelcomeHeader(ctx: any, state: WelcomeState): void {
  const modelName = ctx.model?.name || ctx.model?.id || "No model";
  const providerName = ctx.model?.provider || "Unknown";
  const loadedCounts = discoverLoadedCounts();
  const recentSessions = getRecentSessions(3);
  const gitUpdate = checkGitUpdateStatus();

  const header = new WelcomeHeader(modelName, providerName, recentSessions, loadedCounts, gitUpdate);
  state.headerActive = true;

  ctx.ui.setHeader(() => {
    return {
      render(width: number): string[] {
        return header.render(width);
      },
      invalidate() {
        header.invalidate();
      },
    };
  });
}

function ensureQuietStartup(): void {
  const quietMarker = join(FLEET_ROOT, ".pi", "quiet-startup.json");
  if (!existsSync(dirname(quietMarker))) {
    mkdirSync(dirname(quietMarker), { recursive: true });
  }

  let shouldWrite = true;
  if (existsSync(quietMarker)) {
    try {
      const current = JSON.parse(readFileSync(quietMarker, "utf8"));
      shouldWrite = current?.quietStartup !== true;
    } catch {
      shouldWrite = true;
    }
  }

  if (!shouldWrite) return;
  writeFileSync(quietMarker, JSON.stringify({ quietStartup: true }, null, 2));
}

export function createFleetUpdatePrompt(fleetRoot: string): string {
  return [
    "Please update the pi-fleet repository.",
    "",
    `1. Move to the local repository at the absolute path \`${fleetRoot}\`.`,
    "2. Identify the current active branch and synchronize it with the remote latest state. Run fetch followed by pull as needed.",
    "3. Follow the update procedure described in the repository root `SETUP.md`. Do not skip any step it specifies (dependency installation, link refresh, build, verification, etc.).",
    "4. Report the actions taken and verification results concisely.",
  ].join("\n");
}

function readFleetVersion(): string {
  try {
    const packageJsonPath = join(__dirname, "..", "..", "..", "package.json");
    if (!existsSync(packageJsonPath)) return "";

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as FleetPackageJson;
    return typeof packageJson.version === "string" ? packageJson.version : "";
  } catch {
    return "";
  }
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function boldFg(color: string, text: string): string {
  const code = getFgAnsiCode(color);
  return code ? `\x1b[1m${code}${text}${ansi.reset}` : bold(text);
}

function dim(text: string): string {
  return getFgAnsiCode("sep") + text + ansi.reset;
}

function checkmark(): string {
  return fgOnly("gitClean", "✓");
}

function gradientLine(line: string): string {
  const reset = ansi.reset;
  let result = "";
  let colorIdx = 0;
  const step = Math.max(1, Math.floor(line.length / GRADIENT_COLORS.length));

  for (let i = 0; i < line.length; i++) {
    if (i > 0 && i % step === 0 && colorIdx < GRADIENT_COLORS.length - 1) colorIdx++;
    const char = line[i];
    if (char !== " ") {
      result += GRADIENT_COLORS[colorIdx] + char + reset;
    } else {
      result += char;
    }
  }
  return result;
}

function centerText(text: string, width: number): string {
  const visLen = visibleWidth(text);
  if (visLen > width) return truncateToWidth(text, width);
  if (visLen === width) return text;
  const leftPad = Math.floor((width - visLen) / 2);
  const rightPad = width - visLen - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

function fitToWidth(str: string, width: number): string {
  const visLen = visibleWidth(str);
  if (visLen > width) return truncateToWidth(str, width);
  return str + " ".repeat(width - visLen);
}

function truncateToWidth(str: string, width: number): string {
  const ellipsis = "…";
  const maxWidth = Math.max(0, width - 1);
  let truncated = "";
  let currentWidth = 0;
  let inEscape = false;

  for (const char of str) {
    if (char === "\x1b") inEscape = true;
    if (inEscape) {
      truncated += char;
      if (char === "m") inEscape = false;
    } else if (currentWidth < maxWidth) {
      truncated += char;
      currentWidth++;
    }
  }

  if (visibleWidth(str) > width) return truncated + ellipsis;
  return truncated;
}

function sanitizeDisplay(value: string): string {
  return value.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

function getWelcomeBoxWidth(termWidth: number): number {
  return Math.min(termWidth, Math.max(MIN_WELCOME_WIDTH, Math.min(termWidth - 2, MAX_WELCOME_WIDTH)));
}

function applyHorizontalPadding(lines: string[], termWidth: number, boxWidth: number): string[] {
  const hPad = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
  if (hPad === 0) return lines;
  const pad = " ".repeat(hPad);
  return lines.map((line) => pad + line);
}

function renderUpdateAlertBanner(gitUpdate: GitUpdateStatus | undefined, termWidth: number): string[] {
  if (
    termWidth < MIN_LAYOUT_WIDTH ||
    !gitUpdate?.hasRemote ||
    gitUpdate.behind <= 0
  ) {
    return [];
  }

  const boxWidth = getWelcomeBoxWidth(termWidth);
  const contentWidth = boxWidth - 2;
  const hChar = "═";
  const borderColor = "alert";
  const v = boldFg(borderColor, "║");
  const tl = boldFg(borderColor, "╔");
  const tr = boldFg(borderColor, "╗");
  const bl = boldFg(borderColor, "╚");
  const br = boldFg(borderColor, "╝");
  const top = tl + boldFg(borderColor, hChar.repeat(contentWidth)) + tr;
  const bottom = bl + boldFg(borderColor, hChar.repeat(contentWidth)) + br;
  const remoteBranch = sanitizeDisplay(gitUpdate.upstream || gitUpdate.branch || "remote");
  const currentVersion = gitUpdate.version ? `v${sanitizeDisplay(gitUpdate.version)}` : "";

  const contentLines = [
    boldFg("alert", "⚠  UPDATE AVAILABLE  ⚠"),
    fgOnly("warn", `${gitUpdate.behind} commits behind ${remoteBranch}`),
  ];
  if (currentVersion) {
    contentLines.push(fgOnly("accent", `Current ${currentVersion} · Run /fleet:system:settings to sync`));
  }

  const lines = [
    top,
    ...contentLines.map((line) => v + fitToWidth(centerText(line, contentWidth), contentWidth) + v),
    bottom,
  ];

  return applyHorizontalPadding(lines, termWidth, boxWidth);
}

function buildFleetBanner(data: WelcomeData, colWidth: number): string[] {
  const bannerColored = FLEET_BANNER.map((line) => gradientLine(line));

  return [
    "",
    ...bannerColored.map((l) => centerText(l, colWidth)),
    "",
    centerText(fgOnly("model", data.modelName), colWidth),
    centerText(dim(data.providerName), colWidth),
    "",
  ];
}

function buildFleetInfo(data: WelcomeData, colWidth: number): string[] {
  const hChar = "─";
  const separator = ` ${dim(hChar.repeat(colWidth - 2))}`;

  const sessionLines: string[] = [];
  if (data.recentSessions.length === 0) {
    sessionLines.push(` ${dim("No recent sessions")}`);
  } else {
    for (const session of data.recentSessions.slice(0, 3)) {
      sessionLines.push(
        ` ${dim("▸ ")}${fgOnly("path", session.name)}${dim(` ${session.timeAgo}`)}`,
      );
    }
  }

  const countLines: string[] = [];
  const { contextFiles, extensions, skills, promptTemplates } = data.loadedCounts;

  if (contextFiles > 0 || extensions > 0 || skills > 0 || promptTemplates > 0) {
    if (contextFiles > 0) {
      countLines.push(` ${checkmark()} ${fgOnly("gitClean", `${contextFiles}`)} context file${contextFiles !== 1 ? "s" : ""}`);
    }
    if (extensions > 0) {
      countLines.push(` ${checkmark()} ${fgOnly("gitClean", `${extensions}`)} extension${extensions !== 1 ? "s" : ""}`);
    }
    if (skills > 0) {
      countLines.push(` ${checkmark()} ${fgOnly("gitClean", `${skills}`)} skill${skills !== 1 ? "s" : ""}`);
    }
    if (promptTemplates > 0) {
      countLines.push(` ${checkmark()} ${fgOnly("gitClean", `${promptTemplates}`)} prompt template${promptTemplates !== 1 ? "s" : ""}`);
    }
  } else {
    countLines.push(` ${dim("Nothing loaded")}`);
  }

  const updateLines: string[] = [];
  if (data.gitUpdate?.isGitRepo && data.gitUpdate.branch) {
    const displayBranch = sanitizeDisplay(data.gitUpdate.branch);
    const currentVersion = data.gitUpdate.version ? `v${sanitizeDisplay(data.gitUpdate.version)}` : "";
    updateLines.push(separator);
    if (!data.gitUpdate.hasRemote) {
      const versionSuffix = currentVersion ? ` · ${currentVersion}` : "";
      updateLines.push(` ${fgOnly("accent", `● Local branch (${displayBranch})${versionSuffix}`)}`);
    } else if (data.gitUpdate.behind === 0) {
      const versionSuffix = currentVersion ? ` · ${currentVersion}` : "";
      updateLines.push(` ${checkmark()} ${fgOnly("gitClean", `Up to date (${displayBranch})${versionSuffix}`)}`);
    }
  }

  return [
    ` ${bold(fgOnly("accent", "Shortcuts"))}`,
    ` ${dim("/")} commands  ${dim("·")} ${dim("!")} shell`,
    ` ${dim("Alt+.")} keybinds`,
    ` ${dim("Alt+H/L")} carriers`,
    separator,
    ` ${bold(fgOnly("accent", "Loaded"))}`,
    ...countLines,
    separator,
    ` ${bold(fgOnly("accent", "Recent"))}`,
    ...sessionLines,
    ...updateLines,
    "",
  ];
}

function renderWelcomeBox(
  data: WelcomeData,
  termWidth: number,
  bottomLine: string,
): string[] {
  if (termWidth < MIN_LAYOUT_WIDTH) {
    return [];
  }

  const boxWidth = getWelcomeBoxWidth(termWidth);
  const leftCol = 26;
  const rightCol = Math.max(1, boxWidth - leftCol - 3);

  const hChar = "─";
  const v = dim("│");
  const tl = dim("╭");
  const tr = dim("╮");
  const bl = dim("╰");
  const br = dim("╯");

  const leftLines = buildFleetBanner(data, leftCol);
  const rightLines = buildFleetInfo(data, rightCol);

  const lines: string[] = [];

  const title = " Fleet ";
  const titlePrefix = dim(hChar.repeat(3));
  const titleStyled = titlePrefix + fgOnly("accent", title);
  const titleVisLen = 3 + visibleWidth(title);
  const afterTitle = boxWidth - 2 - titleVisLen;
  const afterTitleText = afterTitle > 0 ? dim(hChar.repeat(afterTitle)) : "";
  lines.push(tl + titleStyled + afterTitleText + tr);

  const maxRows = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < maxRows; i++) {
    const left = fitToWidth(leftLines[i] ?? "", leftCol);
    const right = fitToWidth(rightLines[i] ?? "", rightCol);
    lines.push(v + left + v + right + v);
  }

  lines.push(bl + bottomLine + br);

  return applyHorizontalPadding(lines, termWidth, boxWidth);
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}
