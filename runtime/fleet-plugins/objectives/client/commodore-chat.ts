import type { AgentChatTranscriptEntry, AgentChatTranscriptEvent, AgentConversationEntry } from "@fleet-console/sdk/components/agent-chat-transcript";
import type { ConversationSpeaker } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { CommodoreAsk, CommodoreLiveEvent, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import type { Objective } from "../server/types.js";
import { clockTime } from "./commodore-header.js";
import { objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관 기록 → Operation 채팅 어휘. 화면은 호스트의 채팅 턴 렌더러(`ctx.chat.Transcript`)가 그리고, 여기는 서버가 정제해 쌓은
 * 기록 줄을 그 어휘로 옮기기만 한다. 깨움은 출처 줄로 턴을 열고, 사람의 말은 말풍선(턴 중이면 그 턴 안), 글은 마크다운 답,
 * 도구는 이름과 한 줄 요약(입력 전체는 기록에 없다)이다. 사고는 채팅처럼 내용을 그리지 않는다. 세션 교대와 오류는 구분선이다.
 * 저장하지 않는 라이브 사건(글자 흐름·진행 중 도구 이름)은 마지막 확정 줄 뒤에 이어 붙는다 — 확정 줄이 오면 그 몫은 버려진다.
 */
export function commodoreChatEntries(t: T, entries: readonly CommodoreTranscriptEntry[], live: readonly CommodoreLiveEvent[], asks?: readonly CommodoreAsk[]): readonly AgentChatTranscriptEntry[] {
  const out: AgentChatTranscriptEntry[] = [];
  const push = (event: AgentChatTranscriptEvent, at?: number) => out.push(at !== undefined ? { event, at } : { event });
  const undelivered = new Set(entries.flatMap((entry) => (entry.kind === "undelivered" ? entry.seqs : [])));
  let turnAt: number | null = null;
  // 턴 안의 압축은 그 턴이 닫힌 뒤 구분선으로 선다 — 턴 한가운데의 구분선은 턴을 둘로 가른다(턴 묶음은 구분선에서 끊긴다).
  let heldNotes: { readonly text: string; readonly at: number }[] = [];
  // 읽어 온 기록 창은 아무 줄에서나 시작한다(쪽·보관 상한) — 깨움이 창 밖인 턴의 내용·결말이 먼저 오면 그 자리에서 턴을 연다.
  // 열지 않으면 결말이 턴을 닫지 못해, 지난 턴이 「작업 중」으로 굳고 답이 가려진다.
  const resume = (at: number) => {
    if (turnAt !== null) return;
    push({ kind: "turn-start", at }, at);
    turnAt = at;
  };
  const end = (at: number, outcome: "ok" | "error" | "cancelled") => {
    if (turnAt === null) return;
    push({ kind: "turn-end", ok: outcome !== "error", ...(outcome === "cancelled" ? { stopped: true } : {}), durationMs: Math.max(0, at - turnAt) }, at);
    turnAt = null;
    for (const note of heldNotes) push({ kind: "note", text: note.text, at: note.at }, note.at);
    heldNotes = [];
  };
  for (const entry of entries) {
    switch (entry.kind) {
      case "wake":
        if (turnAt !== null) end(entry.at, "ok");
        push({ kind: "dispatch", text: entry.reasons.map((reason) => reasonWord(t, reason)).join(" · "), at: entry.at, by: { kind: "plugin", pluginId: "objectives", label: t("objectives.commodore.log.woke") } }, entry.at);
        push({ kind: "turn-start", at: entry.at }, entry.at);
        turnAt = entry.at;
        break;
      case "message": {
        const text = entry.objective ? `[${entry.objective.title} · ${entry.objective.id}]\n${entry.text}` : entry.text;
        const attachments = entry.attachments?.map(({ id }) => ({ reference: id }));
        if (turnAt !== null) push({ kind: "turn-inject", text, ...(attachments?.length ? { attachments } : {}), at: entry.at }, entry.at);
        else {
          // 쉬는 동안 받은 말은 말풍선 하나다 — 그 말이 깨운 턴은 뒤따르는 깨움 줄이 연다. 열린 채 두면 빈 턴이 「작업 중」으로 선다.
          push({ kind: "dispatch", text, ...(attachments?.length ? { attachments } : {}), at: entry.at, ...(undelivered.has(entry.seq) ? { undelivered: true as const } : {}) }, entry.at);
          push({ kind: "turn-end", ok: true }, entry.at);
        }
        break;
      }
      case "text":
        resume(entry.at);
        if (entry.text.trim()) push({ kind: "text", text: entry.text }, entry.at);
        break;
      case "tool": {
        resume(entry.at);
        const id = `c${entry.seq}`;
        push({ kind: "tool", id, name: entry.name, detail: toolDetail(t, entry) }, entry.at);
        if (entry.ok !== undefined) push({ kind: "tool-result", id, ok: entry.ok, summary: entry.error ? errorWord(t, entry.error) : "" }, entry.at);
        break;
      }
      case "result":
        resume(entry.at);
        end(entry.at, entry.outcome);
        if (entry.outcome === "error") push({ kind: "note", text: t("objectives.commodore.log.turnError", { reason: entry.error ? errorWord(t, entry.error) : t("objectives.commodore.meta.error") }), at: entry.at, tone: "warn" }, entry.at);
        break;
      case "compacted":
        if (turnAt !== null) heldNotes.push({ text: compactedText(t, entry), at: entry.at });
        else push({ kind: "note", text: compactedText(t, entry), at: entry.at }, entry.at);
        break;
      case "session":
        end(entry.at, "cancelled");
        push({ kind: "note", text: [t(`objectives.commodore.log.session.${entry.event}`), ...(entry.reason ? [fallbackWord(t, entry.reason)] : [])].filter(Boolean).join(" · "), at: entry.at }, entry.at);
        break;
      case "error": {
        end(entry.at, "error");
        const code = errorWord(t, entry.code);
        push({ kind: "note", text: entry.retryAt ? t("objectives.commodore.log.errorRetry", { code, time: clockTime(entry.retryAt) }) : t("objectives.commodore.log.error", { code }), at: entry.at, tone: "warn" }, entry.at);
        break;
      }
      // 사령관이 물었다 — 그 턴 안의 글로 선다(이유·질문·선택지). 지금 상태(답을 기다림·답함·거둠)는 상태의 질문에서 읽는다.
      case "ask":
        resume(entry.at);
        push({ kind: "text", text: askMarkdown(t, entry, asks) }, entry.at);
        break;
      // 사람이 답했다 — 사람의 말처럼 선다(턴 중이면 그 턴 안).
      case "ask-answered": {
        const text = answeredText(t, entry);
        if (turnAt !== null) push({ kind: "turn-inject", text, at: entry.at }, entry.at);
        else {
          push({ kind: "dispatch", text, at: entry.at }, entry.at);
          push({ kind: "turn-end", ok: true }, entry.at);
        }
        break;
      }
      case "thinking":
      case "undelivered":
        break;
    }
  }
  if (turnAt !== null) {
    live.forEach((event, index) => {
      if (event.kind === "text-delta") push({ kind: "text-delta", text: event.text });
      else push({ kind: "tool-start", id: `live${index}`, name: event.name });
    });
  }
  return out;
}

/**
 * 사령관 기록 → 대화 중심 화면의 대화 어휘(SDK `ctx.chat.Conversation`). Operation 대화와 같은 문법이다: 사람의 말은 오른쪽 말풍선,
 * 사령관의 글은 왼쪽 말풍선(턴 안의 글마다 하나 — 그룹 대화의 저널과 같다), 보드에 쓴 행위는 가운데 행위 줄, 세션 교대·실패는
 * 노트 줄이다. 보드를 읽기만 한 도구는 Operation 대화가 도구 단계를 본류에 두지 않듯 세우지 않는다. 사람의 말이 깨운 턴은 그
 * 말풍선이 원인이라 깨움 줄을 따로 세우지 않고, 그 밖의 깨움(자율 운영 켬·보드 바뀜·순찰 등)만 노트 줄로 남긴다.
 * 라이브 글자 흐름은 마지막 확정 줄 뒤의 흐르는 말풍선 하나다.
 */
export function commodoreConversationEntries(t: T, theaterId: string, entries: readonly CommodoreTranscriptEntry[], live: readonly CommodoreLiveEvent[], objectives: readonly Objective[], asks?: readonly CommodoreAsk[]): readonly AgentConversationEntry[] {
  const commodore: ConversationSpeaker = { kind: "commodore", name: t("objectives.commodore.name") };
  const human: ConversationSpeaker = { kind: "human", name: "Human" };
  const undelivered = new Set(entries.flatMap((entry) => (entry.kind === "undelivered" ? entry.seqs : [])));
  const out: AgentConversationEntry[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "wake": {
        if (entry.reasons.every((reason) => reason === "message" || reason.startsWith("message:"))) break;
        out.push({ kind: "note", id: `c${entry.seq}`, at: entry.at, text: [t("objectives.commodore.log.woke"), ...entry.reasons.map((reason) => reasonWord(t, reason))].join(" · ") });
        break;
      }
      case "message": {
        const text = entry.objective ? `[${entry.objective.title} · ${entry.objective.id}]\n${entry.text}` : entry.text;
        const attachments = entry.attachments?.map(({ id }) => ({ reference: id }));
        out.push({ kind: "message", id: `c${entry.seq}`, at: entry.at, operationId: "", speaker: human, text, streaming: false,
          ...(attachments?.length ? { attachments } : {}), ...(undelivered.has(entry.seq) ? { undelivered: true as const } : {}) });
        break;
      }
      case "text":
        if (entry.text.trim()) out.push({ kind: "message", id: `c${entry.seq}`, at: entry.at, operationId: "", speaker: commodore, text: entry.text, format: "markdown", streaming: false });
        break;
      case "tool": {
        if (!entry.action) break;
        const failed = entry.ok === false ? errorWord(t, entry.error ?? "failed") : null;
        out.push({ kind: "board-action", id: `c${entry.seq}`, at: entry.at, speaker: commodore, objectiveId: entry.objectiveId ?? "",
          action: [actionWord(t, entry.action), entry.title, failed].filter(Boolean).join(" · "),
          text: actionReason(theaterId, objectives, entry) ?? "" });
        break;
      }
      case "result":
        if (entry.outcome === "error") out.push({ kind: "note", id: `c${entry.seq}`, at: entry.at, tone: "warn", text: t("objectives.commodore.log.turnError", { reason: entry.error ? errorWord(t, entry.error) : t("objectives.commodore.meta.error") }) });
        break;
      case "compacted":
        out.push({ kind: "note", id: `c${entry.seq}`, at: entry.at, text: compactedText(t, entry) });
        break;
      case "session":
        out.push({ kind: "note", id: `c${entry.seq}`, at: entry.at, text: [t(`objectives.commodore.log.session.${entry.event}`), ...(entry.reason ? [fallbackWord(t, entry.reason)] : [])].filter(Boolean).join(" · ") });
        break;
      case "error": {
        const code = errorWord(t, entry.code);
        out.push({ kind: "note", id: `c${entry.seq}`, at: entry.at, tone: "warn", text: entry.retryAt ? t("objectives.commodore.log.errorRetry", { code, time: clockTime(entry.retryAt) }) : t("objectives.commodore.log.error", { code }) });
        break;
      }
      // 물음과 답은 보드 행위 줄과 같은 가운데 줄이다 — 물음은 사령관, 답은 사람이 낸 줄. 펼치면 이유·질문(답)이 선다.
      case "ask": {
        const status = askStatusWord(t, entry.askId, asks);
        out.push({ kind: "board-action", id: `c${entry.seq}`, at: entry.at, speaker: commodore, objectiveId: entry.objective?.id ?? "",
          action: [t("objectives.ask.logged"), entry.objective?.title, status].filter(Boolean).join(" · "),
          text: [entry.reason, ...entry.questions.map((question, index) => questionLine(t, question, entry.questions.length > 1 ? index + 1 : 0))].join("\n") });
        break;
      }
      case "ask-answered":
        out.push({ kind: "board-action", id: `c${entry.seq}`, at: entry.at, speaker: human, objectiveId: "",
          action: t("objectives.ask.answered"), text: entry.answers.map((answer) => `${answer.question}\n→ ${answerWords(answer)}`).join("\n") });
        break;
      case "thinking":
      case "undelivered":
      case "wake-scope":
        break;
    }
  }
  return commodoreConversationLiveEntries(t, entries, live, out);
}

/** 확정 투영은 그대로 두고 흐르는 말 하나만 붙인다 — 델타마다 지난 말풍선 객체를 다시 만들지 않는다. */
export function commodoreConversationLiveEntries(t: T, entries: readonly CommodoreTranscriptEntry[], live: readonly CommodoreLiveEvent[], confirmed: readonly AgentConversationEntry[]): readonly AgentConversationEntry[] {
  const boundary = entries.findLast((entry) => entry.kind === "wake" || entry.kind === "result" || entry.kind === "session" || entry.kind === "error");
  const streamed = boundary?.kind === "wake" ? live.filter((event) => event.kind === "text-delta").map((event) => event.text).join("") : "";
  return streamed ? [...confirmed, { kind: "message", id: "live", at: null, operationId: "", speaker: { kind: "commodore", name: t("objectives.commodore.name") }, text: streamed, format: "markdown", streaming: true }] : confirmed;
}

/** 압축 구분선 — 같은 세션이 대화를 요약해 이어 갔다. 압축 전후의 문맥 크기를 함께 말한다. */
function compactedText(t: T, entry: Extract<CommodoreTranscriptEntry, { kind: "compacted" }>): string {
  const tokens = entry.postTokens !== undefined
    ? `${formatContextTokens(entry.preTokens)} → ${formatContextTokens(entry.postTokens)}`
    : formatContextTokens(entry.preTokens);
  return t("objectives.commodore.log.compacted", { tokens });
}

/** 문맥 토큰을 사람이 읽는 크기로(1.2k·750k·1M). */
export function formatContextTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const text = millions < 10 ? millions.toFixed(1) : String(Math.round(millions));
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}M`;
  }
  const thousands = tokens / 1_000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * 행위 줄을 펼치면 서는 이유 — 보드가 그 행위에 남긴 사령관의 「왜」. 같은 목표에서 이 사령관이 한 행위 중 시각이 가장 가까운 것(1분 안).
 * 도구의 action 낱말과 보드의 행위 kind 는 같지 않을 수 있어(edit_brief → edit) kind 로 거르지 않는다. 결정 응답은 결정 기록에서 찾는다.
 */
function actionReason(theaterId: string, objectives: readonly Objective[], tool: Extract<CommodoreTranscriptEntry, { kind: "tool" }>): string | undefined {
  const objective = tool.objectiveId ? objectives.find((candidate) => candidate.id === tool.objectiveId) : undefined;
  if (!objective) return undefined;
  const mine = (by: unknown): by is { readonly kind: "commodore"; readonly theaterId: string; readonly why?: string } =>
    typeof by === "object" && by !== null && (by as { kind?: unknown }).kind === "commodore" && (by as { theaterId?: unknown }).theaterId === theaterId;
  const candidates = tool.action === "answer"
    ? objective.decisions.flatMap((decision) => (mine(decision.by) ? [{ at: decision.at, why: decision.by.why }] : []))
    : (objective.actions ?? []).flatMap((action) => (mine(action.by) ? [{ at: action.at, why: action.by.why }] : []));
  let best: { readonly at: number; readonly why?: string | undefined } | undefined;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.at - tool.at);
    if (distance <= 60_000 && (!best || distance < Math.abs(best.at - tool.at))) best = candidate;
  }
  return best?.why?.trim() || undefined;
}

/**
 * 곁 칸·목표 대화가 가리킨 시각의 줄 — 그 시각 뒤 1분 안의 첫 행위 줄(보드 행위 시각은 기록 줄보다 조금 앞선다), 없으면 그 시각
 * 이하의 마지막 줄. 기록 창이 그 시각까지 닿지 않으면 null 이다(더 읽어야 한다).
 */
export function commodoreConversationTarget(entries: readonly AgentConversationEntry[], at: number): string | null {
  const action = entries.find((entry) => entry.kind === "board-action" && entry.at !== null && entry.at >= at && entry.at - at <= 60_000);
  if (action) return action.id;
  let found: string | null = null;
  for (const entry of entries) {
    if (entry.at === null) continue;
    if (entry.at <= at) found = entry.id;
    else break;
  }
  return found;
}

/**
 * 시트 기록의 한 턴. 진행 중인 턴과 마지막으로 끝난 턴만 펼치고, 그 전 턴은 이 요약 한 줄로 접는다.
 * `entries`는 그 턴만의 채팅 어휘다. `id`는 시각과 그 시각 안에서의 순번이라, 앞쪽에 이전 기록을 붙여도 바뀌지 않는다.
 */
export interface CommodoreLogTurn {
  readonly id: string;
  readonly at: number;
  /** 사람의 말풍선이면 참. 깨어남이면 출처 줄이 이미 라벨이라 펼친 본문에서는 출처 줄을 다시 그리지 않는다. */
  readonly message: boolean;
  readonly label: string;
  /** 답의 첫 줄. 답이 없으면 첫 도구 줄. */
  readonly summary: string;
  readonly durationMs?: number;
  readonly failed: boolean;
  readonly stopped: boolean;
  readonly working: boolean;
  readonly entries: readonly AgentChatTranscriptEntry[];
}

export type CommodoreLogBlock =
  | { readonly kind: "turn"; readonly turn: CommodoreLogTurn }
  | { readonly kind: "note"; readonly text: string; readonly at?: number; readonly tone?: "warn" };

/** 채팅 어휘를 턴과 구분선으로 가른다. 접힘은 그리는 쪽이 정하고, 여기서는 줄을 만들기 위한 사실만 뽑는다. */
export function commodoreLogBlocks(t: T, entries: readonly CommodoreTranscriptEntry[], live: readonly CommodoreLiveEvent[], asks?: readonly CommodoreAsk[]): readonly CommodoreLogBlock[] {
  const chat = commodoreChatEntries(t, entries, live, asks);
  const blocks: CommodoreLogBlock[] = [];
  const ordinal = new Map<number, number>();
  let bucket: AgentChatTranscriptEntry[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const turn = describeTurn(t, bucket, ordinal);
    if (turn) blocks.push({ kind: "turn", turn });
    bucket = [];
  };
  for (const entry of chat) {
    const event = entry.event;
    if (event.kind === "note") {
      flush();
      blocks.push({ kind: "note", text: event.text, ...(entry.at !== undefined ? { at: entry.at } : event.at !== undefined ? { at: event.at } : {}), ...(event.tone ? { tone: event.tone } : {}) });
      continue;
    }
    if (event.kind === "dispatch" && bucket.length > 0) flush();
    bucket.push(entry);
    if (event.kind === "turn-end") flush();
  }
  flush();
  return blocks;
}

/** 그 시각에 이미 시작돼 있던 마지막 턴. 곁 칸의 「드러내기」가 접힌 턴을 다시 펼칠 때 쓴다. */
export function commodoreTurnCovering(blocks: readonly CommodoreLogBlock[], at: number): CommodoreLogTurn | null {
  let found: CommodoreLogTurn | null = null;
  for (const block of blocks) {
    if (block.kind !== "turn") continue;
    if (block.turn.at <= at) found = block.turn;
    else break;
  }
  return found;
}

function describeTurn(t: T, bucket: readonly AgentChatTranscriptEntry[], ordinal: Map<number, number>): CommodoreLogTurn | null {
  const dispatch = bucket.find((entry) => entry.event.kind === "dispatch");
  const end = bucket.find((entry) => entry.event.kind === "turn-end");
  const at = dispatch?.at ?? bucket.find((entry) => entry.at !== undefined)?.at;
  if (at === undefined) return null;
  const seen = ordinal.get(at) ?? 0;
  ordinal.set(at, seen + 1);
  const message = dispatch?.event.kind === "dispatch" && dispatch.event.by === undefined;
  const dispatchText = dispatch?.event.kind === "dispatch" ? dispatch.event.text : "";
  const answer = [...bucket].reverse().find((entry) => entry.event.kind === "text");
  const answerText = answer?.event.kind === "text" ? answer.event.text : "";
  const tool = bucket.find((entry) => entry.event.kind === "tool" && entry.event.detail.trim().length > 0);
  const toolText = tool?.event.kind === "tool" ? tool.event.detail : "";
  const summary = message ? plainFirstLine(dispatchText) : plainFirstLine(answerText) || plainFirstLine(toolText);
  const durationMs = end?.event.kind === "turn-end" ? end.event.durationMs : undefined;
  return {
    id: `${at}:${seen}`,
    at,
    message,
    label: message ? t("objectives.commodore.log.message") : dispatchText,
    summary,
    ...(durationMs !== undefined && durationMs >= 1000 ? { durationMs } : {}),
    failed: end?.event.kind === "turn-end" && end.event.ok === false,
    stopped: end?.event.kind === "turn-end" && end.event.stopped === true,
    working: end === undefined && bucket.some((entry) => entry.event.kind === "turn-start"),
    entries: bucket,
  };
}

/** 답의 첫 줄. 접힌 줄은 이 한 줄만 보여주고, 마크다운 기호는 읽기에 방해되므로 걷는다. */
function plainFirstLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/** 도구 줄의 한 줄 — 보드 행위면 「행위 · 목표 제목」, 아니면 기록이 남긴 요약. */
function toolDetail(t: T, tool: Extract<CommodoreTranscriptEntry, { kind: "tool" }>): string {
  if (tool.action) return [actionWord(t, tool.action), tool.title].filter(Boolean).join(" · ");
  return tool.summary ?? "";
}

/* ── 사령관의 질문 줄 ─────────────────────────────────────────────── */

type AskEntry = Extract<CommodoreTranscriptEntry, { kind: "ask" }>;
type AnsweredEntry = Extract<CommodoreTranscriptEntry, { kind: "ask-answered" }>;

/** 질문의 지금 — 상태에 남은 질문에서 읽는다. 보관 상한 밖으로 밀려난 질문은 모른다(말하지 않는다). */
function askStatusWord(t: T, askId: string, asks: readonly CommodoreAsk[] | undefined): string | null {
  const ask = asks?.find((candidate) => candidate.id === askId);
  if (!ask) return null;
  if (!ask.settled) return t("objectives.ask.status.open");
  return t(ask.settled.outcome === "withdrawn" ? "objectives.ask.status.withdrawn" : "objectives.ask.status.answered");
}

/** 질문 한 줄 — 번호(여럿일 때), 질문, 선택지 이름(「 / 」로 잇는다), 여러 개 고르기 표시. */
function questionLine(t: T, question: AskEntry["questions"][number], n: number): string {
  const options = question.options.length ? ` — ${question.options.join(" / ")}${question.multiSelect ? ` (${t("objectives.ask.multi")})` : ""}` : "";
  return `${n ? `${n}. ` : ""}${question.text}${options}`;
}

const answerWords = (answer: AnsweredEntry["answers"][number]): string => [answer.selected.join(" · "), answer.text.trim()].filter(Boolean).join(" — ");

function askMarkdown(t: T, entry: AskEntry, asks: readonly CommodoreAsk[] | undefined): string {
  const head = [`**${t("objectives.ask.logged")}**`, entry.objective?.title, askStatusWord(t, entry.askId, asks)].filter(Boolean).join(" · ");
  const lines = entry.questions.map((question, index) => `- ${questionLine(t, question, entry.questions.length > 1 ? index + 1 : 0)}`);
  return [head, `> ${entry.reason.replaceAll("\n", "\n> ")}`, ...lines].join("\n\n");
}

function answeredText(t: T, entry: AnsweredEntry): string {
  return [t("objectives.ask.answered"), ...entry.answers.map((answer) => `${answer.question}\n→ ${answerWords(answer)}`)].join("\n");
}

export function errorWord(t: T, code: string): string {
  const key = `objectives.commodore.errorCode.${code}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : code;
}

/** 깨움 이유 — `code` 또는 `code:N` 토큰. 모르는 토큰(문장)은 그대로 보인다. */
export function reasonWord(t: T, reason: string): string {
  const match = /^([a-z][a-z-]*)(?::(\d+))?$/.exec(reason);
  if (!match) return reason;
  const key = `objectives.commodore.reason.${match[1]}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey, { n: match[2] ?? "" }).trim() : reason;
}

/** 세션 기록의 로스터 폴백(`fallback:<reason>:<model>`) — 실제로 도는 모델과 사유. 다른 사유는 표시하지 않는다. */
export function fallbackWord(t: T, reason: string): string {
  const match = /^fallback:(model_off|roster_empty):(.+)$/u.exec(reason);
  if (!match) return "";
  return t(match[1] === "roster_empty" ? "objectives.commodore.log.fallback.rosterEmpty" : "objectives.commodore.log.fallback.modelOff", { model: match[2]! });
}

export function actionWord(t: T, action: string): string {
  const key = `objectives.commodore.action.${action}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : action;
}
