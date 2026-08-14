import { homedir } from "node:os";

/**
 * Chat Mode의 브라우저行 이벤트 어휘와, 두 원천(트랜스크립트 JSONL·SDK 메시지 스트림)을
 * 같은 어휘로 옮기는 매퍼.
 *
 * 이벤트에는 텍스트·도구 요약만 싣는다 — providerSession 식별자·트랜스크립트 경로·원문 파일
 * 경로는 서버 상태로만 남는다(Console 보안 계약). thinking 블록은 두 원천 모두에서 버린다 —
 * thought 내용은 공개 출력 꼬리가 되어선 안 된다(Terminal 플러그인 불변식).
 */

export type AgentChatStreamEvent =
  | { readonly kind: "replay-start" }
  | { readonly kind: "replay-end"; readonly turns: number }
  | { readonly kind: "dispatch"; readonly text: string; readonly at?: number }
  | { readonly kind: "turn-start"; readonly at?: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly detail: string }
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number }
  | { readonly kind: "status"; readonly working: boolean }
  | { readonly kind: "error"; readonly code: string };

/** 저널에 실리는 형태 — seq는 재접속 클라이언트가 중복 반영을 걸러내는 단조 축이다. */
export interface AgentChatJournalEvent {
  readonly seq: number;
  readonly event: AgentChatStreamEvent;
}

const MAX_TOOL_DETAIL_CHARS = 160;
const MAX_TEXT_CHARS = 60_000;

interface TranscriptContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
}

interface TranscriptLine {
  readonly type?: unknown;
  readonly isMeta?: unknown;
  readonly isSidechain?: unknown;
  readonly timestamp?: unknown;
  readonly message?: {
    readonly role?: unknown;
    readonly content?: unknown;
  };
}

/** 경로 표시를 cwd 기준으로 상대화하기 위한 매퍼 옵션. */
export interface ChatEventMapOptions {
  readonly cwd?: string;
}

/**
 * 트랜스크립트 한 줄을 이벤트 목록으로 옮긴다. 대화가 아닌 줄(mode/snapshot/attachment 등),
 * meta 줄, sidechain(서브에이전트) 줄은 빈 목록이다.
 */
export function chatEventsFromTranscriptLine(raw: string, options: ChatEventMapOptions = {}): readonly AgentChatStreamEvent[] {
  let line: TranscriptLine;
  try {
    line = JSON.parse(raw) as TranscriptLine;
  } catch {
    return [];
  }
  if (line.isMeta === true || line.isSidechain === true) return [];
  const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  const atField = Number.isFinite(at) ? { at } : {};
  if (line.type === "user") {
    const text = readUserText(line.message?.content);
    return text ? [{ kind: "dispatch", text, ...atField }] : [];
  }
  if (line.type === "assistant") {
    return eventsFromAssistantContent(line.message?.content, options);
  }
  return [];
}

/**
 * SDK가 흘려보내는 메시지 하나를 이벤트 목록으로 옮긴다. 사용자 프롬프트는 send 시점에
 * 이미 dispatch로 저널에 올랐으므로 여기서는 assistant·result만 본다.
 */
export function chatEventsFromSdkMessage(message: {
  readonly type: string;
  readonly [key: string]: unknown;
}, options: ChatEventMapOptions = {}): readonly AgentChatStreamEvent[] {
  if (message.type === "assistant") {
    const body = (message as { readonly message?: { readonly content?: unknown } }).message;
    return eventsFromAssistantContent(body?.content, options);
  }
  if (message.type === "result") {
    const durationMs = (message as { readonly duration_ms?: unknown }).duration_ms;
    return [{
      kind: "turn-end",
      ok: (message as { readonly is_error?: unknown }).is_error !== true,
      ...(typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs } : {}),
    }];
  }
  return [];
}

function eventsFromAssistantContent(content: unknown, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  if (!Array.isArray(content)) return [];
  const events: AgentChatStreamEvent[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      events.push({ kind: "text", text: capText(block.text) });
      continue;
    }
    if (block.type === "tool_use" && typeof block.name === "string" && block.name.length > 0) {
      events.push({ kind: "tool", name: block.name, detail: summarizeToolInput(block.input, options) });
    }
    // thinking·redacted_thinking은 의도적으로 버린다.
  }
  return events;
}

function readUserText(content: unknown): string | null {
  if (typeof content === "string") return normalizeDispatchText(content);
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    // tool_result가 섞인 user 줄은 도구 응답 운반체다 — 사람이 친 지시가 아니다.
    if (block?.type === "tool_result") return null;
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return normalizeDispatchText(parts.join("\n"));
}

function normalizeDispatchText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // 훅·시스템 리마인더 운반 줄은 지휘 로그에 올리지 않는다.
  if (trimmed.startsWith("<system-reminder>") || trimmed.startsWith("<command-name>")) return null;
  return capText(trimmed);
}

/**
 * 도구 입력에서 한 줄 요약을 뽑는다. 사람이 스캔할 좌표 성격의 필드만 고르고 상한을 둔다 —
 * 전체 입력(파일 본문·프롬프트)은 싣지 않는다. 경로 필드는 브라우저로 나가는 스트림이므로
 * raw 절대 경로 대신 표시형으로 옮긴다(Console 보안 계약).
 */
export function summarizeToolInput(input: unknown, options: ChatEventMapOptions = {}): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "url", "query", "description", "prompt", "subject"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const flat = value.replace(/\s+/g, " ").trim();
      const shown = key === "file_path" || key === "path"
        ? displayPath(flat, options.cwd)
        : normalizePathTokens(flat, options.cwd);
      return shown.length > MAX_TOOL_DETAIL_CHARS ? `${shown.slice(0, MAX_TOOL_DETAIL_CHARS - 1)}…` : shown;
    }
  }
  return "";
}

/**
 * 절대 경로를 브라우저 표시형으로 옮긴다: Operation cwd 안이면 상대 경로, 밖이면 마지막 두
 * 조각만 남긴 축약형이다. 상대 경로는 이미 안전하므로 그대로 둔다.
 */
/**
 * 자유 텍스트 요약(command·prompt 등) 안의 경로 토큰을 표시형으로 정규화한다: Operation cwd
 * 접두는 `.`으로, 홈 디렉터리 접두는 `~`로 바꾼다. 셸 관용 표기라 의미를 해치지 않으면서
 * 작업공간·홈 절대 경로가 브라우저 스트림에 원문으로 실리지 않게 한다.
 */
function normalizePathTokens(value: string, cwd: string | undefined): string {
  let result = value;
  if (cwd) {
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root.length > 1) result = result.split(root).join(".");
  }
  const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
  if (home.length > 1) result = result.split(home).join("~");
  return result;
}

function displayPath(value: string, cwd: string | undefined): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return value;
  if (cwd) {
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === root) return ".";
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return `…/${segments.slice(-2).join("/")}`;
}

function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}
