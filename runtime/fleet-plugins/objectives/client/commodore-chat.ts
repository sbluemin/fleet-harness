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
        if (entry.text.trim()) push({ kind: "text", text: entry.text }, entry.at);
        break;
      case "tool": {
        const id = `c${entry.seq}`;
        push({ kind: "tool", id, name: entry.name, detail: toolDetail(t, entry) }, entry.at);
        if (entry.ok !== undefined) push({ kind: "tool-result", id, ok: entry.ok, summary: entry.error ? errorWord(t, entry.error) : "" }, entry.at);
        break;
      }
      case "result":
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
