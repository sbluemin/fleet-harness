import crypto from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GatewayModel } from "@dotobokuri/core-ai-gateway";

import { buildClaudeGatewayArgs } from "./builders/claude.js";
import {
  assertLaunchCommandLineBudget,
  LaunchPromptError,
  launchPromptHasCmdLineBreak,
  launchPromptHasCmdUnsafeChars,
  writeLaunchPromptPointer,
} from "./prompt.js";
import { isHostSessionToolAllowed } from "../tools.js";
import { getAgentCliInjectionCapability } from "./capabilities.js";
import { buildGatewayCustomAgents, type GatewayEffortExposure } from "./gateway-agents.js";
import { prepareClaudeSession, type ClaudeSessionHandle, type ClaudeSessionOrigin } from "./session.js";
import type {
  AgentCliInjectionContext,
  AgentCliMcpServerArg,
  AgentCliProfile,
  FleetHookExec,
} from "./types.js";

export interface InjectAgentCliProfileOptions {
  readonly dataDir?: string;
  readonly dedicatedMcpSession: DedicatedMcpSession;
  readonly mcpSessionLabel?: string;
  readonly captureSessionHookExec?: FleetHookExec;
  // 턴 시작(UserPromptSubmit)·턴 종료(Stop) 신호 hook. host가 빌드해 주입한다.
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  // 입력 대기 신호 hook. Claude plugin에 와이어링된다.
  readonly inputWaitingHookExec?: FleetHookExec;
  // 살아 있는 백그라운드 작업 보고(SubagentStop) hook. 턴 종료 시점의 같은 보고는 turnEndHookExec이 함께 실어 나른다.
  readonly backgroundReportHookExec?: FleetHookExec;
  // 작전명 자동 작명(UserPromptSubmit) hook. host가 빌드해 주입한다.
  readonly autoNameHookExec?: FleetHookExec;
  readonly onCleanup?: (cleanup: () => void) => void;
  /**
   * Claude Code 자신의 기본 시스템 프롬프트를 이 세션에 실을지. 생략하면 `on` —
   * 플래그 없는 런치가 이미 하는 일이다. `off`는 빈 본문을 시스템 프롬프트로 세워 그것을 대체한다.
   */
  readonly claudeCodeSystemPrompt?: "on" | "off";
  /**
   * Claude Code의 승인 게이트를 이 런치에서 건너뛸지. 생략하면 `false` — 자식이 도구마다
   * 터미널에서 묻는다. argv 표면에만 실린다(SDK 표면은 `session.ts` 참조).
   */
  readonly claudeCodeSkipPermissions?: boolean;
  /** 이 런치가 여는 Claude 세션의 출발점. 생략하면 새 세션을 발급한다. */
  readonly origin?: ClaudeSessionOrigin;
  /**
   * claude-gateway 전용: 위임 정체성으로 등록할 모델, 즉 AI Gateway 노출 집합에서 host 전용
   * 모델을 뺀 목록이다. `selection.models`를 넘기는 버그를 막기 위해 이름에 delegation을 명시한다.
   */
  readonly gatewayDelegationModels?: readonly GatewayModel[];
  /** claude-gateway 전용: 모델별로 정체성을 만들 강도. 항목이 없으면 그 모델의 사다리 전체. */
  readonly gatewayEffortExposure?: GatewayEffortExposure;
}

/** 주입이 끝난 프로필과, 그 프로필이 열게 될 세션의 확정된 좌표. */
export interface InjectedAgentCliProfile extends AgentCliProfile {
  readonly session: ClaudeSessionHandle;
}

interface DedicatedMcpSession {
  getEndpoint(): Promise<ExecutorEndpoint>;
  issueSessionToken(request: {
    readonly label: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly includeTool?: (toolId: string) => boolean;
  }): readonly ExecutorServerToken[] | Promise<readonly ExecutorServerToken[]>;
  releaseSessionToken(label: string): void;
}

interface ExecutorServerEndpoint {
  readonly name: string;
  readonly url: string;
}

interface ExecutorEndpoint {
  readonly servers: readonly ExecutorServerEndpoint[];
}

interface ExecutorServerToken {
  readonly name: string;
  readonly token: string;
}

export async function injectAgentCliProfile(
  profile: AgentCliProfile,
  options: InjectAgentCliProfileOptions,
): Promise<InjectedAgentCliProfile> {
  const capability = getAgentCliInjectionCapability(profile.id);
  const endpoint = await options.dedicatedMcpSession.getEndpoint();
  const tokenLabel = options.mcpSessionLabel ?? `agent:${profile.id}:${crypto.randomUUID()}`;
  const tokens = await options.dedicatedMcpSession.issueSessionToken({
    cwd: profile.cwd,
    // 이 세션에 허용된 호스트 도구만 세션 MCP에 노출한다.
    includeTool: (toolId) => isHostSessionToolAllowed(toolId),
    label: tokenLabel,
  });
  const mcpServers = buildAgentCliMcpServerConfigs(endpoint.servers, tokens);
  const tempCleanups: Array<() => void> = [];
  try {
    let promptArgs = [...(profile.promptArgs ?? [])];
    let deliveredViaFile = false;
    const cmdWrapped = profile.commandLineLimit?.via === "cmd-shim";
    const windowsLaunch = profile.commandLineLimit !== undefined;
    const convertPromptToFile = (body: string) => {
      promptArgs = [writeLaunchPromptPointer(
        body,
        (cleanupFn) => tempCleanups.push(cleanupFn),
        cmdWrapped,
      )];
      deliveredViaFile = true;
    };
    // POSIX와 한도 안의 Windows 원문은 argv에 그대로 둔다. Windows에서 cmd가 재해석할
    // 문자가 있으면 길이 상한과 무관하게 파일 포인터로 옮긴다 — 플러그인 조립이 실패해도
    // 파일이 남으면 안 되므로 시스템 프롬프트와 같이 플러그인보다 먼저 쓰고 tempCleanups에
    // 올린다. 명령줄 초과는 주입 인자가 합쳐진 뒤에만 알 수 있어 예산 검사에서 옮긴다.
    if (promptArgs.length > 0 && windowsLaunch) {
      const body = takeLaunchPromptBody(promptArgs);
      // 줄바꿈은 cmd shim일 때만 문제가 된다 — cmd의 명령줄이 거기서 끊겨 첫 줄만 자식에게
      // 닿는다. 실행 파일을 직접 부르는 Windows 경로는 인용된 인자 안의 줄바꿈을 그대로
      // 전달하므로 멀티라인 원문을 argv에 남긴다.
      if (launchPromptHasCmdUnsafeChars(body) || (cmdWrapped && launchPromptHasCmdLineBreak(body))) {
        convertPromptToFile(body);
      }
    }
    const session = await prepareClaudeSession({
      cliId: profile.id,
      cwd: profile.cwd,
      dataDir: options.dataDir,
      // 이 프로필의 인자가 이미 세션 좌표를 들고 있으면 우리 것을 얹지 않는다 — 호스트가
      // 무엇을 의도했든 자식은 두 좌표를 함께 받으면 거부한다(`fleet --resume <id>` 등).
      origin: profileCarriesSessionCoordinate(profile.args)
        ? { kind: "external" }
        : options.origin ?? { kind: "new" },
      ...(options.claudeCodeSystemPrompt ? { claudeCodeSystemPrompt: options.claudeCodeSystemPrompt } : {}),
      captureSessionHookExec: options.captureSessionHookExec,
      turnStartHookExec: options.turnStartHookExec,
      turnEndHookExec: options.turnEndHookExec,
      inputWaitingHookExec: options.inputWaitingHookExec,
      backgroundReportHookExec: options.backgroundReportHookExec,
      autoNameHookExec: options.autoNameHookExec,
      // 게이트웨이 정체성은 플러그인이 파일로 싣는다 — argv에는 이미 있던 플러그인 경로만 남는다.
      gatewayDelegationModels: options.gatewayDelegationModels,
      gatewayEffortExposure: options.gatewayEffortExposure,
    });
    const cleanup = createOnceCleanup(() => {
      for (const tempCleanup of tempCleanups) {
        tempCleanup();
      }
      options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    });
    options.onCleanup?.(cleanup);
    const context: AgentCliInjectionContext = {
      cliId: profile.id,
      mcpServers,
      pluginRoot: session.pluginRoot,
      pluginRoots: session.pluginRoots,
      ...(session.skillOverrides ? { skillOverrides: session.skillOverrides } : {}),
      sessionCoordinate: session.coordinate,
      ...(options.claudeCodeSystemPrompt ? { claudeCodeSystemPrompt: options.claudeCodeSystemPrompt } : {}),
      ...(options.claudeCodeSkipPermissions !== undefined
        ? { claudeCodeSkipPermissions: options.claudeCodeSkipPermissions }
        : {}),
    };
    const injectedArgs = buildAgentCliArgs(capability.builderId, context);
    const mergeArgs = (nextPromptArgs: readonly string[]) => mergeAgentCliArgs(
      { ...profile, promptArgs: nextPromptArgs },
      capability.builderId,
      context,
      injectedArgs,
    );
    const argsWithoutPrompt = mergeArgs([]);
    const checkBudget = () => assertLaunchCommandLineBudget({
      args: mergeArgs(promptArgs),
      argsWithoutPrompt,
      bin: profile.bin,
      limit: profile.commandLineLimit,
      promptIsFixedLength: deliveredViaFile,
    });
    // 명령줄 상한은 여기서만 판정할 수 있다 — 프롬프트 길이와 달리 주입 인자까지 합쳐진 뒤라야
    // 실제 값이 나온다. 프롬프트 없는 판본은 같은 병합을 한 번 더 돌려 만든다: 후미 인자라는
    // 위치 가정을 두면 병합 순서가 바뀌는 날 조용히 어긋난다.
    // 거부는 spawn 전에 끝나야 하므로 이 프로필이 만든 플러그인을 먼저 거둔다.
    try {
      checkBudget();
    } catch (error) {
      // Windows에서 원문 argv가 상한을 넘기면 파일 포인터로 한 번 더 시도한다. 포인터조차
      // 넘치면 줄일 대상이 프롬프트가 아니므로 설정 쪽 거절로 둔다.
      const canMoveToFile = !deliveredViaFile
        && windowsLaunch
        && promptArgs.length === 1
        && error instanceof LaunchPromptError
        && error.code === "prompt_command_line_too_long";
      if (!canMoveToFile) {
        cleanup();
        throw error;
      }
      convertPromptToFile(takeLaunchPromptBody(promptArgs));
      try {
        checkBudget();
      } catch (retryError) {
        cleanup();
        throw retryError;
      }
    }
    return {
      ...profile,
      args: mergeArgs(promptArgs),
      // 위치 인자는 이미 args 끝에 합쳐졌으므로 비운다. 남겨 두면 하류가 한 번 더 붙일 수 있다.
      promptArgs: [],
      cleanup,
      session,
    };
  } catch (error) {
    for (const tempCleanup of tempCleanups) {
      tempCleanup();
    }
    options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    throw error;
  }
}


/**
 * 이 argv가 이미 Claude 세션 좌표를 정하고 있는가.
 *
 * `fleet <passthrough>`는 사용자의 인자를 그대로 이어 붙이므로 여기에 `--resume`·`-c`가
 * 들어올 수 있다. 그 위에 `--session-id`를 더하면 자식이 곧바로 거부한다(실측:
 * `--session-id can only be used with --continue or --resume if --fork-session is also
 * specified`). 좌표를 싣는 쪽이 그 규칙도 알아야 하므로 판정을 여기에 둔다.
 */
function profileCarriesSessionCoordinate(args: readonly string[]): boolean {
  return args.some((arg) => SESSION_COORDINATE_FLAGS.has(arg) || arg.startsWith("--resume=") || arg.startsWith("--session-id="));
}

const SESSION_COORDINATE_FLAGS = new Set([
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--session-id",
  "--fork-session",
]);

function buildAgentCliMcpServerConfigs(
  endpoints: readonly ExecutorServerEndpoint[],
  tokens: readonly ExecutorServerToken[],
): AgentCliMcpServerArg[] {
  return endpoints.map((endpoint) => {
    const token = tokens.find((entry) => entry.name === endpoint.name)?.token;
    if (!token) {
      throw new Error(`Dedicated MCP token missing for ${endpoint.name}`);
    }
    return {
      name: endpoint.name,
      endpointUrl: endpoint.url,
      bearerToken: token,
    };
  });
}

function takeLaunchPromptBody(promptArgs: readonly string[]): string {
  // 파일 포인터는 프롬프트 원문 하나다. 배열을 줄바꿈으로 이어 붙이면 서로 다른 위치
  // 인자의 경계가 사라지고, 이후 호출자가 promptArgs에 인자를 더 넣어도 조용히 본문이 된다.
  if (promptArgs.length !== 1) {
    throw new Error(`Launch prompt file conversion expects a single positional prompt, got ${promptArgs.length}`);
  }
  return promptArgs[0]!;
}

function chmodBestEffort(targetPath: string, mode: number): void {
  try {
    chmodSync(targetPath, mode);
  } catch {
    // POSIX 권한을 지원하지 않는 파일시스템에서는 best-effort로 둔다.
  }
}

function rmBestEffort(targetPath: string): void {
  try {
    rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // 세션 정리는 파일이 이미 사라진 경우에도 전체 shutdown을 막지 않는다.
  }
}

function buildAgentCliArgs(
  builderId: "claude",
  context: AgentCliInjectionContext,
): string[] {
  return buildClaudeGatewayArgs(context);
}

function mergeAgentCliArgs(
  profile: AgentCliProfile,
  _builderId: "claude",
  _context: AgentCliInjectionContext,
  injectedArgs: readonly string[],
): string[] {
  // 위치 인자는 모든 플래그 뒤에 와야 한다 — `--mcp-config`가 가변 인자라 앞에 두면 삼켜진다.
  return [...profile.args, ...injectedArgs, ...(profile.promptArgs ?? [])];
}

function createOnceCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}
