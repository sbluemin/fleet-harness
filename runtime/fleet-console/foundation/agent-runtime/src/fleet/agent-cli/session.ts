import { randomUUID } from "node:crypto";

import type { ClaudeGatewaySystemPrompt } from "../../claude/index.js";

import { buildClaudeDenyRules } from "./claude-agent-rules.js";
import { GATEWAY_DISABLED_CLAUDE_SKILLS, buildDisabledSkillOverrides, type ClaudeSkillOverride } from "./gateway-skills.js";
import type { AgentCliPlugin, ClaudeSessionCoordinate, FleetHookExec } from "./types.js";

/**
 * 이 런치가 여는 Claude 세션이 어디서 시작하는가.
 *
 * `new`와 `fork`는 Fleet이 세션 id를 발급해 자식에게 **못박는다**(CLI `--session-id`,
 * SDK `options.sessionId`). 자식이 만든 id를 나중에 받아 적는 것이 아니라 우리가 정하므로,
 * 런치 시점에 이미 그 세션의 좌표를 안다 — 실측: 그 턴이 인증 실패로 끝나도 트랜스크립트는
 * 못박은 id로 앉는다.
 *
 * `resume`만 id를 고를 수 없다. 자식이 거부한다(실측: `--session-id can only be used with
 * --continue or --resume if --fork-session is also specified`). 이어 붙이는 세션의 id는
 * 이미 트랜스크립트가 말하고 있으므로 그것을 그대로 쓴다.
 */
export type ClaudeSessionOrigin =
  | { readonly kind: "new"; readonly preferredSessionId?: string }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "fork"; readonly from: string; readonly preferredSessionId?: string }
  /** 좌표를 호출자의 argv가 이미 들고 있다. Fleet은 세션 플래그를 싣지 않는다. */
  | { readonly kind: "external" };

export type { ClaudeSessionCoordinate } from "./types.js";

/** `createClaudeGatewaySdk` 옵션에 그대로 펼치는 몫. */
export interface ClaudeSessionSdkOptions {
  /** 자식이 받아 갈 Fleet 플러그인 zip 주소. CLI 표면의 `--plugin-url`과 같은 값이다. */
  readonly pluginUrl: string;
  readonly settingSources: readonly ("user" | "project" | "local")[];
  readonly allowAmbientMcpServers: boolean;
  readonly cwdHook?: { readonly command: string; readonly args: readonly string[] };
  readonly skillOverrides?: Readonly<Record<string, ClaudeSkillOverride>>;
}

/** `startSession`/`startTurn` 요청에 그대로 펼치는 몫. */
export interface ClaudeSessionSdkRequest {
  readonly sessionId?: string;
  readonly resume?: string;
  readonly forkSession?: boolean;
  readonly permissionMode: "bypassPermissions";
  readonly systemPrompt?: ClaudeGatewaySystemPrompt;
  /** 옵트아웃한 내장 서브에이전트의 `Agent(<name>)` 규칙. 비어 있으면 키를 싣지 않는다. */
  readonly disallowedTools?: readonly string[];
}

export interface ClaudeSessionSdkProjection {
  readonly options: ClaudeSessionSdkOptions;
  readonly request: ClaudeSessionSdkRequest;
}

export interface ClaudeSessionHandle {
  readonly sessionId: string;
  readonly coordinate: ClaudeSessionCoordinate;
  /** 이 세션이 실을 Fleet 플러그인 zip 주소. */
  readonly pluginUrl: string;
  readonly skillOverrides?: Readonly<Record<string, ClaudeSkillOverride>>;
  readonly claudeCodeSystemPrompt: "on" | "append" | "off";
  /** 이 세션에서 끈 내장 서브에이전트 이름들. 생략은 전부 남는다는 뜻이다. */
  readonly claudeCodeDisabledAgents?: readonly string[];
  /** 이 세션에서 뺀 도구 이름들. 생략은 뺀 것이 없다는 뜻이다. */
  readonly claudeCodeDisabledTools?: readonly string[];
  /** Chat Mode처럼 SDK로 자식을 세우는 표면이 그대로 펼쳐 쓰는 투영. */
  readonly sdk: ClaudeSessionSdkProjection;
}

export interface PrepareClaudeSessionOptions {
  readonly cliId: string;
  readonly cwd: string;
  /**
   * 호스트가 기동에 한 번 렌더해 둔 플러그인 트리. 세션마다 다시 렌더하지 않는다 — 내용이
   * 같아 디스크는 그대로지만, 매 런치가 저장소 락을 잡고 트리 전체를 다시 읽는 비용은 남고,
   * 여러 Operation을 동시에 여는 순간 그 락에서 직렬화된다.
   */
  readonly plugin: AgentCliPlugin;
  /** SDK 표면의 cwd 훅. 트리에 실리지 않고 세션 투영에만 들어간다. */
  readonly workspaceHookExec?: FleetHookExec;
  readonly origin: ClaudeSessionOrigin;
  /**
   * 이 세션의 시스템 프롬프트를 무엇으로 세울지. 생략하면 `on`.
   *
   * 두 표면의 표현이 서로 뒤집혀 있다 — CLI는 기본 프롬프트를 쓸 때 아무 플래그도 싣지
   * 않고, SDK는 반대로 그때 `{ mode: "preset" }`을 실어야 한다. SDK에서 `systemPrompt`를
   * 생략하면 기본 프롬프트가 실리는 것이 아니라 최소 프롬프트가 된다(실측: 턴당 총 입력
   * 토큰 생략 18,272 / preset 24,632). 그 사상을 호스트가 각자 하면 한쪽만 따라온다.
   */
  readonly claudeCodeSystemPrompt?: "on" | "append" | "off";
  /**
   * 사용자가 쓴 시스템 프롬프트 본문. `append`면 기본 프롬프트 뒤에 잇고, `off`면 이 글이
   * 시스템 프롬프트 전체가 된다. 비어 있으면 두 모드 모두 본문 없이 해석된다.
   */
  readonly claudeCodeCustomSystemPrompt?: string;
  /**
   * 이 세션에서 끌 Claude Code 내장 서브에이전트 이름들. 생략·빈 목록이면 전부 남는다.
   * 두 표면이 같은 규칙을 받는다 — CLI는 `--settings`의 `permissions.deny`, SDK는
   * `disallowedTools`로, 철자는 `claude-agent-rules.ts`가 소유한다.
   */
  readonly claudeCodeDisabledAgents?: readonly string[];
  /**
   * 이 세션에서 뺄 도구 이름들(예: `AskUserQuestion`). 무엇을 뺄지는 호출자 정책이다. 서브에이전트 규칙과 합쳐
   * CLI는 `permissions.deny`, SDK는 `disallowedTools`로 같은 목록이 실린다.
   */
  readonly claudeCodeDisabledTools?: readonly string[];
}

/**
 * 호스트가 세션 하나를 열기 위해 필요한 모든 것을 admiral이 확정해 돌려준다.
 *
 * 이 함수는 프로세스를 세우지 않는다 — 프로세스 수명은 런타임 호스트의 것이다. 대신 그
 * 세션의 **정체성과 능력 표면**을 여기서 한 번만 정한다: 세션 id, 플러그인 트리, 스킬 억제,
 * 시스템 프롬프트 정책, 설정 층. 이것들이 표면마다 따로 조립되면 같은 Operation을 터미널로
 * 열었을 때와 Chat으로 열었을 때가 조용히 다른 세션이 된다.
 */
export async function prepareClaudeSession(
  options: PrepareClaudeSessionOptions,
): Promise<ClaudeSessionHandle> {
  const coordinate = resolveSessionCoordinate(options.origin);
  const claudeCodeSystemPrompt = options.claudeCodeSystemPrompt ?? "on";
  const claudeCodeDisabledAgents = [...new Set(options.claudeCodeDisabledAgents ?? [])];
  const claudeCodeDisabledTools = [...new Set(options.claudeCodeDisabledTools ?? [])];
  const denyRules = buildClaudeDenyRules(claudeCodeDisabledAgents, claudeCodeDisabledTools);
  const skillOverrides = buildDisabledSkillOverrides(GATEWAY_DISABLED_CLAUDE_SKILLS);
  const pluginUrl = await options.plugin.url();
  return {
    sessionId: coordinate.sessionId,
    coordinate,
    pluginUrl,
    ...(skillOverrides ? { skillOverrides } : {}),
    claudeCodeSystemPrompt,
    ...(claudeCodeDisabledAgents.length > 0 ? { claudeCodeDisabledAgents } : {}),
    ...(claudeCodeDisabledTools.length > 0 ? { claudeCodeDisabledTools } : {}),
    sdk: {
      options: {
        pluginUrl,
        // 터미널로 열었을 때 CLI가 읽는 층을 그대로 읽어야 한 세션의 두 얼굴이 된다 —
        // 리포의 `CLAUDE.md`와 사용자 설정을 표면에 따라 잃지 않는다.
        settingSources: ["user", "project", "local"],
        allowAmbientMcpServers: true,
        ...(options.workspaceHookExec ? { cwdHook: options.workspaceHookExec } : {}),
        ...(skillOverrides ? { skillOverrides } : {}),
      },
      request: {
        ...toSdkSessionCoordinate(coordinate),
        // SDK 표면은 사용자의 승인 게이트 선택을 따르지 않는다 — 따를 수 없어서다. 채팅
        // 세션의 `canUseTool`은 권한 게이트가 아니라 질문 통로이고, 그 집합 밖의 도구는
        // 콜백 첫 줄에서 그대로 허용된다. 여기서 모드만 내리면 화면은 승인제라고 말하고
        // 실제로는 전부 통과하므로, 그 게이트가 실제로 설 때까지 이 값은 bypass로 남는다.
        permissionMode: "bypassPermissions",
        // 사용자가 고른 구성을 SDK 어휘로 옮긴다. 실리는 본문은 전부 사용자가 쓴 것이다.
        ...buildSdkSystemPrompt(claudeCodeSystemPrompt, options.claudeCodeCustomSystemPrompt),
        // 옵트아웃한 내장 서브에이전트와 뺀 도구는 SDK 표면에서도 같은 목록으로 빠진다. 실측(SDK 0.3.269):
        // `canUseTool`이 대화형 도구를 싣더라도 여기 적힌 `AskUserQuestion`은 init 도구 목록에서 빠진다.
        ...(denyRules.length > 0 ? { disallowedTools: denyRules } : {}),
      },
    },
  };
}

/**
 * 사용자가 고른 구성을 SDK의 `systemPrompt` 모양으로 옮긴다.
 *
 * CLI와 대칭이 아닌 두 지점이 여기서 갈린다. 첫째, 이 표면에서 필드를 **생략**하는 것은
 * 기본 프롬프트를 싣는다는 뜻이 아니라 최소 프롬프트로 연다는 뜻이다 — 그래서 `on`은
 * 생략이 아니라 `preset`이어야 하고, 기본 프롬프트를 원하지 않는 `off`가 생략 쪽이다.
 * 둘째, `replace`·`append`의 본문은 비어 있을 수 없다(vendor가 `TypeError`로 거절한다).
 * CLI가 `--system-prompt ""`로 표현하는 "프롬프트 없음"을 이 표면에서는 생략이 맡는다.
 */
function buildSdkSystemPrompt(
  claudeCodeSystemPrompt: "on" | "append" | "off",
  customSystemPrompt: string | undefined,
): { systemPrompt?: ClaudeGatewaySystemPrompt } {
  const text = customSystemPrompt === undefined || customSystemPrompt.length === 0 ? undefined : customSystemPrompt;
  if (claudeCodeSystemPrompt === "off") {
    return text === undefined ? {} : { systemPrompt: { mode: "replace", text } };
  }
  if (claudeCodeSystemPrompt === "append" && text !== undefined) {
    return { systemPrompt: { mode: "append", text } };
  }
  return { systemPrompt: { mode: "preset" } };
}

/**
 * 세션 id를 확정한다.
 *
 * `preferredSessionId`는 호출자가 이 세션에 붙이고 싶은 값이다 — Console은 Operation id를
 * 넘겨 Operation과 Claude 세션의 좌표를 태어날 때 하나로 만든다. 쓸 수 없는 값이면 조용히
 * 새로 발급하고, 실제로 쓰인 값은 핸들의 `sessionId`가 말한다. 호출자가 그 값을 되받아 적으면
 * 어긋날 방법이 없다.
 */
function resolveSessionCoordinate(origin: ClaudeSessionOrigin): ClaudeSessionCoordinate {
  // 자식이 어떤 세션을 열지 우리는 모른다. 외부 좌표도 핸들 식별에는 독립 id가 필요하다.
  if (origin.kind === "external") return { kind: "external", sessionId: randomUUID() };
  if (origin.kind === "resume") {
    // 이어 붙이는 세션의 id는 트랜스크립트가 이미 정해 놓은 값이다 — 고를 수 없다.
    return { kind: "resume", sessionId: origin.sessionId };
  }
  // 새 세션과 갈래만 우리가 못박고, 그때는 UUID여야 한다 — 자식이 그것만 받는다.
  const sessionId = origin.preferredSessionId !== undefined && isClaudeSessionUuid(origin.preferredSessionId)
    ? origin.preferredSessionId
    : randomUUID();
  if (origin.kind === "fork") return { kind: "fork", sessionId, from: origin.from };
  return { kind: "new", sessionId };
}

/** Claude가 `--session-id`/`options.sessionId`로 받아 주는 형태. 그 밖의 값은 자식이 거부한다. */
function isClaudeSessionUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function toSdkSessionCoordinate(
  coordinate: ClaudeSessionCoordinate,
): Pick<ClaudeSessionSdkRequest, "sessionId" | "resume" | "forkSession"> {
  switch (coordinate.kind) {
    case "external":
      return {};
    case "resume":
      return { resume: coordinate.sessionId };
    case "fork":
      return { resume: coordinate.from, sessionId: coordinate.sessionId, forkSession: true };
    default:
      return { sessionId: coordinate.sessionId };
  }
}
