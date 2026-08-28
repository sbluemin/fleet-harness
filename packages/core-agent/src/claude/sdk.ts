import {
  GATEWAY_MODEL_ALIAS_PREFIX,
  findGatewayModel,
  toClaudeGatewayModelId,
  type GatewayModel,
} from "@dotobokuri/core-ai-gateway";

import {
  CLAUDE_GATEWAY_SESSION_KEYS,
  CLAUDE_GATEWAY_TURN_KEYS,
  type ClaudeGatewayCanUseTool,
  type ClaudeGatewayMessage,
  type ClaudeGatewayRun,
  type ClaudeGatewayServedMcpServer,
  type ClaudeGatewaySdk,
  type ClaudeGatewaySdkOptions,
  type ClaudeGatewaySession,
  type ClaudeGatewaySessionRequest,
  type ClaudeGatewaySystemPrompt,
  type ClaudeGatewayTurn,
} from "./contracts.js";

import { createIsolatedClaudeConfigDir, createSharedClaudeConfigHome } from "./config-dir.js";
import { claudeGatewayLaunchEnv } from "./launch-env.js";
import { runVendorQuery, runVendorSession } from "./vendor-sdk.js";

/**
 * 이 인스턴스가 실행을 허용하는 모델 하나.
 *
 * 카탈로그 모델만 discovery 캐시에 실린다. 네이티브 Anthropic 모델은 캐시가 광고하지 않아도
 * 게이트웨이가 원문 중계하며 자식도 받아들인다 — 카탈로그 항목이 하나도 없는 캐시로도 통과하는
 * 것을 실측했다.
 */
/** 자식이 스스로 구체 id로 푸는 vendor 모델 별칭. [1m] 좌표도 별칭이다 — Console 제품 축의
    opus[1m]이 빠져 있으면 게이트웨이 생성 시점에 거부돼, 자식이 받아 줄 모델이 오타 취급된다. */
const NATIVE_MODEL_ALIASES = new Set(["sonnet", "opus", "opus[1m]", "haiku", "fable", "fable[1m]"]);

type AcceptedModel =
  | { readonly kind: "catalog"; readonly id: string; readonly model: GatewayModel }
  | { readonly kind: "native"; readonly id: string };

/**
 * core-ai-gateway의 모델 카탈로그 위에서 도는 Claude Agent SDK를 만든다.
 *
 * 이 패키지는 HTTP listener를 만들지 않는다. 호스트가 `createAiGatewayRouter`를 서빙한 뒤 그
 * 주소를 `baseUrl`로 넘긴다. 값이 없으면 Anthropic 공개 endpoint로 조용히 내려가지 않고 거부한다.
 */
export async function createClaudeGatewaySdk(
  options: ClaudeGatewaySdkOptions,
): Promise<ClaudeGatewaySdk> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const accepted = resolveModels(options.models);
  // 캐시는 카탈로그 별칭을 유효하게 만드는 장치다. 네이티브 모델은 실을 것이 없다.
  const catalogModels = accepted
    .filter((entry): entry is Extract<AcceptedModel, { kind: "catalog" }> => entry.kind === "catalog")
    .map((entry) => entry.model);
  const inherited = options.env ?? process.env;

  const configDir = options.home?.kind === "shared"
    ? createSharedClaudeConfigHome(options.home.configDir)
    : await createIsolatedClaudeConfigDir(options.tempRoot);
  let disposed = false;
  // 슬롯 하나를 턴과 세션이 함께 쓴다. 담기는 것이 무엇이든 이 인스턴스가 접을 수 있어야 하므로
  // 필요한 능력만 붙들고, 나머지는 각자의 계약이 갖는다.
  let active: { close(): void } | null = null;

  /**
   * 자식을 세우기 **전에** 슬롯을 잡는다.
   *
   * 검사와 예약 사이에 `await`가 있으면 배타는 없는 것과 같다: 두 호출자가 나란히 빈 슬롯을 보고
   * 둘 다 준비 단계에서 양보한 뒤, 같은 config dir 위에 자식을 하나씩 세운다. 나중 대입이 앞의
   * 것을 가려 `dispose()`도 그것을 접지 못한다. 그래서 자리표시자를 먼저 앉히고, 실제 핸들이
   * 생기면 갈아 끼운다 — 실패하면 앉힌 자리를 돌려준다.
   */
  const reserveSlot = (kind: "turn" | "session"): { close(): void } => {
    if (disposed) throw new Error("This Claude gateway SDK instance has been disposed.");
    if (active) {
      throw new Error(kind === "turn"
        ? "A turn is already running on this instance. Await it, or create another instance."
        : "A turn or session is already running on this instance. Close it, or create another instance.");
    }
    // 이 자리표시자가 접히는 경우는 예약과 자식 생성 사이의 dispose 하나뿐이다. 접을 자식이
    // 아직 없으므로 하는 일도 없지만, 슬롯의 계약(닫을 수 있음)은 그 창에서도 성립해야 한다.
    const reservation = { close: (): void => undefined };
    active = reservation;
    return reservation;
  };

  /**
   * spawn 직전 준비. discovery 캐시를 다시 쓰고 자식 환경을 만든다 — 턴과 세션이 같은 준비를
   * 거쳐야 두 경로가 같은 자식을 얻는다.
   */
  const prepareLaunch = async (): Promise<ReturnType<typeof claudeGatewayLaunchEnv>> => {
    await configDir.writeModelCache({ baseUrl, models: catalogModels, fetchedAt: Date.now() });
    return claudeGatewayLaunchEnv(inherited, {
      baseUrl,
      configDir: configDir.path,
      homeKind: options.home?.kind === "shared" ? "shared" : "isolated",
    });
  };

  /**
   * 호출자가 고른 실행 정책을 vendor 옵션으로 옮긴다. 프롬프트는 여기 없다 — 턴은 문자열로,
   * 세션은 입력 스트림으로 서로 다르게 싣기 때문이다.
   */
  const vendorRunOptions = (
    request: ClaudeGatewaySessionRequest,
    model: string,
    env: ReturnType<typeof claudeGatewayLaunchEnv>,
  ): Record<string, unknown> => ({
    env,
    model,
    ...(request.systemPrompt === undefined
      ? {}
      : { systemPrompt: vendorSystemPrompt(request.systemPrompt) }),
    // 패키지가 스스로 지어내는 지시는 없다 — 여기 실리는 것은 전부 호출자가 고른 것이고,
    // 고르지 않으면 아무것도 붙지 않는다. 두 기본값이 그 규율을 구조로 만든다:
    // `settingSources: []`가 사용자·프로젝트 설정과 CLAUDE.md를 끄고, `strictMcpConfig`가
    // 그와 별개인 ambient .mcp.json·플러그인 MCP를 막는다.
    settingSources: options.settingSources ? [...options.settingSources] : [],
    strictMcpConfig: options.allowAmbientMcpServers !== true,
    // 플러그인의 MCP 선언은 읽지 않는다 — 좌표는 호출자가 이미 소유한다.
    ...(options.plugins && options.plugins.length > 0
      ? { plugins: options.plugins.map((plugin) => ({ type: "local" as const, path: plugin.path, skipMcpDiscovery: true })) }
      : {}),
    // `--settings`와 같은 자리다. flag 소스로 병합되므로 사용자·프로젝트 설정을 대체하지 않는다.
    // skillOverrides와 ultracode만 연다 — settings 전체를 열면 호출자가 쓰지 않은 지시가 들어온다.
    ...vendorFlagSettings(options),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.resume === undefined ? {} : { resume: request.resume }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.forkSession === undefined ? {} : { forkSession: request.forkSession }),
    ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
    ...(request.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: request.maxBudgetUsd }),
    ...(request.tools === undefined ? {} : { tools: [...request.tools] }),
    ...(request.allowedTools === undefined ? {} : { allowedTools: [...request.allowedTools] }),
    ...(request.disallowedTools === undefined ? {} : { disallowedTools: [...request.disallowedTools] }),
    ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
    ...(request.canUseTool === undefined ? {} : { canUseTool: vendorCanUseTool(request.canUseTool) }),
    ...(request.mcpServers === undefined && request.servedMcpServers === undefined
      ? {}
      : { mcpServers: { ...request.mcpServers, ...vendorServedMcpServers(request.servedMcpServers) } }),
    ...(request.includePartialMessages === undefined
      ? {}
      : { includePartialMessages: request.includePartialMessages }),
    ...(request.abortController === undefined ? {} : { abortController: request.abortController }),
    ...(request.stderr === undefined ? {} : { stderr: request.stderr }),
  });

  const sdk: ClaudeGatewaySdk = {
    configDir: configDir.path,
    models: Object.freeze(accepted.map((entry) => entry.id)),

    async startTurn(turn: ClaudeGatewayTurn): Promise<ClaudeGatewayRun> {
      // 한 격리 config dir을 두 자식이 동시에 쓰면 세션 상태가 서로를 덮는다. 병렬 턴이 필요하면
      // 인스턴스를 따로 만든다 — 그쪽은 디렉터리도 따로 갖는다.
      const reservation = reserveSlot("turn");
      try {
        assertKnownTurnKeys(turn);
        if (typeof turn.prompt !== "string" || turn.prompt.length === 0) {
          throw new TypeError("turn.prompt must be a non-empty string.");
        }
        const model = resolveTurnModel(turn.model, accepted);
        const env = await prepareLaunch();
        const run = runVendorQuery({
          prompt: turn.prompt,
          options: vendorRunOptions(turn, model, env),
        });

        // 슬롯은 close()로도, 스트림이 끝까지 소진되어도 돌아온다. 후자가 정상 경로다.
        const release = (): void => {
          if (active === tracked) active = null;
        };
        const tracked: ClaudeGatewayRun = {
          [Symbol.asyncIterator](): AsyncIterator<ClaudeGatewayMessage> {
            const iterator = run[Symbol.asyncIterator]();
            return {
              async next(): Promise<IteratorResult<ClaudeGatewayMessage>> {
                const result = await iterator.next();
                if (result.done === true) release();
                return result;
              },
            };
          },
          close(): void {
            try {
              run.close();
            } finally {
              release();
            }
          },
          getContextUsage: () => run.getContextUsage(),
        };
        // 준비 중에 dispose가 자리표시자를 걷어 갔다면 그 판정을 존중한다 — 자식은 여기서 접는다.
        if (active !== reservation) {
          run.close();
          throw new Error("This Claude gateway SDK instance has been disposed.");
        }
        active = tracked;
        return tracked;
      } catch (error) {
        if (active === reservation) active = null;
        throw error;
      }
    },

    async openSession(request: ClaudeGatewaySessionRequest): Promise<ClaudeGatewaySession> {
      const reservation = reserveSlot("session");
      try {
        assertKnownSessionKeys(request);
        const model = resolveTurnModel(request.model, accepted);
        const env = await prepareLaunch();
        const session = runVendorSession({ options: vendorRunOptions(request, model, env) });

        // 세션의 슬롯은 `close()`로만 돌아온다. 턴과 달리 스트림이 스스로 끝나지 않기 때문이며,
        // 자식이 먼저 죽어 스트림이 끝나는 경우에도 소유자가 close를 부르는 것이 정상 경로다.
        const tracked: ClaudeGatewaySession = {
          send: (text) => session.send(text),
          interrupt: () => session.interrupt(),
          stopTask: (taskId) => session.stopTask(taskId),
          backgroundTasks: (toolUseId) => session.backgroundTasks(toolUseId),
          getContextUsage: () => session.getContextUsage(),
          supportedCommands: () => session.supportedCommands(),
          supportedAgents: () => session.supportedAgents(),
          reloadSkills: () => session.reloadSkills(),
          [Symbol.asyncIterator]: () => session[Symbol.asyncIterator](),
          close(): void {
            try {
              session.close();
            } finally {
              if (active === tracked) active = null;
            }
          },
        };
        if (active !== reservation) {
          session.close();
          throw new Error("This Claude gateway SDK instance has been disposed.");
        }
        active = tracked;
        return tracked;
      } catch (error) {
        if (active === reservation) active = null;
        throw error;
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      active?.close();
      active = null;
      await configDir.dispose();
    },
  };

  return sdk;
}

function normalizeBaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("baseUrl is required: this package never falls back to the public Anthropic endpoint.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`baseUrl must be an absolute URL, got: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`baseUrl must be http(s), got: ${url.protocol}`);
  }
  // 캐시의 baseUrl과 자식의 ANTHROPIC_BASE_URL은 글자 단위로 같아야 한다. 정규화는 여기서 한 번만
  // 하고, 그 결과 문자열을 두 곳에 함께 쓴다. 후행 슬래시는 Claude Code가 붙이는 경로와 겹친다.
  return raw.replace(/\/+$/, "");
}

/**
 * 요청된 id를 카탈로그 모델과 네이티브 통과 모델로 가른다.
 *
 * 판정은 게이트웨이 라우터의 규칙을 그대로 옮긴 것이다: `claude-gateway--` 접두를 달고도
 * 카탈로그에 없으면 거부하고(라우터는 여기서 400을 낸다), 접두가 없으면 네이티브 Anthropic
 * 모델로 보고 통과시킨다(라우터는 호출자 자격증명으로 원문 중계한다). 판정을 라우터보다 좁히면
 * 게이트웨이가 실제로 서빙하는 모델을 이 패키지만 거부하게 된다.
 */
function resolveModels(requested: readonly string[]): readonly AcceptedModel[] {
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new TypeError("models must list at least one model id.");
  }
  const resolved: AcceptedModel[] = [];
  const seen = new Set<string>();
  for (const requestedId of requested) {
    const entry = resolveModelId(requestedId);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    resolved.push(entry);
  }
  return resolved;
}

function resolveModelId(requested: string): AcceptedModel {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new TypeError("A model id must be a non-empty string.");
  }
  const model = findGatewayModel(requested);
  // 카탈로그 모델은 항상 Claude 표기 id로 정규화한다. 호출자는 어느 표기로 불러도 된다.
  if (model) return { kind: "catalog", id: toClaudeGatewayModelId(model), model };
  if (requested.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) {
    throw new TypeError(`Unknown gateway model: ${requested}`);
  }
  // 라우터는 접두 없는 id를 전부 Anthropic으로 중계하지만, Claude Code 자신이 인정하는 것은
  // claude/anthropic 접두가 붙은 id와 아래 별칭들뿐이다. 그래서 이 조건은 도달 가능한 집합을
  // 좁히지 않으면서 — 통과시켜 봐야 자식이 거절한다 — 오타를 생성 시점에 터뜨린다.
  // 별칭은 자식이 보내기 전에 스스로 푼다: 실측하면 `sonnet`이 와이어에서 `claude-sonnet-5`가
  // 되므로, 별칭을 쓰면 버전을 고정하지 않고 현행 세대를 따라간다.
  if (!/^(claude|anthropic)/i.test(requested) && !NATIVE_MODEL_ALIASES.has(requested.toLowerCase())) {
    throw new TypeError(
      `Not a gateway alias and not a native Anthropic model: ${requested}. `
      + `Gateway models start with "${GATEWAY_MODEL_ALIAS_PREFIX}"; native models start with "claude" or "anthropic", `
      + `or are one of: ${[...NATIVE_MODEL_ALIASES].join(", ")}.`,
    );
  }
  return { kind: "native", id: requested };
}

function resolveTurnModel(requested: string, accepted: readonly AcceptedModel[]): string {
  const entry = resolveModelId(requested);
  if (!accepted.some((allowed) => allowed.id === entry.id)) {
    throw new TypeError(
      `turn.model is not one of this instance's models: ${requested}. `
      + `Allowed: ${accepted.map((allowed) => allowed.id).join(", ")}`,
    );
  }
  return entry.id;
}

/**
 * 호출자의 콜백을 vendor가 부르는 모양으로 옮긴다. vendor는 옵션 객체 하나로 여러 필드를 주지만
 * 이 패키지의 공개 어휘는 그 중 둘만 통과시킨다 — 나머지(권한 제안·차단 경로·요청 봉투 id)는
 * 권한 UI를 짓는 소비처의 것이지, 사용자에게 물어보는 이 통로의 것이 아니다.
 *
 * 콜백이 던지면 거부로 접는다. 예외를 그대로 올리면 vendor가 응답을 쓰지 못해 도구가 무기한
 * 막히는데(권한 요청에는 park deadline이 없다), 그 정지는 호출자에게 아무 신호도 남기지 않는다.
 */
function vendorCanUseTool(
  canUseTool: ClaudeGatewayCanUseTool,
): (toolName: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown> {
  return async (toolName, input, options) => {
    try {
      const decision = await canUseTool(toolName, input, {
        toolUseId: typeof options.toolUseID === "string" ? options.toolUseID : "",
        signal: options.signal instanceof AbortSignal ? options.signal : new AbortController().signal,
      });
      if (decision.behavior === "allow") {
        return decision.updatedInput === undefined
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "allow", updatedInput: { ...decision.updatedInput } };
      }
      return { behavior: "deny", message: decision.message };
    } catch (error) {
      return { behavior: "deny", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

/**
 * 호출자가 고른 flag 설정만 모은다. 빈 객체는 키 자체를 생략한다 — `{}`를 넘기면 vendor가
 * 빈 설정으로 병합해 호출자가 쓰지 않은 기본값을 심을 수 있다.
 */
function vendorFlagSettings(options: ClaudeGatewaySdkOptions): { readonly settings: Record<string, unknown> } | Record<string, never> {
  const settings: Record<string, unknown> = {};
  if (options.skillOverrides && Object.keys(options.skillOverrides).length > 0) {
    settings.skillOverrides = { ...options.skillOverrides };
  }
  if (options.ultracode === true) settings.ultracode = true;
  return Object.keys(settings).length > 0 ? { settings } : {};
}

/** 호출자가 고른 모드를 vendor가 아는 모양으로 옮긴다. 텍스트는 이 패키지가 만들지 않는다. */
function vendorSystemPrompt(
  systemPrompt: ClaudeGatewaySystemPrompt,
): string | { type: "preset"; preset: "claude_code"; append?: string } {
  // `preset`은 이어붙일 텍스트가 없는 모드다. 텍스트 검사보다 먼저 걸러야 한다.
  if (systemPrompt?.mode === "preset") return { type: "preset", preset: "claude_code" };
  const text = (systemPrompt as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("turn.systemPrompt.text must be a non-empty string.");
  }
  if (systemPrompt.mode === "replace") return text;
  if (systemPrompt.mode === "append") return { type: "preset", preset: "claude_code", append: text };
  throw new TypeError(`turn.systemPrompt.mode must be "replace", "append", or "preset", got: ${String((systemPrompt as { mode?: unknown }).mode)}`);
}

/**
 * 타입에 없는 키를 조용히 무시하지 않고 거부한다.
 *
 * TypeScript의 excess property 검사는 변수를 거쳐 들어온 객체와 JS 호출자를 잡지 못한다. 그래서
 * `systemPrompt`나 `hooks`(그 출력이 `additionalContext`와 `appendSystemPrompt`를 실어 실제 프롬프트
 * 주입 통로다)를 넘겨도 아무 신호 없이 무시될 수 있다. denylist가 아니라 allowlist인 이유는
 * SDK가 새 주입 통로를 추가해도 fail-closed로 남기 위해서다.
 */
function assertKnownTurnKeys(turn: ClaudeGatewayTurn): void {
  const unknown = Object.keys(turn).filter((key) => !CLAUDE_GATEWAY_TURN_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `Unsupported turn option(s): ${unknown.join(", ")}. `
      + "Only an instruction the caller authored may reach the child, through turn.systemPrompt; "
      + "every other instruction channel is closed, so those options do not exist.",
    );
  }
}

/** 세션도 같은 allowlist를 지난다 — 수명이 길다고 주입 통로가 넓어지지는 않는다. */
function assertKnownSessionKeys(request: ClaudeGatewaySessionRequest): void {
  const unknown = Object.keys(request).filter((key) => !CLAUDE_GATEWAY_SESSION_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `Unsupported session option(s): ${unknown.join(", ")}. `
      + "Only an instruction the caller authored may reach the child, through systemPrompt; "
      + "every other instruction channel is closed, so those options do not exist. "
      + "A session receives its prompts through send(), never as an option.",
    );
  }
}

/**
 * HTTP MCP 기술자를 vendor가 받는 모양으로 옮긴다.
 *
 * 두 가지가 여기서만 바뀐다: 헤더가 배열에서 레코드로, 타임아웃이 초에서 밀리초로. 후자를 빠뜨리면
 * vendor가 1000 미만 값을 조용히 무시해 설정한 적 없는 기본 타임아웃으로 돈다.
 */
function vendorServedMcpServers(
  servers: readonly ClaudeGatewayServedMcpServer[] | undefined,
): Record<string, unknown> {
  if (!servers?.length) return {};
  return Object.fromEntries(servers.map((server) => [server.name, {
    type: "http",
    url: server.url,
    ...(server.headers?.length ? { headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) } : {}),
    ...(server.toolTimeoutSeconds === undefined ? {} : { timeout: Math.round(server.toolTimeoutSeconds * 1000) }),
  }]));
}
