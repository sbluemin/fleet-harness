import type { OperationGeometry, OperationNode } from "@fleet-console/sdk/operations";
import {
  readAgentChatCatalogPayload,
  readAgentChatJobDetailPayload,
  type AgentChatCatalog,
  type AgentChatJobDetail,
} from "./chat/chat-events.js";
import type { AgentCliDiagnostics, AgentCliMetadata, AgentCliState, SessionInfo } from "./types.js";

export interface OperationsSnapshot {
  readonly operations: readonly OperationNode[];
}

const FORBIDDEN_BROWSER_PAYLOAD_KEYS = ["canonicalCwd", "cwd", "providerSession", "ticket", "token", "transcriptPath", "prompt", "persona", "toolAllowlist"] as const;

export class AgentApiError extends Error {
  readonly status: number;
  /**
   * 거절이 프롬프트를 몇 글자 줄이라고 말할 때 그 수. 서버만 아는 값이라(상한이 그 실행의
   * argv 전체에 달려 있다) 브라우저가 되계산할 수 없어, 코드와 함께 실어 나른다.
   */
  readonly shortenByChars?: number;
  /**
   * 거절이 "지금은 안 된다"고만 말하지 않고 **무엇이 끝나야 되는지**를 함께 말할 때의 그 사유.
   * 기다림의 대상이 여럿이면 사용자의 다음 행동도 갈리므로, 화면이 그 차이를 그릴 수 있어야 한다.
   */
  readonly reason?: string;

  constructor(status: number, message: string, shortenByChars?: number, reason?: string) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    if (shortenByChars !== undefined) this.shortenByChars = shortenByChars;
    if (reason !== undefined) this.reason = reason;
  }
}

export async function fetchAgentState(signal?: AbortSignal): Promise<readonly AgentCliMetadata[]> {
  const response = await fetch("/plugins/terminal/agent/state", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly agentClis?: unknown };
  if (!Array.isArray(payload.agentClis)) throw new AgentApiError(response.status, "Invalid agent state response");
  return payload.agentClis.map((cli) => assertAgentCliMetadata(cli, response.status));
}

export async function fetchAgentCliState(signal?: AbortSignal): Promise<AgentCliState> {
  const response = await fetch("/plugins/terminal/agent/agent-cli/state", { signal });
  await assertOk(response);
  const payload = await response.json() as AgentCliState;
  if (!Array.isArray(payload.clis)) throw new AgentApiError(response.status, "Invalid Agent CLI state response");
  return payload;
}

export async function fetchAgentCliDiagnostics(signal?: AbortSignal): Promise<AgentCliDiagnostics> {
  const response = await fetch("/plugins/terminal/agent/agent-cli/diagnostics", { signal });
  await assertOk(response);
  const payload = await response.json() as AgentCliDiagnostics;
  if (!Array.isArray(payload.entries)) throw new AgentApiError(response.status, "Invalid Agent CLI diagnostics response");
  return payload;
}

export async function setAgentCliPath(cliCommand: string, path: string | null, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/plugins/terminal/agent/agent-cli/path", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cliCommand, path }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
}

export async function fetchSessions(signal?: AbortSignal): Promise<readonly SessionInfo[]> {
  const response = await fetch("/plugins/terminal/agent/sessions", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly sessions?: unknown };
  if (!Array.isArray(payload.sessions)) throw new AgentApiError(response.status, "Invalid agent sessions response");
  return payload.sessions.map((session) => assertSessionInfo(session, response.status));
}

export async function fetchOperationsSnapshot(signal?: AbortSignal): Promise<OperationsSnapshot> {
  const response = await fetch("/api/v1/operations", { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly operations?: unknown };
  if (!Array.isArray(payload.operations)) throw new AgentApiError(response.status, "Invalid operations response");
  return { operations: payload.operations.map((operation) => assertOperationNode(operation, response.status)) };
}

export async function createAgentSession(
  theaterId: string,
  cliId: string,
  options?: {
    readonly model?: string;
    readonly effort?: string;
    readonly prompt?: string;
    readonly attachmentIds?: readonly string[];
    /** 생략은 터미널이다 — 기본이 곧 계약이라 이 키를 모르는 호출부도 같은 길을 탄다. */
    readonly viewMode?: "chat";
    readonly geometry?: OperationGeometry;
  },
  signal?: AbortSignal,
): Promise<SessionInfo> {
  const model = typeof options?.model === "string" && options.model.length > 0 ? options.model : undefined;
  const effort = typeof options?.effort === "string" && options.effort.length > 0 ? options.effort : undefined;
  // 요청 body에는 prompt를 실을 수 있지만, 응답 DTO에는 절대 오면 안 된다 — FORBIDDEN_BROWSER_PAYLOAD_KEYS의 "prompt"는 응답 가드이므로 지우지 않는다.
  const prompt = typeof options?.prompt === "string" && options.prompt.length > 0 ? options.prompt : undefined;
  const attachmentIds = options?.attachmentIds?.length ? options.attachmentIds : undefined;
  const viewMode = options?.viewMode === "chat" ? "chat" : undefined;
  const response = await fetch("/plugins/terminal/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId, cliId, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(prompt ? { prompt } : {}), ...(attachmentIds ? { attachmentIds } : {}), ...(viewMode ? { viewMode } : {}), ...(options?.geometry ? { geometry: options.geometry } : {}) }),
    signal,
  });
  // 거절 사유 코드를 그대로 실어 던진다 — Quick Launch가 초안을 되살리면서 무엇을 고쳐야 하는지
  // 말해 주려면, 상태 코드만으로는 부족하고 서버가 붙인 error 코드가 필요하다(setAgentCliPath와 같은 형태).
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      readonly error?: unknown;
      readonly shortenByChars?: unknown;
    } | null;
    throw new AgentApiError(
      response.status,
      typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`,
      typeof payload?.shortenByChars === "number" ? payload.shortenByChars : undefined,
    );
  }
  return assertSessionInfo(await response.json(), response.status);
}


export async function resumeAgentSession(sessionId: string, options?: { readonly fresh?: boolean; readonly signal?: AbortSignal }): Promise<SessionInfo> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    ...(options?.fresh
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fresh: true }) }
      : {}),
    signal: options?.signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(
      response.status,
      typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`,
    );
  }
  return assertSessionInfo(await response.json(), response.status);
}

export async function messageAgentSession(sessionId: string, text: string, attachmentIds?: readonly string[], signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
    signal,
  });
  if (!response.ok) {
    // 서버 거절 코드를 그대로 실어 던진다 — Quick Launch 멘션 컴포저가 초안을 지키면서
    // 무엇이 잘못됐는지 말하려면 상태 코드만으로는 부족하다(resumeAgentSession과 같은 형태).
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(
      response.status,
      typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`,
    );
  }
}

/**
 * 대기 중인 질문에 답한다. message 라우트가 아닌 이유는 그쪽이 새 턴을 큐에 넣기 때문이다 —
 * 이 답은 진행 중 턴 안으로 들어간다.
 */
export async function answerAgentChatAsk(
  sessionId: string,
  body: {
    readonly askId: string;
    readonly answers?: readonly string[];
    readonly approve?: boolean;
    readonly message?: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
}

/**
 * 도는 턴을 끊는다.
 *
 * 이 문은 **턴만** 닫는다. 이미 태어난 백그라운드 작업은 계속 살며, 그것을 멈추는 문은
 * `stopAgentChatJob`이 따로 연다.
 */
export async function stopAgentChatTurn(sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat-stop`, { method: "POST", signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
}

/**
 * 백그라운드 작업 하나를 멈춘다.
 *
 * 성공은 "자식이 중단 요청을 받았다"까지다 — 잡 줄이 닫히는 것은 자식이 보내는 결말 알림이
 * 하는 일이므로, 호출부가 낙관적으로 상태를 고쳐 쓰지 않는다.
 */
export async function stopAgentChatJob(sessionId: string, jobId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat-job-stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
}

/**
 * 잡 하나의 상세 — 서브에이전트의 도구 발자국, 또는 셸 출력의 꼬리.
 *
 * 스트림이 아니라 요청인 이유는 크기다. 사용자가 그 잡을 연 그때만 한 번 읽는다.
 * 404는 "아직/이미 없음"이며 오류가 아니다 — 호출부가 빈 상태를 그리게 null을 돌려준다.
 */
export async function readAgentChatJobDetail(
  sessionId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<AgentChatJobDetail | null> {
  const query = `?jobId=${encodeURIComponent(jobId)}`;
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat-job${query}`, { signal });
  if (response.status === 404 || response.status === 409) return null;
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  return readAgentChatJobDetailPayload(payload);
}

/**
 * 컴포저 덱이 세울 목록 — 이 세션의 명령·스킬·에이전트.
 *
 * 이 요청은 자식을 **열 수 있다**(서버가 그렇게 한다). 사용자가 `/`를 친 것이 곧 능력을 묻는
 * 행위이기 때문이며, 첫 전송을 기다리면 갓 연 채팅의 첫 덱은 반드시 빈다.
 *
 * 409는 실패가 아니라 "아직 못 읽었다"이므로 `null`이다 — 호출부는 빈 목록과 구분해 그린다.
 */
export async function readAgentChatCatalog(
  sessionId: string,
  signal?: AbortSignal,
): Promise<AgentChatCatalog | null> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat-catalog`, { signal });
  if (response.status === 404 || response.status === 409) return null;
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  return readAgentChatCatalogPayload(payload);
}

export async function convertAgentSessionToChat(sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat`, { method: "POST", signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown; readonly reason?: unknown } | null;
    throw new AgentApiError(
      response.status,
      typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`,
      undefined,
      typeof payload?.reason === "string" ? payload.reason : undefined,
    );
  }
}

export async function exitAgentChat(sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat`, { method: "DELETE", signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(response.status, typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`);
  }
}

export async function uploadLaunchAttachment(file: Blob, signal?: AbortSignal): Promise<{ readonly id: string }> {
  const response = await fetch("/plugins/terminal/agent/attachments", {
    method: "POST",
    // 서버는 라벨이 아니라 바이트로 이미지 여부를 판정한다 — Content-Type은 참고값일 뿐이다.
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
    signal,
  });
  if (!response.ok) {
    // 서버 거절 코드를 그대로 실어 던진다 — 컴포저가 칩을 지키면서 사유를 말하려면 코드가 필요하다.
    const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
    throw new AgentApiError(
      response.status,
      typeof payload?.error === "string" ? payload.error : `Agent plugin request failed: ${response.status}`,
    );
  }
  const payload = await response.json() as { readonly id?: unknown };
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new AgentApiError(response.status, "attachment_upload_failed");
  }
  return { id: payload.id };
}

export async function discardLaunchAttachment(id: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/attachments/${encodeURIComponent(id)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export async function terminateAgentSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export function assertSessionInfo(value: unknown, status: number): SessionInfo {
  const payload = value as Partial<SessionInfo>;
  if (
    !payload
    || typeof payload.sessionId !== "string"
    || typeof payload.cwdLabel !== "string"
    || typeof payload.status !== "string"
    || typeof payload.createdAt !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new AgentApiError(status, "Invalid agent session response");
  }
  return {
    sessionId: payload.sessionId,
    terminalSessionId: typeof payload.terminalSessionId === "string" ? payload.terminalSessionId : payload.sessionId,
    cwdLabel: payload.cwdLabel,
    label: typeof payload.label === "string" ? payload.label : undefined,
    status: payload.status,
    turnState: payload.turnState === "running" || payload.turnState === "ended" ? payload.turnState : "none",
    modelActivity: payload.modelActivity === "working" || payload.modelActivity === "not-working" ? payload.modelActivity : undefined,
    attentionPending: typeof payload.attentionPending === "boolean" ? payload.attentionPending : undefined,
    backgroundPending: typeof payload.backgroundPending === "boolean" ? payload.backgroundPending : undefined,
    // 이 함수는 화이트리스트 재구성이다 — 여기 없는 필드는 서버가 실어 보내도 소실된다.
    // 활동축에 새 사실을 추가할 때는 반드시 이 목록도 함께 늘려야 한다.
    chatActive: typeof payload.chatActive === "boolean" ? payload.chatActive : undefined,
    createdAt: payload.createdAt,
    theaterId: typeof payload.theaterId === "string" ? payload.theaterId : undefined,
    tenantId: typeof payload.tenantId === "string" ? payload.tenantId : undefined,
    registrationId: typeof payload.registrationId === "string" ? payload.registrationId : undefined,
    resumeAvailable: payload.resumeAvailable === true,
  };
}

async function assertOk(response: Response): Promise<void> {
  if (!response.ok) throw new AgentApiError(response.status, `Agent plugin request failed: ${response.status}`);
}

function assertAgentCliMetadata(value: unknown, status: number): AgentCliMetadata {
  const payload = value as Partial<AgentCliMetadata>;
  if (!payload || typeof payload.id !== "string" || typeof payload.label !== "string") {
    throw new AgentApiError(status, "Invalid Agent CLI metadata response");
  }
  return {
    id: payload.id,
    label: payload.label,
    available: payload.available === true,
    signedIn: payload.signedIn !== false,
  };
}

function assertOperationNode(value: unknown, status: number): OperationNode {
  const payload = value as Partial<OperationNode>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.theaterId !== "string"
    || typeof payload.type !== "string"
    || typeof payload.pluginId !== "string"
    || typeof payload.title !== "string"
    || !payload.payload
    || typeof payload.payload !== "object"
    || Array.isArray(payload.payload)
    || !payload.ts
    || typeof payload.ts.createdAt !== "number"
    || typeof payload.ts.updatedAt !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
    || hasForbiddenBrowserPayloadKey(payload.payload)
  ) {
    throw new AgentApiError(status, "Invalid operation response");
  }
  return {
    id: payload.id,
    theaterId: payload.theaterId,
    type: payload.type,
    pluginId: payload.pluginId,
    title: payload.title,
    payload: payload.payload,
    geometry: payload.geometry ?? null,
    ts: payload.ts,
  };
}

function hasForbiddenBrowserPayloadKey(value: unknown): boolean {
  return containsForbiddenKey(value, new Set(FORBIDDEN_BROWSER_PAYLOAD_KEYS));
}

function containsForbiddenKey(value: unknown, forbidden: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, forbidden));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => forbidden.has(key) || containsForbiddenKey(item, forbidden));
}
