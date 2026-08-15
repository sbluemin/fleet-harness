import { homedir } from "node:os";

/**
 * Chat Mode의 브라우저行 이벤트 어휘와, 두 원천(트랜스크립트 JSONL·SDK 메시지 스트림)을
 * 같은 어휘로 옮기는 매퍼.
 *
 * 이벤트에는 텍스트·도구 요약·도구 결과 요약만 싣는다 — providerSession 식별자·트랜스크립트
 * 경로·원문 파일 경로는 서버 상태로만 남는다(Console 보안 계약). 도구 결과는 첫 줄만, 상한
 * 아래로, 경로 정규화와 자격 증명 마스킹을 통과한 뒤에야 나간다. thinking 블록은 두 원천
 * 모두에서 버린다 — thought 내용은 공개 출력 꼬리가 되어선 안 된다(Terminal 플러그인 불변식).
 */

/** 쓰기 계열 도구가 남긴 파일 변경 — 도구 입력에서 접는다(원문 본문은 싣지 않는다). */
export interface AgentChatChange {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
}

export type AgentChatStreamEvent =
  | { readonly kind: "replay-start" }
  | { readonly kind: "replay-end"; readonly turns: number }
  | { readonly kind: "dispatch"; readonly text: string; readonly at?: number }
  | { readonly kind: "turn-start"; readonly at?: number }
  | { readonly kind: "text"; readonly text: string }
  /** 라이브 전용 글자 단위 델타 — 저널에는 싣지 않는다. 완성 text 이벤트가 정정 앵커다. */
  | { readonly kind: "text-delta"; readonly text: string }
  /**
   * 도구 이름이 인자보다 먼저 알려지는 경로. 프로바이더는 이름을 올린 뒤 인자 JSON을 몇 초에
   * 걸쳐 흘리고(실측 8.5s), 게이트웨이는 그 자리에서 content_block_start를 낸다
   * (core-ai-gateway anthropic/protocol.ts).
   *
   * 다만 **오늘 이 이벤트는 실제로 도착하지 않는다**: Agent SDK 0.3.212의 `stream_event`는
   * 타입상 BetaRawMessageStreamEvent 전부를 실을 수 있지만, 실측(2026-08-16, 34초짜리 Write
   * 한 건)에서 tool_use 블록의 시작은 한 번도 넘어오지 않았고 완성 assistant 메시지가 올 때에야
   * 스텝이 섰다. 매핑을 남겨 두는 이유는 그 경로가 열리는 즉시 8.5초가 회수되기 때문이고,
   * 그때까지 그 공백은 원장 꼬리의 "생각 중" 한 줄이 진다.
   *
   * 라이브 전용이다 — 재생 때는 완성 tool 이벤트가 같은 스텝을 세운다.
   */
  | { readonly kind: "tool-start"; readonly id: string; readonly name: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly detail: string;
      /** tool-start·tool-result와 같은 스텝임을 잇는 축. 트랜스크립트 재생에도 실린다. */
      readonly id?: string;
      /** 좌표가 Operation cwd 밖을 가리킨다 — 표시형으로 접히면 구별되지 않으므로 따로 싣는다. */
      readonly outside?: boolean;
      readonly change?: AgentChatChange;
    }
  /** 스텝의 결말. ok는 도구가 돌려준 사실이지 턴의 성패가 아니다. */
  | { readonly kind: "tool-result"; readonly id: string; readonly ok: boolean; readonly summary: string }
  /** answer는 SDK result가 말한 최종 응답 텍스트다 — 클라이언트가 마지막 text를 Answer로 승격할 때의 서버 권위. */
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number; readonly answer?: string }
  | { readonly kind: "error"; readonly code: string };

/** 저널에 실리는 형태 — seq는 재접속 클라이언트가 중복 반영을 걸러내는 단조 축이다. */
export interface AgentChatJournalEvent {
  readonly seq: number;
  readonly event: AgentChatStreamEvent;
}

const MAX_TOOL_DETAIL_CHARS = 160;
const MAX_TOOL_RESULT_CHARS = 120;
const MAX_TEXT_CHARS = 60_000;

/** 쓰기 계열 — 이 도구들만 변경 장부에 오른다. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * 성공했을 때의 결과가 곧 내용인 도구들. 이쪽 결과의 첫 줄은 파일 본문·검색 히트·가져온
 * 페이지의 첫 줄이라, 요약으로 실으면 스텝 칩이 내용 유출 경로가 된다. 쓰기 계열도 같은
 * 이유로 비운다 — 그쪽은 변경 줄 수가 이미 결말을 말한다. 실패는 예외다: 무엇이 잘못됐는지는
 * 내용이 아니라 판단에 필요한 사실이므로 첫 줄을 그대로 싣는다.
 */
const CONTENT_RESULT_TOOLS = new Set([
  "Read", "NotebookRead", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent",
]);

/**
 * 좌표가 파일을 가리키는 입력 필드. NotebookEdit만 `notebook_path`를 쓰므로 이 목록에서 빠지면
 * 노트북 편집은 대상도 변경 장부도 Theater 밖 표식도 없이 지나간다.
 */
const PATH_KEYS = ["file_path", "path", "notebook_path"];

interface TranscriptContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly id?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
  readonly is_error?: unknown;
}

interface TranscriptLine {
  readonly type?: unknown;
  readonly isMeta?: unknown;
  readonly isSidechain?: unknown;
  readonly isCompactSummary?: unknown;
  readonly timestamp?: unknown;
  readonly message?: {
    readonly role?: unknown;
    readonly content?: unknown;
  };
}

/** 경로 표시를 cwd 기준으로 상대화하기 위한 매퍼 옵션. */
export interface ChatEventMapOptions {
  readonly cwd?: string;
  /**
   * tool_use id → 도구 이름. 결과 블록은 자기가 어떤 도구의 결말인지 모르므로, 무엇을 요약해도
   * 되는지 판단하려면 이 축이 필요하다. 세션이 소유하고 매퍼는 읽기만 한다.
   */
  readonly toolNames?: ReadonlyMap<string, string>;
}

/**
 * 트랜스크립트 한 줄을 이벤트 목록으로 옮긴다. 대화가 아닌 줄(mode/snapshot/attachment 등),
 * meta 줄, sidechain(서브에이전트) 줄은 빈 목록이다.
 */
export function chatEventsFromTranscriptLine(raw: string, options: ChatEventMapOptions = {}): readonly AgentChatStreamEvent[] {
  return chatReplayFromTranscriptLine(raw, options).events;
}

/**
 * 재생이 쓰는 형태 — 이벤트와 함께 그 줄의 시각을 돌려준다. 재생 턴에는 turn-end가 없어
 * 소요 시간을 말할 수 없는데, 트랜스크립트가 이미 그 값을 들고 있다: 디스패치 줄의 시각과
 * 그 턴 마지막 줄의 시각 차이다. 한 번의 파싱으로 둘 다 얻으려고 매핑과 같은 문을 쓴다.
 */
export function chatReplayFromTranscriptLine(
  raw: string,
  options: ChatEventMapOptions = {},
): { readonly at?: number; readonly events: readonly AgentChatStreamEvent[] } {
  let line: TranscriptLine;
  try {
    line = JSON.parse(raw) as TranscriptLine;
  } catch {
    return { events: [] };
  }
  const parsedAt = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  const events = eventsFromTranscriptLine(line, options);
  return Number.isFinite(parsedAt) ? { at: parsedAt, events } : { events };
}

function eventsFromTranscriptLine(line: TranscriptLine, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  // auto-compact가 남긴 이어짐 요약은 런타임 메타다 — 사람이 친 지시처럼 재생하면
  // "전환이 세션을 summarize했다"로 읽힌다. isMeta가 없는 별도 플래그라 따로 거른다.
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true) return [];
  const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  const atField = Number.isFinite(at) ? { at } : {};
  if (line.type === "user") {
    // 도구 응답을 실은 user 줄은 사람이 친 지시가 아니다 — 재생에서도 스텝의 결말로 옮긴다.
    const results = toolResultsFrom(line.message?.content, options);
    if (results.length > 0) return results;
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
 * 이미 dispatch로 저널에 올랐으므로 여기서는 assistant·user(도구 응답)·result만 본다.
 */
export function chatEventsFromSdkMessage(message: {
  readonly type: string;
  readonly [key: string]: unknown;
}, options: ChatEventMapOptions = {}): readonly AgentChatStreamEvent[] {
  if (message.type === "stream_event") {
    // 모양은 fleet-analyst가 실측으로 고정한 것과 동일하다. text_delta와 tool_use 블록의
    // 시작만 취한다 — thinking_delta는 공개 출력 금지 불변식에 따라 버리고, input_json_delta는
    // 부분 인자라 좌표로 쓸 수 없다(완성 tool 이벤트가 그 자리를 채운다).
    const inner = (message as { readonly event?: unknown }).event;
    if (!inner || typeof inner !== "object") return [];
    const innerType = (inner as { readonly type?: unknown }).type;
    if (innerType === "content_block_start") {
      const block = (inner as { readonly content_block?: unknown }).content_block;
      if (!block || typeof block !== "object") return [];
      const start = block as { readonly type?: unknown; readonly id?: unknown; readonly name?: unknown };
      if (start.type !== "tool_use") return [];
      if (typeof start.id !== "string" || start.id.length === 0) return [];
      if (typeof start.name !== "string" || start.name.length === 0) return [];
      return [{ kind: "tool-start", id: start.id, name: start.name }];
    }
    if (innerType !== "content_block_delta") return [];
    const delta = (inner as { readonly delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") return [];
    const text = (delta as { readonly type?: unknown; readonly text?: unknown });
    if (text.type === "text_delta" && typeof text.text === "string" && text.text.length > 0) {
      return [{ kind: "text-delta", text: capText(text.text) }];
    }
    return [];
  }
  if (message.type === "assistant") {
    const body = (message as { readonly message?: { readonly content?: unknown } }).message;
    return eventsFromAssistantContent(body?.content, options);
  }
  if (message.type === "user") {
    const body = (message as { readonly message?: { readonly content?: unknown } }).message;
    return toolResultsFrom(body?.content, options);
  }
  if (message.type === "result") {
    const durationMs = (message as { readonly duration_ms?: unknown }).duration_ms;
    const ok = (message as { readonly is_error?: unknown }).is_error !== true;
    const result = (message as { readonly result?: unknown }).result;
    return [{
      kind: "turn-end",
      ok,
      ...(typeof durationMs === "number" && Number.isFinite(durationMs) ? { durationMs } : {}),
      ...(ok && typeof result === "string" && result.trim().length > 0 ? { answer: capText(result) } : {}),
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
      const change = changeFromToolInput(block.name, block.input, options);
      events.push({
        kind: "tool",
        name: block.name,
        detail: summarizeToolInput(block.input, options),
        ...(typeof block.id === "string" && block.id.length > 0 ? { id: block.id } : {}),
        ...(pathIsOutsideCwd(block.input, options.cwd) ? { outside: true } : {}),
        ...(change ? { change } : {}),
      });
    }
    // thinking·redacted_thinking은 의도적으로 버린다.
  }
  return events;
}

/** user 줄에 실린 tool_result 블록들을 스텝의 결말로 옮긴다. */
function toolResultsFrom(content: unknown, options: ChatEventMapOptions): readonly AgentChatStreamEvent[] {
  if (!Array.isArray(content)) return [];
  const events: AgentChatStreamEvent[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
    if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) continue;
    const ok = block.is_error !== true;
    const tool = options.toolNames?.get(block.tool_use_id);
    const quiet = ok && tool !== undefined && (CONTENT_RESULT_TOOLS.has(tool) || WRITE_TOOLS.has(tool));
    events.push({
      kind: "tool-result",
      id: block.tool_use_id,
      ok,
      summary: quiet ? "" : summarizeToolResult(block.content, options),
    });
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
  for (const key of PATH_KEYS.concat(["command", "pattern", "url", "query", "description", "prompt", "subject"])) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const flat = value.replace(/\s+/g, " ").trim();
      const shown = PATH_KEYS.includes(key)
        ? displayPath(flat, options.cwd)
        : normalizePathTokens(flat, options.cwd);
      return shown.length > MAX_TOOL_DETAIL_CHARS ? `${shown.slice(0, MAX_TOOL_DETAIL_CHARS - 1)}…` : shown;
    }
  }
  return "";
}

/**
 * 도구 결과에서 한 줄 요약을 뽑는다. 도구가 돌려준 본문 전체는 싣지 않는다 — 첫 줄만,
 * 상한 아래로, 경로 정규화와 자격 증명 마스킹을 통과시킨다. 모델이 고른 문장이 아니라
 * 실행 결과가 그대로 흐르는 경로이므로, 도구 입력 요약보다 좁은 문을 지난다.
 */
export function summarizeToolResult(content: unknown, options: ChatEventMapOptions = {}): string {
  const text = readResultText(content);
  if (text === null) return "";
  const first = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return "";
  const flat = normalizePathTokens(first.replace(/\s+/g, " ").trim(), options.cwd);
  const masked = maskSecrets(abbreviateAbsolutePaths(flat));
  return masked.length > MAX_TOOL_RESULT_CHARS ? `${masked.slice(0, MAX_TOOL_RESULT_CHARS - 1)}…` : masked;
}

/**
 * cwd·홈 정규화를 지나고도 남은 절대 경로를 표시형으로 접는다. 도구 결과는 실행 출력이 그대로
 * 흐르는 경로라 우리 두 접두 밖의 절대 경로가 원문으로 나갈 수 있다 — 실측에서 실패한 쓰기의
 * EACCES 메시지가 다른 사용자의 홈 경로를 실어 왔다. 원장의 경로 필드가 이미 쓰는 규칙과 같게
 * 마지막 두 조각만 남긴다. URL(`scheme://…`)과 이미 정규화된 `./`·`~/`는 건드리지 않는다.
 */
function abbreviateAbsolutePaths(value: string): string {
  return value.replace(/(?<![\w:~./])(?:\/[A-Za-z0-9._@+-]+){2,}/g, (match) => {
    const segments = match.split("/").filter((segment) => segment.length > 0);
    return `…/${segments.slice(-2).join("/")}`;
  });
}

function readResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content as readonly TranscriptContentBlock[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * 눈에 띄는 자격 증명 모양을 가린다. 완전한 비밀 탐지가 아니라, 실행 출력이 그대로 흐르는
 * 경로에서 가장 흔한 토큰 모양이 원문으로 남지 않게 하는 최소 방어다.
 */
function maskSecrets(value: string): string {
  return value
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "$1-…")
    .replace(/\b(gh[pousr]|xox[baprs])_[A-Za-z0-9_-]{16,}/g, "$1_…")
    .replace(/\bAKIA[0-9A-Z]{12,}/g, "AKIA…")
    .replace(/\b(?:Bearer|Authorization:)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer …")
    .replace(/\beyJ[A-Za-z0-9._-]{24,}/g, "eyJ…");
}

/**
 * 쓰기 계열 도구의 입력에서 변경 한 건을 접는다. 파일 본문은 싣지 않고 줄 수만 센다 —
 * "무엇이 얼마나 바뀌었는가"는 좌표이지 내용이 아니다.
 */
export function changeFromToolInput(name: string, input: unknown, options: ChatEventMapOptions = {}): AgentChatChange | null {
  if (!WRITE_TOOLS.has(name)) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const raw = PATH_KEYS
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
  if (raw === null) return null;
  const file = displayPath(raw.trim(), options.cwd);
  if (name === "Write") {
    return { file, added: lineCount(record.content), removed: 0 };
  }
  if (name === "Edit") {
    return { file, added: lineCount(record.new_string), removed: lineCount(record.old_string) };
  }
  if (name === "MultiEdit") {
    let added = 0;
    let removed = 0;
    const edits = Array.isArray(record.edits) ? record.edits : [];
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const entry = edit as Record<string, unknown>;
      added += lineCount(entry.new_string);
      removed += lineCount(entry.old_string);
    }
    return { file, added, removed };
  }
  // NotebookEdit는 셀 단위라 줄 수를 세지 않는다 — 파일이 바뀌었다는 사실만 장부에 올린다.
  return { file, added: 0, removed: 0 };
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  return value.replace(/\n$/, "").split("\n").length;
}

/** 도구 입력의 경로 좌표가 Operation cwd 밖을 가리키는지. 좌표가 없으면 false다. */
export function pathIsOutsideCwd(input: unknown, cwd: string | undefined): boolean {
  if (!cwd || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const normalized = value.trim().replace(/\\/g, "/");
    if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return false;
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root.length <= 1) return false;
    return normalized !== root && !normalized.startsWith(`${root}/`);
  }
  return false;
}

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

/**
 * 절대 경로를 브라우저 표시형으로 옮긴다: Operation cwd 안이면 상대 경로, 밖이면 마지막 두
 * 조각만 남긴 축약형이다. 상대 경로는 이미 안전하므로 그대로 둔다.
 */
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
