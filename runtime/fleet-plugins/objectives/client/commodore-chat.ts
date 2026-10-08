import type { AgentChatTranscriptEntry, AgentChatTranscriptEvent } from "@fleet-console/sdk/components/agent-chat-transcript";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { CommodoreLiveEvent, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { clockTime } from "./commodore-row.js";
import { objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 사령관 기록 → Operation 채팅 어휘. 화면은 호스트의 채팅 턴 렌더러(`ctx.chat.Transcript`)가 그리고, 여기는 서버가 정제해 쌓은
 * 기록 줄을 그 어휘로 옮기기만 한다. 깨움은 출처 줄로 턴을 열고, 사람의 말은 말풍선(턴 중이면 그 턴 안), 글은 마크다운 답,
 * 도구는 이름과 한 줄 요약(입력 전체는 기록에 없다)이다. 사고는 채팅처럼 내용을 그리지 않는다. 세션 교대와 오류는 구분선이다.
 * 저장하지 않는 라이브 사건(글자 흐름·진행 중 도구 이름)은 마지막 확정 줄 뒤에 이어 붙는다 — 확정 줄이 오면 그 몫은 버려진다.
 */
export function commodoreChatEntries(t: T, entries: readonly CommodoreTranscriptEntry[], live: readonly CommodoreLiveEvent[]): readonly AgentChatTranscriptEntry[] {
  const out: AgentChatTranscriptEntry[] = [];
  const push = (event: AgentChatTranscriptEvent, at?: number) => out.push(at !== undefined ? { event, at } : { event });
  const undelivered = new Set(entries.flatMap((entry) => (entry.kind === "undelivered" ? entry.seqs : [])));
  let turnAt: number | null = null;
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
  };
  for (const entry of entries) {
    switch (entry.kind) {
      case "wake":
        if (turnAt !== null) end(entry.at, "ok");
        push({ kind: "dispatch", text: entry.reasons.map((reason) => reasonWord(t, reason)).join(" · "), at: entry.at, by: { kind: "plugin", pluginId: "objectives", label: t("objectives.commodore.log.woke") } }, entry.at);
        push({ kind: "turn-start", at: entry.at }, entry.at);
        turnAt = entry.at;
        break;
      case "message":
        if (turnAt !== null) push({ kind: "turn-inject", text: entry.text, at: entry.at }, entry.at);
        else {
          // 쉬는 동안 받은 말은 말풍선 하나다 — 그 말이 깨운 턴은 뒤따르는 깨움 줄이 연다. 열린 채 두면 빈 턴이 「작업 중」으로 선다.
          push({ kind: "dispatch", text: entry.text, at: entry.at, ...(undelivered.has(entry.seq) ? { undelivered: true as const } : {}) }, entry.at);
          push({ kind: "turn-end", ok: true }, entry.at);
        }
        break;
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
export function commodoreLogBlocks(t: T, entries: readonly CommodoreTranscriptEntry[], live: readonly CommodoreLiveEvent[]): readonly CommodoreLogBlock[] {
  const chat = commodoreChatEntries(t, entries, live);
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
