import path from "node:path";
import { assertClaudeGatewayInput } from "./input.js";

import { withLoopbackProxyBypass } from "@fleet-console/process";

import {
  CLAUDE_GATEWAY_EFFORTS,
  CLAUDE_GATEWAY_SESSION_KEYS,
  CLAUDE_GATEWAY_TURN_KEYS,
  type ClaudeGatewayAgentDefinition,
  type ClaudeGatewayCanUseTool,
  type ClaudeGatewayCompactEvent,
  type ClaudeGatewayCwdObservation,
  type ClaudeGatewayHookContext,
  type ClaudeGatewayHostHooks,
  type ClaudeModelResolution,
  type ClaudeGatewayMessage,
  type ClaudeGatewayRun,
  type ClaudeGatewayServedMcpServer,
  type ClaudeGatewaySdk,
  type ClaudeGatewaySdkOptions,
  type ClaudeGatewaySession,
  type ClaudeGatewaySessionRequest,
  type ClaudeGatewaySubagentHookInput,
  type ClaudeGatewaySystemPrompt,
  type ClaudeGatewayTaskEvent,
  type ClaudeGatewayTurn,
} from "./contracts.js";

import { createIsolatedClaudeConfigDir, createPersistentClaudeConfigHome, createSharedClaudeConfigHome } from "./config-dir.js";
import { claudeGatewayLaunchEnv } from "./launch-env.js";
import { runVendorQuery, runVendorSession } from "./vendor-sdk.js";
import { toVendorProcessSpawner } from "./process-spawn.js";

type AcceptedModel = ClaudeModelResolution;

/**
 * core-ai-gateway의 모델 카탈로그 위에서 도는 Claude Agent SDK를 만든다.
 *
 * 이 패키지는 HTTP listener를 만들지 않는다. 호스트가 `createAiGatewayRouter`를 서빙한 뒤 그
 * 주소를 `baseUrl`로 넘긴다. 값이 없으면 Anthropic 공개 endpoint로 조용히 내려가지 않고 거부한다.
 */
export async function createClaudeGatewaySdk(
  options: ClaudeGatewaySdkOptions,
): Promise<ClaudeGatewaySdk> {
  if (options.executablePath !== undefined && (typeof options.executablePath !== "string" || !path.isAbsolute(options.executablePath) || options.executablePath.includes("\0"))) {
    throw new TypeError("executablePath must be an absolute executable path.");
  }
  if (options.modelAutoCompactWindows !== undefined) {
    for (const [id, window] of Object.entries(options.modelAutoCompactWindows)) {
      if (id.length === 0 || !Number.isSafeInteger(window) || window < 100_000 || window > 1_000_000) {
        throw new TypeError("modelAutoCompactWindows entries must be non-empty model ids mapped to integers from 100000 to 1000000.");
      }
    }
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const accepted = resolveModels(options.models, options.modelPolicy.resolve);
  // 캐시는 카탈로그 별칭을 유효하게 만드는 장치다. 네이티브 모델은 실을 것이 없다.
  const catalogModels = accepted
    .flatMap((entry) => entry.discovery ? [entry.discovery] : []);
  const inherited = options.env ?? process.env;

  const configDir = options.home?.kind === "shared"
    ? createSharedClaudeConfigHome(options.home.configDir)
    : options.home?.kind === "persistent"
      ? await createPersistentClaudeConfigHome(options.home.configDir)
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
    // 자식은 게이트웨이와 플러그인 zip을 루프백에서 부른다. 사용자 프록시가 그 요청을 삼키지 않게 한다.
    return withLoopbackProxyBypass(claudeGatewayLaunchEnv(inherited, {
      baseUrl,
      configDir: configDir.path,
      homeKind: options.home?.kind === "shared" ? "shared" : "isolated",
    }));
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
    env: options.autoMemoryEnabled === undefined ? env : { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: options.autoMemoryEnabled ? "0" : "1" },
    model,
    ...(options.executablePath === undefined ? {} : { pathToClaudeCodeExecutable: options.executablePath }),
    ...(request.systemPrompt === undefined
      ? {}
      : { systemPrompt: vendorSystemPrompt(request.systemPrompt) }),
    // 패키지가 스스로 지어내는 지시는 없다 — 여기 실리는 것은 전부 호출자가 고른 것이고,
    // 고르지 않으면 아무것도 붙지 않는다. 두 기본값이 그 규율을 구조로 만든다:
    // `settingSources: []`가 사용자·프로젝트 설정과 CLAUDE.md를 끄고, `strictMcpConfig`가
    // 그와 별개인 ambient .mcp.json·플러그인 MCP를 막는다.
    settingSources: options.settingSources ? [...options.settingSources] : [],
    strictMcpConfig: options.allowAmbientMcpServers !== true,
    // `--settings`와 같은 자리다. flag 소스로 병합되므로 사용자·프로젝트 설정을 대체하지 않는다.
    // 명시한 키만 연다 — settings 전체를 열면 호출자가 쓰지 않은 지시가 들어온다.
    ...vendorFlagSettings(options),
    // 훅과 에이전트 정의도 인스턴스가 소유한다. 세션마다 새 인스턴스를 만들므로 세션별 정책이
    // 그대로 반영되고, turn 요청의 allowlist는 넓어지지 않는다.
    ...(options.agents === undefined ? {} : { agents: vendorAgents(options.agents) }),
    ...(options.hooks === undefined ? {} : { hooks: vendorHostHooks(options.hooks) }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.additionalDirectories === undefined ? {} : { additionalDirectories: [...request.additionalDirectories] }),
    ...(request.resume === undefined ? {} : { resume: request.resume }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.forkSession === undefined ? {} : { forkSession: request.forkSession }),
    ...(request.persistSession === undefined ? {} : { persistSession: request.persistSession }),
    // SDK에 필드가 없는 세션 이름을 CLI 인자로 싣는다. 임의 인자 통로(`extraArgs`)는 계약에
    // 열지 않고 이 한 키만 옮긴다.
    ...vendorExtraArgs(request.sessionName),
    ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
    ...(request.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: request.maxBudgetUsd }),
    ...(request.outputFormat === undefined ? {} : { outputFormat: request.outputFormat }),
    ...(request.tools === undefined ? {} : { tools: [...request.tools] }),
    ...(request.allowedTools === undefined ? {} : { allowedTools: [...request.allowedTools] }),
    ...(request.disallowedTools === undefined ? {} : { disallowedTools: [...request.disallowedTools] }),
    ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
    ...(request.canUseTool === undefined ? {} : { canUseTool: vendorCanUseTool(request.canUseTool) }),
    ...(request.mcpServers === undefined && request.servedMcpServers === undefined && request.externalMcpServers === undefined
      ? {}
      : { mcpServers: vendorMcpServers(request) }),
    ...(request.plugins === undefined || request.plugins.length === 0
      ? {}
      : { plugins: request.plugins.map((plugin) => ({ type: "local" as const, path: plugin.path, ...(plugin.skipMcp ? { skipMcpDiscovery: true } : {}) })) }),
    ...(request.includePartialMessages === undefined
      ? {}
      : { includePartialMessages: request.includePartialMessages }),
    ...(request.abortController === undefined ? {} : { abortController: request.abortController }),
    ...(request.stderr === undefined ? {} : { stderr: request.stderr }),
    ...(options.spawnProcess === undefined ? {} : { spawnClaudeCodeProcess: toVendorProcessSpawner(options.spawnProcess, request.stderr) }),
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
        assertClaudeGatewayInput(turn.prompt);
        const model = resolveTurnModel(turn.model, accepted, options.modelPolicy.resolve);
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
                else notifyTaskEvent(options.onTaskEvent, result.value);
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
        const model = resolveTurnModel(request.model, accepted, options.modelPolicy.resolve);
        const env = await prepareLaunch();
        // 기동 준비를 기다리는 사이 dispose가 슬롯을 거뒀으면 자식을 띄우지 않는다 — 띄운 뒤 닫으면
        // 그 짧은 순간 같은 Claude 세션을 이어 쓰는 다음 필자와 겹친다.
        if (active !== reservation) throw new Error("This Claude gateway SDK instance has been disposed.");
        const session = runVendorSession({ options: vendorRunOptions(request, model, env) });

        // 세션의 슬롯은 `close()`로만 돌아온다. 턴과 달리 스트림이 스스로 끝나지 않기 때문이며,
        // 자식이 먼저 죽어 스트림이 끝나는 경우에도 소유자가 close를 부르는 것이 정상 경로다.
        const tracked: ClaudeGatewaySession = {
          send: (text, options) => session.send(text, options),
          interrupt: () => session.interrupt(),
          stopTask: (taskId) => session.stopTask(taskId),
          backgroundTasks: (toolUseId) => session.backgroundTasks(toolUseId),
          getContextUsage: () => session.getContextUsage(),
          supportedCommands: () => session.supportedCommands(),
          supportedAgents: () => session.supportedAgents(),
          reloadSkills: () => session.reloadSkills(),
          // 시작 모델과 같은 판정을 거친다. 격리 홈은 이 인스턴스의 모델만 discovery 캐시에 실으므로
          // 그 밖의 게이트웨이 별칭은 자식이 알지 못한다 — 공유 홈은 호스트가 캐시를 소유한다.
          setModel: async (model) => {
            const next = options.home?.kind === "shared"
              ? options.modelPolicy.resolve(model).id
              : resolveTurnModel(model, accepted, options.modelPolicy.resolve);
            await session.setModel(next);
          },
          applySessionSettings: (settings) => session.applySessionSettings(settings),
          [Symbol.asyncIterator]: () => observeTaskEvents(session, options.onTaskEvent)[Symbol.asyncIterator](),
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
function resolveModels(requested: readonly string[], resolveModelId: (id: string) => AcceptedModel): readonly AcceptedModel[] {
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

function resolveTurnModel(requested: string, accepted: readonly AcceptedModel[], resolveModelId: (id: string) => AcceptedModel): string {
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
  if (options.disableBundledSkills === true) settings.disableBundledSkills = true;
  if (options.claudeMdExcludes && options.claudeMdExcludes.length > 0) settings.claudeMdExcludes = [...options.claudeMdExcludes];
  if (options.autoMemoryEnabled !== undefined) settings.autoMemoryEnabled = options.autoMemoryEnabled;
  if (options.modelAutoCompactWindows && Object.keys(options.modelAutoCompactWindows).length > 0) {
    settings.modelSettings = Object.fromEntries(
      Object.entries(options.modelAutoCompactWindows).map(([id, autoCompactWindow]) => [id, { autoCompactWindow }]),
    );
  }
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
    ...(server.alwaysLoad === undefined ? {} : { alwaysLoad: server.alwaysLoad }),
  }]));
}

/**
 * 세 갈래 MCP 좌표를 vendor의 한 레코드로 모은다. 이름이 겹치면 한쪽이 조용히 덮이므로 거부한다.
 */
function vendorMcpServers(request: ClaudeGatewaySessionRequest): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...request.mcpServers };
  const add = (name: string, value: unknown) => {
    if (Object.hasOwn(merged, name)) throw new TypeError(`Duplicate MCP server name: ${name}`);
    merged[name] = value;
  };
  for (const [name, value] of Object.entries(vendorServedMcpServers(request.servedMcpServers))) add(name, value);
  for (const [name, server] of Object.entries(request.externalMcpServers ?? {})) {
    add(name, server.type === "stdio"
      ? { type: "stdio", command: server.command, ...(server.args ? { args: [...server.args] } : {}), ...(server.env ? { env: { ...server.env } } : {}) }
      : { type: server.type, url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}), ...(server.headersHelper === undefined ? {} : { headersHelper: server.headersHelper }) });
  }
  return merged;
}

function vendorExtraArgs(sessionName: string | undefined): { extraArgs?: Record<string, string> } {
  const extraArgs: Record<string, string> = {
    ...(sessionName === undefined ? {} : { name: sessionName }),
  };
  return Object.keys(extraArgs).length === 0 ? {} : { extraArgs };
}

/** `system/task_*` 하나를 좁은 좌표로 줄인다. 그 밖의 시스템 메시지는 지나간다. */
function readTaskEvent(message: ClaudeGatewayMessage): ClaudeGatewayTaskEvent | undefined {
  if (message.type !== "system") return undefined;
  const kind = message.subtype === "task_started" ? "started"
    : message.subtype === "task_updated" ? "updated"
      : message.subtype === "task_notification" ? "notification"
        : undefined;
  if (kind === undefined) return undefined;
  const taskId = message.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) return undefined;
  const context = readHookContext(message as unknown as Record<string, unknown>);
  if (context === undefined) return undefined;
  return {
    kind,
    sessionId: context.sessionId,
    taskId,
    ...(typeof message.run_id === "string" && message.run_id.length > 0 ? { runId: message.run_id } : {}),
    ...(typeof message.tool_use_id === "string" && message.tool_use_id.length > 0 ? { toolUseId: message.tool_use_id } : {}),
    ...(typeof message.subagent_type === "string" && message.subagent_type.length > 0 ? { subagentType: message.subagent_type } : {}),
    ...(message.is_backgrounded === true ? { isBackgrounded: true } : {}),
    ...(message.is_backgrounded === false ? { isBackgrounded: false } : {}),
    ...(typeof message.spawn_depth === "number" ? { spawnDepth: message.spawn_depth } : {}),
  };
}

function notifyTaskEvent(
  callback: ((event: ClaudeGatewayTaskEvent) => void) | undefined,
  message: ClaudeGatewayMessage,
): void {
  if (callback === undefined) return;
  const event = readTaskEvent(message);
  if (event === undefined) return;
  try {
    callback(event);
  } catch {
    // 고지 하나가 스트림을 끊지 않는다. 배선 실패는 호스트가 자기 로그로 남긴다.
  }
}

function observeTaskEvents(
  source: AsyncIterable<ClaudeGatewayMessage>,
  callback: ((event: ClaudeGatewayTaskEvent) => void) | undefined,
): AsyncIterable<ClaudeGatewayMessage> {
  if (callback === undefined) return source;
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeGatewayMessage> {
      for await (const message of source) {
        notifyTaskEvent(callback, message);
        yield message;
      }
    },
  };
}


/** 판정하지 못한 위임 호출의 거절 사유. 침묵이 곧 서브에이전트 실행이 되면 안 된다. */
const DELEGATION_UNDECIDED_REASON = "Fleet could not decide this delegated call. Continue the work in this session.";

/**
 * 좁은 호스트 훅을 vendor `hooks`로 옮긴다.
 *
 * 여기서 만드는 것은 콜백뿐이다 — 외부 프로세스를 세우지 않으므로 이벤트마다 node를 띄우던
 * 비용이 없고, 훅이 보는 입력과 돌려줄 수 있는 출력도 이 패키지가 정한 좁은 모양으로 잘린다.
 */
function vendorHostHooks(hooks: ClaudeGatewayHostHooks): Record<string, unknown> {
  const events: Record<string, unknown[]> = {};
  const add = (event: string, matcher: Record<string, unknown>): void => {
    (events[event] ??= []).push(matcher);
  };

  const preToolUse = hooks.preToolUse;
  if (preToolUse) {
    // 위임 가드는 판정 실패를 허용으로 접지 않는다. vendor는 onFailure를 차단으로 옮긴다.
    add("PreToolUse", {
      matcher: "Agent|Task",
      onFailure: "block",
      hooks: [async (input: unknown) => decidePreToolUse(preToolUse, input)],
    });
  }

  const sessionContext = hooks.sessionContext;
  const observeCwd = hooks.observeCwd;
  if (sessionContext || observeCwd) {
    add("SessionStart", {
      hooks: [async (input: unknown) => {
        if (observeCwd) observeCwdFromHook(input, observeCwd, "session_start");
        return sessionStartOutput(sessionContext?.());
      }],
    });
  }
  if (observeCwd) {
    add("UserPromptSubmit", { hooks: [async (input: unknown) => observeAndContinue(input, observeCwd, "user_prompt_submit")] });
    add("Stop", { hooks: [async (input: unknown) => observeAndContinue(input, observeCwd, "stop")] });
    add("CwdChanged", { hooks: [async (input: unknown) => observeAndContinue(input, observeCwd, "cwd_changed")] });
    add("PostToolUse", {
      matcher: "EnterWorktree|ExitWorktree",
      hooks: [async (input: unknown) => observeAndContinue(input, observeCwd, "worktree")],
    });
  }

  const compact = hooks.compact;
  if (compact) {
    add("PreCompact", { matcher: "manual|auto", hooks: [async (input: unknown) => { recordCompactEvent(compact, "pre", input); return { continue: true }; }] });
    add("PostCompact", { matcher: "manual|auto", hooks: [async (input: unknown) => { recordCompactEvent(compact, "post", input); return { continue: true }; }] });
  }

  const subagentStart = hooks.subagentStart;
  if (subagentStart) {
    add("SubagentStart", { hooks: [async (input: unknown) => { const event = readSubagentHookInput(input); if (event) subagentStart(event); return { continue: true }; }] });
  }
  const subagentStop = hooks.subagentStop;
  if (subagentStop) {
    add("SubagentStop", { hooks: [async (input: unknown) => { const event = readSubagentHookInput(input); if (event) subagentStop(event); return { continue: true }; }] });
  }

  return events;
}

/** 호스트 정의를 vendor `agents`로 옮긴다. 이 패키지가 여는 필드는 넷뿐이다. */
function vendorAgents(agents: Readonly<Record<string, ClaudeGatewayAgentDefinition>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, {
    description: agent.description,
    prompt: agent.prompt,
    ...(agent.model === undefined ? {} : { model: agent.model }),
  }]));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** vendor 훅 입력에서 이 패키지가 호스트에 넘기는 다섯 좌표만 꺼낸다. */
function readHookContext(record: Record<string, unknown>): ClaudeGatewayHookContext | undefined {
  const sessionId = record.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return {
    sessionId,
    ...(typeof record.agent_id === "string" && record.agent_id.length > 0 ? { agentId: record.agent_id } : {}),
    ...(typeof record.agent_type === "string" && record.agent_type.length > 0 ? { agentType: record.agent_type } : {}),
    ...(typeof record.prompt_id === "string" && record.prompt_id.length > 0 ? { promptId: record.prompt_id } : {}),
  };
}

function readSubagentHookInput(input: unknown): ClaudeGatewaySubagentHookInput | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  const context = readHookContext(record);
  if (!context || context.agentId === undefined || context.agentType === undefined) return undefined;
  return { ...context, agentId: context.agentId, agentType: context.agentType };
}

async function decidePreToolUse(
  callback: NonNullable<ClaudeGatewayHostHooks["preToolUse"]>,
  input: unknown,
): Promise<unknown> {
  const record = asRecord(input);
  const context = record === undefined ? undefined : readHookContext(record);
  const toolName = record?.tool_name;
  const toolUseId = record?.tool_use_id;
  if (!context || typeof toolName !== "string" || typeof toolUseId !== "string") return { continue: true };
  const toolInput = asRecord(record?.tool_input) ?? {};
  let decision: Awaited<ReturnType<typeof callback>>;
  try {
    decision = await callback({ ...context, toolName, toolUseId, toolInput });
  } catch {
    return denyPreToolUse(DELEGATION_UNDECIDED_REASON);
  }
  if (decision?.denyReason !== undefined) {
    return denyPreToolUse(decision.denyReason.length > 0 ? decision.denyReason : DELEGATION_UNDECIDED_REASON);
  }
  const updated: Record<string, unknown> = {};
  // `Agent` 도구 입력의 `effort`가 받는 값만 싣는다. 훅이 다른 값을 돌려주면 그 필드를 건드리지 않는다.
  if (decision?.effort !== undefined && CLAUDE_GATEWAY_EFFORTS.includes(decision.effort)) updated.effort = decision.effort;
  if (decision?.subagentType !== undefined && decision.subagentType.length > 0) updated.subagent_type = decision.subagentType;
  const stripModel = decision?.stripModel === true;
  const merged: Record<string, unknown> = { ...toolInput, ...updated };
  // 라우팅 대상으로 바꿀 때는 자식이 붙인 alias를 지운다. 남으면 정의의 모델을 덮는다.
  if (stripModel) delete merged.model;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(Object.keys(updated).length === 0 && !stripModel ? {} : { updatedInput: merged }),
    },
  };
}

function denyPreToolUse(reason: string): unknown {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function sessionStartOutput(context: string | undefined): unknown {
  const text = context?.trim();
  return text !== undefined && text.length > 0
    ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }
    : { continue: true };
}

function observeAndContinue(
  input: unknown,
  observe: NonNullable<ClaudeGatewayHostHooks["observeCwd"]>,
  event: ClaudeGatewayCwdObservation["event"],
): unknown {
  observeCwdFromHook(input, observe, event);
  return { continue: true };
}

/**
 * 위치 관찰 하나를 호스트에 넘긴다. 서브에이전트의 cwd는 상위 Objective의 위치가 아니므로
 * 메인 스레드 관찰만 옮긴다 — 명령 훅 시절의 판정과 같다.
 */
function observeCwdFromHook(
  input: unknown,
  observe: NonNullable<ClaudeGatewayHostHooks["observeCwd"]>,
  event: ClaudeGatewayCwdObservation["event"],
): void {
  const record = asRecord(input);
  if (!record) return;
  const context = readHookContext(record);
  if (!context || context.agentId !== undefined) return;
  const raw = event === "cwd_changed" ? record.new_cwd : record.cwd;
  if (typeof raw !== "string" || !path.isAbsolute(raw)) return;
  observe({ event, sessionId: context.sessionId, cwd: raw });
}

function recordCompactEvent(
  callback: NonNullable<ClaudeGatewayHostHooks["compact"]>,
  phase: ClaudeGatewayCompactEvent["phase"],
  input: unknown,
): void {
  const record = asRecord(input);
  if (!record) return;
  const context = readHookContext(record);
  if (!context) return;
  callback({
    phase,
    sessionId: context.sessionId,
    ...(typeof record.trigger === "string" ? { trigger: record.trigger } : {}),
    ...(typeof record.custom_instructions === "string" ? { customInstructions: record.custom_instructions } : {}),
    ...(typeof record.compact_summary === "string" ? { summary: record.compact_summary } : {}),
  });
}
