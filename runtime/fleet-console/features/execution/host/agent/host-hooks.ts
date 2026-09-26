import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import type { AgentCliPlugin, AgentCliPluginHttpMount, FleetHookExec } from "@fleet-console/agent-runtime/fleet";
import { createAgentCliPlugin, createSessionCaptureHookExec, type AgentCliId } from "@fleet-console/agent-runtime/fleet";

export interface ConsoleHookCommandEntry {
  readonly entryPath: string;
  readonly execPath: string;
  readonly tsxLoaderPath?: string;
}

export type ConsoleCaptureProvider = "claude";

export type ConsoleTurnPhase = "start" | "end";

const JAVASCRIPT_ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const TYPESCRIPT_ENTRY_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);

export function buildConsoleTurnHookCommand(entry: ConsoleHookCommandEntry, phase: ConsoleTurnPhase): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", phase === "start" ? "turn-start" : "turn-end"]);
}

export function buildConsoleWorkspaceHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "workspace"]);
}

export function buildConsoleBackgroundHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "background-report"]);
}

export function buildConsoleAttentionHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "attention"]);
}

export function buildConsoleAutoNameHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "auto-name"]);
}

export function buildConsoleCaptureHookCommand(
  entry: ConsoleHookCommandEntry,
  cliId: AgentCliId,
  createCaptureHook: typeof createSessionCaptureHookExec = createSessionCaptureHookExec,
): FleetHookExec {
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    return createCaptureHook({
      entryPath: entry.entryPath,
      execPath: entry.execPath,
      provider: toCaptureProvider(cliId),
    });
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet Console capture session hook requires a tsx loader path");
    }
    return createCaptureHook({
      entryPath: entry.entryPath,
      execPath: entry.execPath,
      provider: toCaptureProvider(cliId),
      tsxLoader: entry.tsxLoaderPath,
    });
  }
  throw new Error(`Unsupported Fleet Console session hook entry extension: ${extension}`);
}

export function toCaptureProvider(cliId: AgentCliId): ConsoleCaptureProvider {
  return "claude";
}

function buildConsoleCliHookExec(entry: ConsoleHookCommandEntry, trailingArgs: readonly string[]): FleetHookExec {
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    return {
      command: entry.execPath,
      args: [entry.entryPath, ...trailingArgs],
    };
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet Console session hook command for TypeScript entries requires a tsx loader path");
    }
    return {
      command: entry.execPath,
      args: ["--import", pathToFileURL(entry.tsxLoaderPath).href, entry.entryPath, ...trailingArgs],
    };
  }
  throw new Error(`Unsupported Fleet Console session hook entry extension: ${extension}`);
}

const HOOK_ENTRY_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

export interface RenderConsoleAgentCliPluginDeps {
  /** zip을 얹을 Console 리스너의 루프백 전용 불투명 경로. 생략하면 자기 루프백 리스너를 연다. */
  readonly transport?: AgentCliPluginHttpMount;
  readonly entryPath?: string;
  readonly execPath?: string;
  readonly tsxLoaderPath?: string;
}

/**
 * 이 Console이 띄우는 모든 Claude 세션이 실을 플러그인을 zip 한 벌로 묶는다.
 *
 * 기동에 **한 번만** 부른다. 결과는 세션 좌표를 담지 않아 런치마다 같다. 자식은 세션마다 이
 * zip을 받아 자기 임시 자리에 풀므로, 세션끼리도 `fleet` 런처와도 디스크를 나눠 쓰지 않는다.
 */
export function renderConsoleAgentCliPlugin(deps: RenderConsoleAgentCliPluginDeps): AgentCliPlugin {
  const entry = buildConsoleHookEntry(deps);
  return createAgentCliPlugin({
    ...(deps.transport ? { transport: deps.transport } : {}),
    // 캡처 훅의 provider는 어떤 CLI로 열든 claude 하나다 — 그래서 이 조립이 세션과 무관하다.
    captureSessionHookExec: buildConsoleCaptureHookCommand(entry, "claude"),
    turnStartHookExec: buildConsoleTurnHookCommand(entry, "start"),
    turnEndHookExec: buildConsoleTurnHookCommand(entry, "end"),
    backgroundReportHookExec: buildConsoleBackgroundHookCommand(entry),
    inputWaitingHookExec: buildConsoleAttentionHookCommand(entry),
    autoNameHookExec: buildConsoleAutoNameHookCommand(entry),
  });
}

/**
 * Console CLI를 가리키는 훅 진입점. 세션별 값이 하나도 구워지지 않는다 — 그래서 모든 세션이
 * 한 트리를 공유할 수 있다.
 */
export function buildConsoleHookEntry(deps: { readonly entryPath?: string; readonly execPath?: string; readonly tsxLoaderPath?: string }): ConsoleHookCommandEntry {
  const entryPath = resolveHookEntryPath(deps.entryPath ?? process.argv[1]);
  const execPath = deps.execPath ?? process.execPath;
  const tsxLoaderPath = deps.tsxLoaderPath ?? resolveOptionalPackage("tsx");
  return { entryPath, execPath, ...(tsxLoaderPath ? { tsxLoaderPath } : {}) };
}

const CONSOLE_ENTRY_PATH = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

function resolveHookEntryPath(candidate: string | undefined): string {
  if (candidate && hasHookEntryExtension(candidate)) return candidate;
  if (candidate) {
    try {
      const realPath = fs.realpathSync(candidate);
      if (hasHookEntryExtension(realPath)) return realPath;
    } catch {
      // 실행 엔트리 symlink 해석 실패 시 번들 엔트리로 폴백한다.
    }
  }
  return CONSOLE_ENTRY_PATH;
}

function hasHookEntryExtension(entryPath: string): boolean {
  return HOOK_ENTRY_EXTENSIONS.has(path.extname(entryPath));
}

function resolveOptionalPackage(id: string): string | undefined {
  try {
    return require.resolve(id);
  } catch {
    return undefined;
  }
}
