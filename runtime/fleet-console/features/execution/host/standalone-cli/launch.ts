import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { createChildEnv, resolveBinary, resolvePathBinary, type OwnedProcessPort } from "@fleet-console/process";
import { prepareAiGatewayLaunchProfile, resolveAiGatewaySelection, visibleGatewayModels } from "@fleet-console/ai-gateway";
import type { AiGatewayStoredSettings, ProviderStatusMap } from "@fleet-console/ai-gateway";
import type { ClaudeGatewayExternalMcpServer } from "@fleet-console/agent-runtime/claude";

import { FLEET_BROWSER_MCP_SERVER } from "../../../browser/host/mcp.js";
import type { AiGatewayLaunchBinding } from "../agent/launch.js";
import { applyAgentCliPathEnvOverlay, resolveAgentCliBinary } from "../agent/agent-cli-paths.js";
import { stripConsoleInternalEnv, TERMINAL_TERM, withTerminalCapabilities } from "../terminal/launch-env.js";
import type { TerminalLaunchContext, TerminalLaunchSpec } from "../terminal/terminal-types.js";
import type { AntigravityPluginNote } from "../../shared/standalone-cli.js";
import { mergeStandaloneCliPluginEnv, prepareAntigravityPlugins, readStandaloneCliPlugins, type StandaloneCliPlugin } from "./global-plugins.js";

export const STANDALONE_CLI_KINDS = ["claude", "antigravity"] as const;
export type StandaloneCliKind = (typeof STANDALONE_CLI_KINDS)[number];

export function isStandaloneCliKind(value: unknown): value is StandaloneCliKind {
  return value === "claude" || value === "antigravity";
}

export function standaloneCliSessionId(cli: StandaloneCliKind): string {
  return `standalone-cli:${cli}`;
}

export function standaloneCliRecordType(cli: StandaloneCliKind): string {
  return `standalone-cli:${cli}`;
}

export interface StandaloneCliBrowserMcpPrepared {
  readonly endpointUrl: string;
  readonly bearerToken: string;
  release(): Promise<void>;
}

export interface StandaloneCliBrowserMcpBinding {
  prepare(options: {
    readonly cli: StandaloneCliKind;
    readonly cwd: string;
    readonly commodoreId: string | null;
  }): Promise<StandaloneCliBrowserMcpPrepared>;
}

/**
 * 독립 CLI(Claude Code · Antigravity)의 런치.
 *
 * 사령관·지휘관과 무관한 독립 세션이다. Fleet 플러그인 트리·시스템 프롬프트·세션 훅·세션 좌표는 싣지 않고,
 * 사용자가 고른 CLI가 현재 보고 있는 사령관의 Fleet Browser를 바로 쓸 수 있게 `fleet-browser` HTTP MCP만
 * 임시 0600 설정 파일/디렉터리로 주입한다(argv에 Bearer 토큰을 싣지 않는다).
 *
 * 사람이 전역으로 설치한 플러그인(`commodore-plugins/global.json`)은 두 CLI에 함께 싣는다 — 목표 세션 토글
 * (`objectiveExcluded`)은 이 CLI에 해당하지 않는다. Claude Code는 설치본을 `--plugin-dir`로, 키는 자식 환경으로 받고,
 * Antigravity는 세션 범위로 변환한 사본을 받는다(`prepareAntigravityPlugins`).
 *
 * Claude Code는 AI Gateway 변수와 압축 창 `--settings`를 받고, Antigravity(`agy`)는 자체 인증 스택을 그대로 쓴다.
 * 두 CLI 모두 부모 세션 표식과 Fleet 내부 환경 변수는 걷는다.
 */
export interface StandaloneCliLaunchDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly aiGateway: AiGatewayLaunchBinding;
  readonly browserMcp?: StandaloneCliBrowserMcpBinding;
  /** 전역 설치 플러그인을 런치마다 설치본 경로로 푼다. 생략하면 플러그인 없이 뜬다. */
  readonly globalPlugins?: () => readonly StandaloneCliPlugin[];
  /** Antigravity 플러그인 변환 자식을 Console과 함께 끝나게 띄우는 소유 포트. */
  readonly processes?: OwnedProcessPort;
  /** Console 종료 신호 — 진행 중인 변환을 끝내 종료가 런치를 기다리지 않게 한다. */
  readonly shutdown?: AbortSignal;
  /** 원격 MCP 서버가 로그인을 요구하는가(MCP 표준 신호). Antigravity 로그인 안내에 쓴다. 생략하면 안내를 만들지 않는다. */
  readonly mcpSignInRequired?: (config: ClaudeGatewayExternalMcpServer) => Promise<boolean>;
  /** Antigravity 런치 하나의 플러그인 보고를 받을 자리를 연다. 런치마다 한 번 부르고, 돌려준 함수로 보고를 넘긴다. */
  readonly antigravityPluginNotes?: () => (notes: readonly AntigravityPluginNote[]) => void;
  readonly readAgentCliPaths?: () => Promise<Readonly<Record<string, string>>>;
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
  /** Gateway 모델 캐시를 쓸 홈. 테스트만 넘긴다 — 생략하면 사용자 홈이다(Agent PTY와 같은 자리). */
  readonly homeDir?: string;
}

/**
 * 부모 Claude 세션이나 Fleet 세션에서 상속될 수 있는 이름들. 값이 있어도 이 CLI의 것이 아니다.
 * 사용자가 셸에서 직접 고른 Claude Code 설정(예: 서브에이전트 깊이)은 여기 없다 — 그것은 남긴다.
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`만은 settings보다 우선하므로 자식 환경에서 지운다.
 */
const INHERITED_SESSION_ENV_KEYS = [
  // Fleet 세션 식별·훅 자격. 이 CLI에는 Fleet 훅이 없다.
  "FLEET_CONSOLE_SESSION_ID",
  "FLEET_CONSOLE_AGENT_CALL_SESSION_ID",
  "FLEET_COMPACT_BASE_URL",
  "FLEET_COMPACT_HOOK_TOKEN",
  "FLEET_MOD_BASE_URL",
  "FLEET_MOD_TOKEN",
  // 부모 Claude 세션의 표식과 세션 간 메시지 통로. 남기면 이 CLI가 남의 세션의 자식으로 읽힌다.
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
] as const;

/** Gateway 런치 공용 변수 중 Fleet 라우팅 Mod를 싣는 스위치. 평범한 CLI는 사용자가 직접 켠 경우에만 받는다. */
const FUNCTION_HOOKS_ENV_KEY = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";

export function standaloneCliBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = stripConsoleInternalEnv(env);
  for (const key of INHERITED_SESSION_ENV_KEYS) delete next[key];
  return next;
}

export async function isStandaloneCliInstalled(
  cli: StandaloneCliKind,
  deps: Pick<StandaloneCliLaunchDeps, "env" | "readAgentCliPaths">,
): Promise<boolean> {
  const inherited = deps.env ?? process.env;
  const env = standaloneCliBaseEnv(inherited);
  if (cli === "claude") {
    const userPaths = deps.readAgentCliPaths ? await deps.readAgentCliPaths() : {};
    const resolution = resolveAgentCliBinary({ cliCommand: "claude", env, userPaths });
    return resolution.resolved !== undefined;
  }
  const override = env.AGY_BIN?.trim();
  try {
    return resolvePathBinary(override || "agy", env) !== undefined;
  } catch {
    return false;
  }
}

async function prepareBrowserMcpInjection(
  cli: StandaloneCliKind,
  binding: StandaloneCliBrowserMcpBinding,
  cwd: string,
  commodoreId: string | null,
): Promise<{ readonly args: readonly string[]; readonly cleanup: () => Promise<void> }> {
  const prepared = await binding.prepare({ cli, cwd, commodoreId });
  let tmpDir: string | null = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const dir = tmpDir;
    tmpDir = null;
    try {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    } finally {
      await prepared.release();
    }
  };
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `fleet-standalone-${cli}-mcp-`));
    await fs.chmod(tmpDir, 0o700);
    if (cli === "claude") {
      const configPath = path.join(tmpDir, "mcp-config.json");
      const payload = JSON.stringify({
        mcpServers: {
          [FLEET_BROWSER_MCP_SERVER]: {
            type: "http",
            url: prepared.endpointUrl,
            headers: {
              Authorization: `Bearer ${prepared.bearerToken}`,
            },
          },
        },
      });
      await fs.writeFile(configPath, payload, { mode: 0o600 });
      return { args: ["--mcp-config", configPath], cleanup };
    }
    // Antigravity CLI(`agy`)는 `--add-dir`로 추가한 폴더의 `.agents/plugins/<name>/mcp_config.json`을
    // 세션 범위로 자동 발견한다. 사용자 `~/.gemini/config/mcp_config.json`이나 작전 구역 트리를 건드리지 않는다.
    const pluginDir = path.join(tmpDir, ".agents", "plugins", FLEET_BROWSER_MCP_SERVER);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: FLEET_BROWSER_MCP_SERVER, version: "1.0.0" }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(pluginDir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          [FLEET_BROWSER_MCP_SERVER]: {
            serverUrl: prepared.endpointUrl,
            headers: {
              Authorization: `Bearer ${prepared.bearerToken}`,
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    return { args: ["--add-dir", tmpDir], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function createStandaloneCliLaunchResolver(
  deps: StandaloneCliLaunchDeps,
  cli: StandaloneCliKind = "claude",
) {
  return async (cwd: string | undefined, context: TerminalLaunchContext | undefined): Promise<TerminalLaunchSpec> => {
    if (!cwd) throw new Error("standalone_cli_cwd_required");
    const inherited = deps.env ?? process.env;
    let env = standaloneCliBaseEnv(inherited);
    const additionalDirectories = normalizeAdditionalDirectories(cwd, context?.additionalDirectories);
    const additionalDirArgs = additionalDirectories.flatMap((dir) => ["--add-dir", dir]);

    if (cli === "antigravity") {
      const { bin, prefixArgs } = resolveBinary("agy", "AGY_BIN", env);
      const baseEnv = withTerminalCapabilities({
        ...env,
        INIT_CWD: cwd,
        PWD: cwd,
        ...(context?.colorScheme ? { COLORFGBG: context.colorScheme === "light" ? "0;15" : "15;0" } : {}),
      });
      const plugins = await prepareAntigravityPlugins({
        plugins: readStandaloneCliPlugins(deps.globalPlugins),
        bin,
        prefixArgs,
        env,
        reservedNames: deps.browserMcp ? [FLEET_BROWSER_MCP_SERVER] : [],
        ...(deps.processes ? { processes: deps.processes } : {}),
        ...(deps.shutdown ? { signal: deps.shutdown } : {}),
        ...(deps.mcpSignInRequired ? { signInRequired: deps.mcpSignInRequired } : {}),
        ...(deps.antigravityPluginNotes ? { report: deps.antigravityPluginNotes() } : {}),
      });
      let mcp: Awaited<ReturnType<typeof prepareBrowserMcpInjection>> | undefined;
      try {
        mcp = deps.browserMcp
          ? await prepareBrowserMcpInjection("antigravity", deps.browserMcp, cwd, context?.commodoreId ?? null)
          : undefined;
      } catch (error) {
        await plugins?.cleanup().catch(() => undefined);
        throw error;
      }
      const cleanups = [plugins?.cleanup, mcp?.cleanup].filter((cleanup) => cleanup !== undefined);
      return {
        bin,
        args: [...prefixArgs, "--dangerously-skip-permissions", ...additionalDirArgs, ...(plugins?.args ?? []), ...(mcp?.args ?? [])],
        cwd,
        env: createChildEnv(baseEnv, {}),
        terminalName: TERMINAL_TERM,
        ...(cleanups.length > 0 ? { cleanup: () => runCleanups(cleanups) } : {}),
      };
    }

    if (deps.readAgentCliPaths) env = applyAgentCliPathEnvOverlay(env, "claude", await deps.readAgentCliPaths());
    const { bin, prefixArgs } = resolveBinary("claude", "CLAUDE_BIN", env);
    const origin = deps.aiGateway.origin();
    if (!origin) throw new Error("Fleet Console has not bound a port yet, so the AI gateway URL cannot be derived.");
    const baseEnv = withTerminalCapabilities({
      ...env,
      INIT_CWD: cwd,
      PWD: cwd,
      ...(context?.colorScheme ? { COLORFGBG: context.colorScheme === "light" ? "0;15" : "15;0" } : {}),
    });
    // Gateway 변수와 모델 캐시는 Agent PTY와 같은 한 함수가 같은 목록(로그인된 카탈로그)으로 정한다 — 같은 홈의
    // 캐시를 다른 목록으로 덮으면 그 홈을 쓰는 다른 자식의 별칭이 흔들린다. compact·Mod 자격은 넘기지 않는다.
    const gatewaySettings = deps.readAiGatewaySettings ? deps.readAiGatewaySettings() : undefined;
    const selection = gatewaySettings ? resolveAiGatewaySelection(gatewaySettings) : undefined;
    const profile = prepareAiGatewayLaunchProfile({
      id: "claude",
      label: "Claude Code",
      bin,
      args: [...prefixArgs],
      cwd,
      env: createChildEnv(baseEnv, {}),
      terminalName: TERMINAL_TERM,
    }, {
      baseUrl: `${origin}${deps.aiGateway.routePath}`,
      ...(selection ? { selection: { ...selection, models: visibleGatewayModels(readStatuses(deps.readProviderStatuses)) } } : {}),
      compactCeiling: gatewaySettings?.compactCeiling ?? null,
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    });
    // 전역 플러그인 MCP 선언의 `${VAR}` 키 — 자식이 플러그인을 읽으며 이 환경으로 펼친다. 키는 argv에 싣지 않는다.
    const plugins = readStandaloneCliPlugins(deps.globalPlugins);
    const launchEnv: Record<string, string> = { ...profile.env, ...mergeStandaloneCliPluginEnv(plugins) };
    if (!inherited[FUNCTION_HOOKS_ENV_KEY]) delete launchEnv[FUNCTION_HOOKS_ENV_KEY];
    if (additionalDirectories.length > 0 && !launchEnv.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD) {
      launchEnv.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
    }
    const mcp = deps.browserMcp
      ? await prepareBrowserMcpInjection("claude", deps.browserMcp, cwd, context?.commodoreId ?? null)
      : undefined;
    return {
      bin: profile.bin,
      args: [
        ...profile.args,
        "--dangerously-skip-permissions",
        ...additionalDirArgs,
        ...plugins.flatMap((plugin) => ["--plugin-dir", plugin.path]),
        ...(mcp?.args ?? []),
      ],
      cwd,
      env: launchEnv,
      terminalName: TERMINAL_TERM,
      ...(mcp ? { cleanup: mcp.cleanup } : {}),
    };
  };
}

/** 하나가 실패해도 나머지 정리는 끝까지 한다. */
async function runCleanups(cleanups: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

function normalizeAdditionalDirectories(cwd: string, directories: readonly string[] | undefined): readonly string[] {
  if (!directories?.length) return [];
  const seen = new Set<string>([path.resolve(cwd)]);
  const normalized: string[] = [];
  for (const dir of directories) {
    if (typeof dir !== "string" || !dir || !path.isAbsolute(dir) || dir.includes("\0")) continue;
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(dir);
  }
  return normalized;
}

function readStatuses(read: (() => ProviderStatusMap | undefined) | undefined): ProviderStatusMap | undefined {
  if (!read) return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}
