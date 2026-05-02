/**
 * admiral/_shared/agent-runtime.ts — 어드미럴 공유 에이전트 런타임
 *
 * dispatcher/provider 래퍼 없이 @sbluemin/unified-agent의 공개 클라이언트를 직접 사용합니다.
 * 풀, 세션 맵, 실행 엔진, resume 실패 분류를 단일 파일에 둡니다.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLI_BACKENDS,
  UnifiedAgent,
  getReasoningEffortLevels,
  type AcpToolCall,
  type AcpToolCallUpdate,
  type CliType,
  type ConnectResult,
  type IUnifiedAgentClient,
  type UnifiedAgentBuildOptions,
  type UnifiedClientOptions,
} from "@sbluemin/unified-agent";

import { resolveAuthEnv } from "../../services/auth/index.js";
import { getLogAPI } from "../../services/log/store.js";

// ═══════════════════════════════════════════════════════════════════════════
// 타입 / 인터페이스
// ═══════════════════════════════════════════════════════════════════════════

/** 도구 호출 추적 정보 */
export interface ToolCallInfo {
  /** 도구 호출 제목 (ACP 프로토콜의 title 필드) */
  title: string;
  /** 도구 호출 상태 (e.g., "running", "complete", "error") */
  status: string;
  /** 도구 결과 텍스트 (content/rawOutput를 평탄화한 문자열) */
  rawOutput?: string;
  /** 도구 호출 고유 ID (toolCallId 기반 추적용) */
  toolCallId?: string;
  /** 타임스탬프 */
  timestamp: number;
}

/** 연결 후 반환되는 메타 정보 */
export interface ConnectionInfo {
  protocol?: string;
  sessionId?: string;
  model?: string;
}

/** 에이전트 실행 상태 */
export type AgentStatus = "connecting" | "running" | "done" | "error" | "aborted";

/**
 * 순서가 보존된 정규화 스트림 블록.
 * 도구 호출과 응답 텍스트를 발생 순서대로 기록합니다.
 */
export type ColBlock =
  | { type: "thought"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; title: string; status: string; toolCallId?: string };

/** 칼럼(또는 run) 상태 */
export type ColStatus = "wait" | "conn" | "stream" | "done" | "err";

/** 수집된 정규화 스트리밍 데이터 */
export interface CollectedStreamData {
  text: string;
  thinking: string;
  toolCalls: { title: string; status: string }[];
  blocks: ColBlock[];
  lastStatus: AgentStatus;
}

/** executeWithPool / executeOneShot 공통 옵션 */
export interface ExecuteOptions {
  /** 고유 carrier 식별자 — 풀 키, 세션 스토어 키 */
  carrierId: string;
  /** CLI 바이너리 타입 — 실제 연결 대상 */
  cliType: CliType;
  /** 사용자 요청 텍스트 */
  request: string;
  /** 작업 디렉토리 */
  cwd: string;
  /** 명시적 모델 ID */
  model?: string;
  /** Reasoning effort 레벨 */
  effort?: string;
  /** 프롬프트 유휴 타임아웃 (ms, 미지정 시 SDK 기본값 사용) */
  promptIdleTimeout?: number;
  /** carrier 경로의 connect-time system prompt handoff */
  connectSystemPrompt?: string | null;
  /** 취소 시그널 */
  signal?: AbortSignal;
  /** 메시지 청크 스트리밍 콜백 */
  onMessageChunk?: (text: string) => void;
  /** 사고 과정 청크 스트리밍 콜백 */
  onThoughtChunk?: (text: string) => void;
  /** 도구 호출 콜백 */
  onToolCall?: (title: string, status: string, rawOutput?: string, toolCallId?: string) => void;
  /** 연결 완료 콜백 (연결 정보 전달) */
  onConnected?: (info: ConnectionInfo) => void;
  /** 상태 변경 콜백 */
  onStatusChange?: (status: AgentStatus) => void;
}

/** 실행 결과 */
export interface ExecuteResult {
  /** 에이전트 응답 텍스트 */
  responseText: string;
  /** 사고 과정 텍스트 */
  thoughtText: string;
  /** 도구 호출 목록 */
  toolCalls: ToolCallInfo[];
  /** 정규화된 스트림 데이터 */
  streamData: CollectedStreamData;
  /** 연결 정보 */
  connectionInfo: ConnectionInfo;
  /** 최종 상태 */
  status: AgentStatus;
  /** 에러 메시지 (status === "error" 시) */
  error?: string;
}

/** 풀에 보관되는 클라이언트 엔트리 */
export interface PooledClient {
  client: IUnifiedAgentClient;
  /** 현재 요청 처리 중 여부 */
  busy: boolean;
  /** 마지막으로 알려진 세션 ID (재연결 시 복원용) */
  sessionId?: string;
}

/** carrierId별 서브에이전트 sessionId 매핑 */
type SessionMap = Record<string, string>;

/** 세션 매핑 저장소 인터페이스 */
export interface SessionMapStore {
  /** 세션 시작/전환 시 기존 매핑을 복원합니다. */
  restore(piSessionId: string): void;
  /** carrierId의 서브에이전트 sessionId를 조회합니다. */
  get(carrierId: string): string | undefined;
  /** carrierId의 서브에이전트 sessionId를 저장합니다 (즉시 persist). */
  set(carrierId: string, sessionId: string): void;
  /** carrierId의 서브에이전트 sessionId를 제거합니다 (즉시 persist). */
  clear(carrierId: string): void;
  /** 현재 매핑의 읽기 전용 복사본을 반환합니다. */
  getAll(): Readonly<SessionMap>;
}

export type ResumeFailureKind =
  | "dead-session"
  | "capability-mismatch"
  | "auth"
  | "transport"
  | "model-config"
  | "timeout"
  | "abort"
  | "unknown";

type ToolCallLike = (AcpToolCall | AcpToolCallUpdate) & {
  content?: unknown;
  rawOutput?: unknown;
  toolCallId?: string;
};

interface PostConnectConfigClient {
  setConfigOption(configId: string, value: string): Promise<void>;
}

interface LaunchConfig {
  effort?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 상수
// ═══════════════════════════════════════════════════════════════════════════

/** SDK 연결 시 사용할 공통 clientInfo */
const CLIENT_INFO = { name: "pi-unified-agent", version: "1.0.0" } as const;

/** 도구 호출 최대 보관 수 (메모리 보호) */
const MAX_TOOL_CALLS_TO_KEEP = 30;

/** globalThis 풀 키 — 기존 호환 키 유지 */
const POOL_KEY = "__pi_unified_agent_client_pool__";

/** globalThis launch 메타 키 — 기존 provider 상태와 분리된 런타임 내부 보관소 */
const LAUNCH_CONFIG_KEY = "__pi_unified_agent_launch_config__";

/** cliType 기반 legacy 키 목록 (carrierId 체계 전환 이전에 사용된 키) */
const LEGACY_CLI_KEYS = new Set(Object.keys(CLI_BACKENDS));

const DEAD_SESSION_PATTERNS = [
  /session not found/i,
  /unknown session/i,
  /invalid session/i,
  /closed session/i,
  /expired session/i,
];

const AUTH_PATTERNS = [
  /auth/i,
  /login/i,
  /unauthorized/i,
  /permission denied/i,
  /invalid api key/i,
];

/** 런타임 데이터 디렉토리 (session-maps/ 저장 경로) */
let dataDir: string | null = null;

/** 세션 매핑 저장소 (PI 세션별 carrierId→sessionId 매핑) */
let sessionStore: SessionMapStore | null = null;

/** noop SessionMapStore (미초기화/host session 없는 경우 fallback) */
const noopStore: SessionMapStore = {
  restore() {},
  get() { return undefined; },
  set() {},
  clear() {},
  getAll() { return {}; },
};

// ═══════════════════════════════════════════════════════════════════════════
// 함수
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 풀 기반 실행 (agent-tool + 에이전트 모드 공통)
 *
 * 세션 관리 완전 캡슐화:
 *  1. store.get(carrierId) → 매핑된 세션이 있으면 connectOpts.sessionId에 설정
 *  2. 연결 성공 → store.set(carrierId, id) 자동 저장
 *  3. resume 실패 → store.clear(carrierId) + 새 세션 자동 재시도
 *  4. 이미 연결된 경우 기존 세션 ID를 그대로 재사용
 */
export async function executeWithPool(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { carrierId, cliType, request, cwd, signal } = opts;
  const clientPool = getClientPool();
  const store = getSessionStore();

  let responseText = "";
  let thoughtText = "";
  const toolCalls: ToolCallInfo[] = [];
  const connectionInfo: ConnectionInfo = {};
  let status: AgentStatus = "connecting";
  let error: string | undefined;
  let aborted = false;
  let isLivePrompt = false;
  const streamBlocks: ColBlock[] = [];

  opts.onStatusChange?.("connecting");

  let poolEntry = clientPool.get(carrierId);
  let isTemporary = false;

  if (poolEntry) {
    if (poolEntry.busy) {
      poolEntry = undefined;
      isTemporary = true;
    } else if (!isClientAlive(poolEntry.client)) {
      clientPool.delete(carrierId);
      poolEntry = undefined;
    }
  }

  let client: IUnifiedAgentClient;

  if (poolEntry) {
    client = poolEntry.client;
    poolEntry.busy = true;
  } else {
    client = await buildProviderClient({ cli: cliType });
    if (!isTemporary) {
      const newEntry: PooledClient = { client, busy: true };
      clientPool.set(carrierId, newEntry);
      poolEntry = newEntry;
      client.on("exit", () => {
        const current = clientPool.get(carrierId);
        if (current?.client === client) clientPool.delete(carrierId);
      });
    }
  }

  let detachCoreStderrLogging = attachCoreStderrLogging(client, `acp-exec:${carrierId}`);

  const cleanupTemporary = async () => {
    if (!isTemporary) return;
    try { await client.disconnect(); } catch { /* 정리 실패 무시 */ }
    client.removeAllListeners();
  };

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    status = "aborted";
    opts.onStatusChange?.("aborted");
    void Promise.allSettled([
      client.cancelPrompt(),
      isTemporary ? cleanupTemporary() : disconnectClient(carrierId, client),
    ]);
  };

  if (signal?.aborted) {
    detachCoreStderrLogging();
    if (poolEntry) {
      poolEntry.busy = false;
    }
    if (isTemporary) {
      await cleanupTemporary();
    }
    return {
      responseText: "",
      thoughtText: "",
      toolCalls: [],
      streamData: createCollectedStreamData("", "", [], [], "aborted"),
      connectionInfo,
      status: "aborted",
    };
  }

  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const onMessageChunk = (text: string) => {
    if (!isLivePrompt) return;
    responseText += text;
    appendTextStreamBlock(streamBlocks, text);
    opts.onMessageChunk?.(text);
  };
  const onThoughtChunk = (text: string) => {
    if (!isLivePrompt) return;
    thoughtText += text;
    appendThoughtStreamBlock(streamBlocks, text);
    opts.onThoughtChunk?.(text);
  };
  const upsertToolCall = (title: string, tcStatus: string, rawOutput?: string, toolCallId?: string) => {
    if (!isLivePrompt) return;
    const existing = toolCalls.find((tc) =>
      toolCallId ? tc.toolCallId === toolCallId : tc.title === title,
    );
    if (existing) {
      existing.status = tcStatus;
      if (rawOutput !== undefined) {
        existing.rawOutput = rawOutput;
      }
    } else {
      toolCalls.push({ title, status: tcStatus, rawOutput, toolCallId, timestamp: Date.now() });
    }
    upsertToolStreamBlock(streamBlocks, title, tcStatus, toolCallId);
    if (toolCalls.length > MAX_TOOL_CALLS_TO_KEEP) {
      toolCalls.splice(0, toolCalls.length - MAX_TOOL_CALLS_TO_KEEP);
    }
    opts.onToolCall?.(title, tcStatus, rawOutput, toolCallId);
  };
  const onToolCall = (title: string, tcStatus: string, _sessionId: string, data?: AcpToolCall) => {
    upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
  };
  const onToolCallUpdate = (title: string, tcStatus: string, _sessionId: string, data?: AcpToolCallUpdate) => {
    upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
  };
  const onError = (err: Error) => {
    if (!aborted) error = err.message;
  };

  const attachListeners = () => {
    client.on("messageChunk", onMessageChunk);
    client.on("thoughtChunk", onThoughtChunk);
    client.on("toolCall", onToolCall);
    client.on("toolCallUpdate", onToolCallUpdate);
    client.on("error", onError);
  };
  const detachListeners = () => {
    client.off("messageChunk", onMessageChunk);
    client.off("thoughtChunk", onThoughtChunk);
    client.off("toolCall", onToolCall);
    client.off("toolCallUpdate", onToolCallUpdate);
    client.off("error", onError);
  };

  attachListeners();

  try {
    let needsConnect = !isClientAlive(client);

    if (!needsConnect && hasSystemPromptDrift(client, opts.connectSystemPrompt ?? null)) {
      debugSystemPromptDrift("executeWithPool", carrierId, cliType);
      store.clear(carrierId);
      if (poolEntry) {
        delete poolEntry.sessionId;
      }
      await client.disconnect();
      needsConnect = true;
    }

    if (needsConnect) {
      const connectOpts = await buildConnectOptions(cliType, cwd, {
        model: opts.model,
        promptIdleTimeout: opts.promptIdleTimeout,
      }, opts.connectSystemPrompt ?? null);

      const savedSessionId = store.get(carrierId) ?? poolEntry?.sessionId;
      if (savedSessionId) {
        connectOpts.sessionId = savedSessionId;
      }

      let connectResult: ConnectResult;
      try {
        connectResult = await raceAbort(client.connect(connectOpts), signal);
      } catch (connectError) {
        if (aborted) throw connectError;
        if (!savedSessionId) throw connectError;
        if (classifyResumeFailure(connectError) !== "dead-session") {
          throw connectError;
        }

        console.error(
          `[unified-agent] session/load 실패 (carrierId=${carrierId}, sessionId=${savedSessionId}):`,
          connectError instanceof Error ? connectError.message : connectError,
        );

        store.clear(carrierId);
        if (poolEntry) delete poolEntry.sessionId;
        delete connectOpts.sessionId;

        try { await client.disconnect(); } catch {}
        detachListeners();
        detachCoreStderrLogging();
        client = await buildProviderClient({ cli: cliType });
        detachCoreStderrLogging = attachCoreStderrLogging(client, `acp-exec:${carrierId}`);
        if (!isTemporary) {
          poolEntry = { client, busy: true };
          clientPool.set(carrierId, poolEntry);
          client.on("exit", () => {
            const current = clientPool.get(carrierId);
            if (current?.client === client) clientPool.delete(carrierId);
          });
        }
        attachListeners();
        connectResult = await raceAbort(client.connect(connectOpts), signal);
      }

      connectionInfo.protocol = connectResult.protocol;
      connectionInfo.sessionId = connectResult.session?.sessionId ?? undefined;
      connectionInfo.model = extractConnectedModel(connectResult);

      if (poolEntry && connectionInfo.sessionId) {
        poolEntry.sessionId = connectionInfo.sessionId;
      }
      if (connectionInfo.sessionId) {
        store.set(carrierId, connectionInfo.sessionId);
      }

      await applyPostConnectConfig(client, cliType, resolveLaunchOverrides(carrierId, {
        effort: opts.effort,
      }));
    } else {
      const info = client.getConnectionInfo();
      connectionInfo.protocol = info.protocol ?? undefined;
      connectionInfo.sessionId = info.sessionId ?? undefined;

      if (poolEntry && connectionInfo.sessionId) {
        poolEntry.sessionId = connectionInfo.sessionId;
      }
      if (connectionInfo.sessionId) {
        store.set(carrierId, connectionInfo.sessionId);
      }

      if (opts.effort) {
        await applyPostConnectConfig(client, cliType, {
          effort: opts.effort,
        });
      }
    }

    if (aborted) {
      return {
        responseText,
        thoughtText,
        toolCalls,
        streamData: createCollectedStreamData(responseText, thoughtText, toolCalls, streamBlocks, status),
        connectionInfo,
        status,
        error,
      };
    }

    opts.onConnected?.(connectionInfo);
    status = "running";
    opts.onStatusChange?.("running");

    responseText = "";
    thoughtText = "";
    toolCalls.length = 0;
    streamBlocks.length = 0;
    isLivePrompt = true;

    await client.sendMessage(request);

    const postSendInfo = client.getConnectionInfo();
    if (postSendInfo.sessionId && postSendInfo.sessionId !== connectionInfo.sessionId) {
      connectionInfo.sessionId = postSendInfo.sessionId;
      if (poolEntry) poolEntry.sessionId = postSendInfo.sessionId;
      store.set(carrierId, postSendInfo.sessionId);
    }

    if (!aborted) {
      status = "done";
      if (!responseText.trim()) {
        responseText = "(no output)";
        appendTextStreamBlock(streamBlocks, responseText);
      }
      opts.onStatusChange?.("done");
    }
  } catch (err) {
    if (!aborted) {
      const message = err instanceof Error ? err.message : String(err);
      status = "error";
      error = message;
      if (!responseText) {
        responseText = message;
        appendTextStreamBlock(streamBlocks, responseText);
      }
      opts.onStatusChange?.("error");
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    detachListeners();
    detachCoreStderrLogging();
    if (poolEntry) poolEntry.busy = false;

    if (isTemporary && connectionInfo.sessionId) {
      const existingEntry = clientPool.get(carrierId);
      if (existingEntry) {
        existingEntry.sessionId = connectionInfo.sessionId;
      }
    }
    await cleanupTemporary();
  }

  return {
    responseText,
    thoughtText,
    toolCalls,
    streamData: createCollectedStreamData(responseText, thoughtText, toolCalls, streamBlocks, status),
    connectionInfo,
    status,
    error,
  };
}

/**
 * 비풀 일회성 실행
 * 매번 새 Unified Agent provider client를 생성 → 실행 → disconnect
 * 세션 매핑을 사용하지 않습니다.
 */
export async function executeOneShot(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { cliType, request, cwd, signal } = opts;

  let responseText = "";
  let thoughtText = "";
  const toolCalls: ToolCallInfo[] = [];
  const connectionInfo: ConnectionInfo = {};
  let status: AgentStatus = "connecting";
  let error: string | undefined;
  const streamBlocks: ColBlock[] = [];

  opts.onStatusChange?.("connecting");

  const client = await buildProviderClient({ cli: cliType });
  const detachCoreStderrLogging = attachCoreStderrLogging(client, `acp-exec:${opts.carrierId}`);
  let aborted = false;

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    status = "aborted";
    opts.onStatusChange?.("aborted");
    void Promise.allSettled([
      client.cancelPrompt(),
      client.disconnect(),
    ]);
  };

  try {
    if (signal?.aborted) {
      return {
        responseText: "",
        thoughtText: "",
        toolCalls: [],
        streamData: createCollectedStreamData("", "", [], [], "aborted"),
        connectionInfo,
        status: "aborted",
      };
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const connectOpts = await buildConnectOptions(cliType, cwd, {
      model: opts.model,
      promptIdleTimeout: opts.promptIdleTimeout,
    }, opts.connectSystemPrompt ?? null);

    const connectResult = await raceAbort(client.connect(connectOpts), signal);
    await applyPostConnectConfig(client, cliType, {
      effort: opts.effort,
    });

    if (aborted) {
      return {
        responseText,
        thoughtText,
        toolCalls,
        streamData: createCollectedStreamData(responseText, thoughtText, toolCalls, streamBlocks, status),
        connectionInfo,
        status,
        error,
      };
    }

    const info = client.getConnectionInfo();
    connectionInfo.protocol = info.protocol ?? connectResult.protocol ?? undefined;
    connectionInfo.sessionId = info.sessionId ?? connectResult.session?.sessionId ?? undefined;
    connectionInfo.model = extractConnectedModel(connectResult);

    opts.onConnected?.(connectionInfo);
    status = "running";
    opts.onStatusChange?.("running");

    client.on("messageChunk", (text: string) => {
      responseText += text;
      appendTextStreamBlock(streamBlocks, text);
      opts.onMessageChunk?.(text);
    });
    client.on("thoughtChunk", (text: string) => {
      thoughtText += text;
      appendThoughtStreamBlock(streamBlocks, text);
      opts.onThoughtChunk?.(text);
    });
    const upsertToolCall = (title: string, tcStatus: string, rawOutput?: string, toolCallId?: string) => {
      const existing = toolCalls.find((tc) =>
        toolCallId ? tc.toolCallId === toolCallId : tc.title === title,
      );
      if (existing) {
        existing.status = tcStatus;
        if (rawOutput !== undefined) {
          existing.rawOutput = rawOutput;
        }
      } else {
        toolCalls.push({ title, status: tcStatus, rawOutput, toolCallId, timestamp: Date.now() });
      }
      upsertToolStreamBlock(streamBlocks, title, tcStatus, toolCallId);
      opts.onToolCall?.(title, tcStatus, rawOutput, toolCallId);
    };
    client.on("toolCall", (title: string, tcStatus: string, _sessionId: string, data?: AcpToolCall) => {
      upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
    });
    client.on("toolCallUpdate", (title: string, tcStatus: string, _sessionId: string, data?: AcpToolCallUpdate) => {
      upsertToolCall(title, tcStatus, extractToolResultText(data as ToolCallLike | undefined), data?.toolCallId);
    });

    await client.sendMessage(request);

    if (!aborted) {
      status = "done";
      if (!responseText.trim()) {
        responseText = "(no output)";
        appendTextStreamBlock(streamBlocks, responseText);
      }
      opts.onStatusChange?.("done");
    }
  } catch (e) {
    if (!aborted) {
      status = "error";
      error = e instanceof Error ? e.message : String(e);
      if (!responseText) {
        responseText = `Error: ${error}`;
        appendTextStreamBlock(streamBlocks, responseText);
      }
      opts.onStatusChange?.("error");
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    detachCoreStderrLogging();
    try { await client.disconnect(); } catch { /* 정리 실패 무시 */ }
    client.removeAllListeners();
  }

  return {
    responseText,
    thoughtText,
    toolCalls,
    streamData: createCollectedStreamData(responseText, thoughtText, toolCalls, streamBlocks, status),
    connectionInfo,
    status,
    error,
  };
}

/**
 * 연결 후 추론 설정을 세션에 적용합니다.
 * 호출자가 주입한 effort 값을 그대로 사용합니다.
 */
export async function applyPostConnectConfig(
  client: PostConnectConfigClient,
  cli: CliType,
  overrides?: { effort?: string },
): Promise<void> {
  if (overrides?.effort) {
    if (supportsReasoningEffort(cli)) {
      try {
        await client.setConfigOption("reasoning_effort", overrides.effort);
      } catch (err) {
        console.warn(`[acp] setConfigOption 실패 (cli=${cli}, option=reasoning_effort)`, err);
      }
    }
  }

}

/** 싱글턴 풀 반환 (globalThis에서 가져오거나 생성) */
export function getClientPool(): Map<string, PooledClient> {
  const globalState = globalThis as typeof globalThis & {
    [POOL_KEY]?: Map<string, PooledClient>;
  };
  let pool = globalState[POOL_KEY];
  if (!pool) {
    pool = new Map();
    globalState[POOL_KEY] = pool;
  }
  return pool;
}

/** 연결 상태가 활성(재사용 가능)인지 판별 */
export function isClientAlive(client: IUnifiedAgentClient): boolean {
  const info = client.getConnectionInfo();
  return info.state === "ready" || info.state === "connected";
}

/**
 * 특정 CLI의 풀 클라이언트를 강제로 종료하고 풀에서 제거합니다.
 * expectedClient가 주어지면 현재 풀 엔트리가 해당 인스턴스일 때만 종료합니다.
 */
export async function disconnectClient(
  carrierId: string,
  expectedClient?: IUnifiedAgentClient,
): Promise<boolean> {
  const pool = getClientPool();
  const entry = pool.get(carrierId);
  if (!entry) return false;
  if (expectedClient && entry.client !== expectedClient) return false;

  pool.delete(carrierId);
  entry.busy = false;

  try {
    await entry.client.disconnect();
  } catch {
    // 강제 정리 경로이므로 disconnect 실패는 무시합니다.
  }
  entry.client.removeAllListeners();
  return true;
}

/** 전체 풀 정리 (session_end용) */
export async function disconnectAll(): Promise<void> {
  const pool = getClientPool();
  const promises: Promise<void>[] = [];
  for (const [, entry] of pool) {
    promises.push(
      entry.client.disconnect().catch(() => { /* 정리 실패 무시 */ }),
    );
  }
  await Promise.allSettled(promises);
  pool.clear();
}

/** busy가 아닌 클라이언트를 disconnect + 풀에서 제거 */
export function cleanIdleClients(): void {
  const pool = getClientPool();
  for (const [key, entry] of pool) {
    if (!entry.busy) {
      entry.client.disconnect().catch(() => {});
      pool.delete(key);
    }
  }
}

/**
 * Core 런타임을 초기화합니다.
 *
 * @param dir - 런타임 데이터가 저장될 디렉토리
 *              (e.g. `path.join(extensionDir, ".data")`)
 */
export function initRuntime(dir: string): void {
  dataDir = dir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sessionDir = path.join(dir, "session-maps");
  sessionStore = createSessionMapStore(sessionDir);
}

/**
 * PI 호스트 세션 변경을 통지합니다.
 * 호스트 세션 없이 호출된 경우(빈 문자열)에도 안전합니다.
 */
export function onHostSessionChange(piSessionId: string): void {
  if (!sessionStore) return;
  sessionStore.restore(piSessionId);
}

/**
 * 내부 sessionStore를 반환합니다.
 * 미초기화 상태이면 noop store를 반환하여 신규 세션을 허용합니다.
 */
export function getSessionStore(): SessionMapStore {
  return sessionStore ?? noopStore;
}

/** carrierId의 현재 서브에이전트 sessionId를 조회합니다. */
export function getSessionId(carrierId: string): string | undefined {
  return sessionStore?.get(carrierId);
}

/** 데이터 디렉토리를 반환합니다. 미초기화 시 null. */
export function getDataDir(): string | null {
  return dataDir;
}

export function classifyResumeFailure(error: unknown): ResumeFailureKind {
  const message = extractErrorMessage(error);
  if (message === "Aborted") {
    return "abort";
  }
  if (DEAD_SESSION_PATTERNS.some((pattern) => pattern.test(message))) {
    return "dead-session";
  }
  if (/loadSession.*지원하지 않/i.test(message) || /session\/load.*지원하지 않/i.test(message)) {
    return "capability-mismatch";
  }
  if (/does not support session\/load/i.test(message) || /does not support loadSession/i.test(message)) {
    return "capability-mismatch";
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return "auth";
  }
  if (/spawn|initialize|transport|econn|pipe|closed/i.test(message)) {
    return "transport";
  }
  if (/model|config|mcp/i.test(message)) {
    return "model-config";
  }
  if (/timeout|timed out|유휴 상태/i.test(message)) {
    return "timeout";
  }
  return "unknown";
}

export function isDeadSessionError(err: unknown): boolean {
  return classifyResumeFailure(err) === "dead-session";
}

/**
 * 독립된 SessionMapStore 인스턴스를 생성합니다.
 *
 * @param sessionDir - 세션 맵 JSON 파일이 저장될 디렉토리 경로
 *                     (예: fleet/session-maps/)
 */
export function createSessionMapStore(sessionDir: string): SessionMapStore {
  let currentMap: SessionMap = {};
  let mapFilePath: string | null = null;

  function persist(): void {
    if (!mapFilePath) return;
    try {
      const dir = path.dirname(mapFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(mapFilePath, JSON.stringify(currentMap, null, 2));
    } catch {
      // 파일 쓰기 실패 무시 (권한 등)
    }
  }

  return {
    restore(piSessionId: string): void {
      currentMap = {};
      mapFilePath = null;

      if (!piSessionId || !sessionDir) return;

      mapFilePath = path.join(sessionDir, `${piSessionId}.json`);
      try {
        const fileExists = fs.existsSync(mapFilePath);
        if (fileExists) {
          const raw = fs.readFileSync(mapFilePath, "utf-8");
          currentMap = JSON.parse(raw);
          if (migrateLegacyKeys(currentMap)) {
            persist();
          }
        }
      } catch {
        currentMap = {};
      }
    },

    get(carrierId: string): string | undefined {
      return currentMap[carrierId];
    },

    set(carrierId: string, sessionId: string): void {
      if (currentMap[carrierId] === sessionId) return;
      currentMap[carrierId] = sessionId;
      persist();
    },

    clear(carrierId: string): void {
      if (!(carrierId in currentMap)) return;
      delete currentMap[carrierId];
      persist();
    },

    getAll(): Readonly<SessionMap> {
      return { ...currentMap };
    },
  };
}

function createCollectedStreamData(
  text: string,
  thinking: string,
  toolCalls: readonly ToolCallInfo[],
  blocks: readonly ColBlock[],
  lastStatus: AgentStatus,
): CollectedStreamData {
  return {
    text,
    thinking,
    toolCalls: toolCalls.map((toolCall) => ({
      title: toolCall.title,
      status: toolCall.status,
    })),
    blocks: blocks.map((block) => ({ ...block })),
    lastStatus,
  };
}

function appendTextStreamBlock(blocks: ColBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  blocks.push({ type: "text", text });
}

function appendThoughtStreamBlock(blocks: ColBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "thought") {
    last.text += text;
    return;
  }
  blocks.push({ type: "thought", text });
}

function upsertToolStreamBlock(
  blocks: ColBlock[],
  title: string,
  status: string,
  toolCallId?: string,
): void {
  const existing = blocks.find((block): block is Extract<ColBlock, { type: "tool" }> =>
    block.type === "tool" && (toolCallId ? block.toolCallId === toolCallId : block.title === title),
  );
  if (existing) {
    existing.status = status;
    return;
  }
  blocks.push({ type: "tool", title, status, toolCallId });
}

function extractToolResultText(data?: ToolCallLike): string | undefined {
  if (!data) return undefined;

  const contentText = extractContentText(data.content);
  if (contentText) {
    return contentText;
  }

  if (data.rawOutput !== undefined && data.rawOutput !== null) {
    return typeof data.rawOutput === "string"
      ? data.rawOutput
      : JSON.stringify(data.rawOutput, null, 2);
  }

  return undefined;
}

function extractContentText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;

    const typedItem = item as {
      type?: unknown;
      content?: { type?: unknown; text?: unknown };
      path?: unknown;
      newText?: unknown;
      oldText?: unknown;
    };

    if (typedItem.type === "content") {
      const block = typedItem.content;
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
      continue;
    }

    if (typedItem.type === "diff" && typeof typedItem.path === "string" && typeof typedItem.newText === "string") {
      const newLines = typedItem.newText.split("\n").length;
      const oldLines = typeof typedItem.oldText === "string"
        ? typedItem.oldText.split("\n").length
        : 0;
      const delta = newLines - oldLines;
      const sign = delta >= 0 ? `+${delta}` : `${delta}`;
      parts.push(`${typedItem.path}: ${sign} lines`);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("\n");
}

/**
 * promise와 AbortSignal을 경합시켜, signal abort 시 즉시 reject합니다.
 * connect() 등 내부적으로 signal을 지원하지 않는 비동기 작업에서
 * abort 반응성을 확보하기 위해 사용합니다.
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Aborted")),
        { once: true },
      );
    }),
  ]);
}

/**
 * CLI 연결에 필요한 공통 옵션 객체를 구성합니다.
 * 호출자가 주입한 model 값을 그대로 사용합니다.
 */
async function buildConnectOptions(
  cli: CliType,
  cwd: string,
  overrides: { model?: string; promptIdleTimeout?: number } | undefined,
  systemPrompt: string | null | undefined,
): Promise<UnifiedClientOptions> {
  const opts: UnifiedClientOptions = {
    cwd,
    cli,
    autoApprove: true,
    clientInfo: CLIENT_INFO,
    timeout: 0,
  };

  if (overrides?.model) {
    opts.model = overrides.model;
  }

  if (overrides?.promptIdleTimeout !== undefined) {
    opts.promptIdleTimeout = overrides.promptIdleTimeout;
  }

  if (systemPrompt) {
    opts.systemPrompt = systemPrompt;
  }

  const env = await resolveAuthEnv(cli);
  if (Object.keys(env).length > 0) {
    opts.env = env;
  }

  return opts;
}

function hasSystemPromptDrift(
  client: IUnifiedAgentClient,
  expectedSystemPrompt: string | null | undefined,
): boolean {
  return normalizeSystemPrompt(client.getCurrentSystemPrompt()) !== normalizeSystemPrompt(expectedSystemPrompt);
}

function normalizeSystemPrompt(systemPrompt: string | null | undefined): string {
  return systemPrompt?.trim() ?? "";
}

function debugSystemPromptDrift(scope: string, key: string, cliType: CliType): void {
  console.warn(`[unified-agent] systemPrompt drift 감지 (${scope}, key=${key}, cli=${cliType})`);
}

function supportsReasoningEffort(cli: CliType): boolean {
  const levels = getReasoningEffortLevels(cli);
  return Array.isArray(levels) && levels.length > 0;
}

function resolveLaunchOverrides(
  key: string,
  overrides?: { effort?: string },
): { effort?: string } | undefined {
  const launchConfig = getLaunchConfig(key);
  const effort = overrides?.effort ?? launchConfig?.effort;

  if (!effort) {
    return overrides;
  }

  return {
    effort,
  };
}

function attachCoreStderrLogging(client: IUnifiedAgentClient, source: string): () => void {
  const onLogEntry = (entry: { message: string; cli?: string; sessionId?: string }) => {
    const normalized = normalizeDiagnosticStderr(entry.message);
    if (!normalized) {
      return;
    }

    const parts = [
      entry.cli ? `cli=${entry.cli}` : null,
      entry.sessionId ? `session=${entry.sessionId}` : null,
      normalized,
    ].filter(Boolean);

    getLogAPI().debug(source, parts.join(" "), {
      category: "acp-stderr",
      hideFromFooter: true,
    });
  };

  client.on("logEntry", onLogEntry);
  return () => {
    client.off("logEntry", onLogEntry);
  };
}

function normalizeDiagnosticStderr(message: string): string | null {
  const stripped = message.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!stripped) {
    return null;
  }
  if (/^[\|\/\\\-⠁-⣿\.\s]+$/.test(stripped)) {
    return null;
  }
  return stripped;
}

function extractConnectedModel(connectResult: ConnectResult): string | undefined {
  const sessionAny = connectResult.session as Record<string, unknown> | undefined;
  if (sessionAny?.models && Array.isArray(sessionAny.models) && sessionAny.models.length > 0) {
    return String(sessionAny.models[0]);
  }
  return undefined;
}

function migrateLegacyKeys(map: SessionMap): boolean {
  let migrated = false;
  for (const key of LEGACY_CLI_KEYS) {
    if (key in map) {
      delete map[key];
      migrated = true;
    }
  }
  return migrated;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

async function buildProviderClient(
  options: UnifiedAgentBuildOptions,
): Promise<IUnifiedAgentClient> {
  return UnifiedAgent.build(options);
}

function getLaunchConfig(sessionKey: string): LaunchConfig | undefined {
  const store = getLaunchConfigStore();
  return store.get(sessionKey);
}

function getLaunchConfigStore(): Map<string, LaunchConfig> {
  const globalState = globalThis as typeof globalThis & {
    [LAUNCH_CONFIG_KEY]?: Map<string, LaunchConfig>;
  };
  let store = globalState[LAUNCH_CONFIG_KEY];
  if (!store) {
    store = new Map();
    globalState[LAUNCH_CONFIG_KEY] = store;
  }
  return store;
}
