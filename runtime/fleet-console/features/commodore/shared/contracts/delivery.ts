// 브라우저 번들도 읽는 모듈이다 — 타입 외의 의존성을 두지 않는다.
import type { CommodoreTranscriptEntry } from "./types.js";
import { commodoreCliCause } from "./cli-status.js";

/**
 * 아직 「전달되지 않음」인 사람의 메시지 seq — 기록 순서대로 그 seq 의 마지막 행방이 `undelivered` 인 것이다. 다시 실렸다가(requeued)
 * 전달 전에 또 끊기면 다시 「전달되지 않음」이다. 감독자의 재실음과 화면의 표시가 같은 판정을 쓴다.
 */
export function undeliveredMessageSeqs(entries: readonly CommodoreTranscriptEntry[]): ReadonlySet<number> {
  const waiting = new Map<number, boolean>();
  for (const entry of entries) {
    if (entry.kind === "undelivered") for (const seq of entry.seqs) waiting.set(seq, true);
    else if (entry.kind === "requeued" || entry.kind === "delivered") for (const seq of entry.seqs) waiting.set(seq, false);
  }
  return new Set([...waiting].flatMap(([seq, open]) => (open ? [seq] : [])));
}

/**
 * CLI가 없거나 로그인이 없어 처리되지 못한 사람의 메시지 — 감독자가 그 배치를 `undelivered`로 남기고 바로 뒤에
 * CLI 원인의 `error` 줄을 쓴다. 화면은 그 말풍선에 「보내지 못함」을 달고, 오류 줄 대신 원인 카드를 세운다.
 */
export function cliBlockedMessageSeqs(entries: readonly CommodoreTranscriptEntry[]): ReadonlySet<number> {
  const blocked = new Set<number>();
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at]!;
    if (entry.kind !== "undelivered" || !entry.seqs.length) continue;
    for (let next = at + 1; next < entries.length; next += 1) {
      const candidate = entries[next]!;
      if (candidate.kind === "error") {
        if (commodoreCliCause(candidate.code)) for (const seq of entry.seqs) blocked.add(seq);
        break;
      }
      // 다음 턴·배달·새 말은 이 실패와 다른 사건이다 — 그 뒤의 오류를 이 말에 붙이지 않는다.
      if (candidate.kind === "wake" || candidate.kind === "message" || candidate.kind === "delivered" || candidate.kind === "requeued"
        || candidate.kind === "session" || candidate.kind === "result" || candidate.kind === "tool" || candidate.kind === "text"
        || candidate.kind === "ask" || candidate.kind === "ask-answered" || candidate.kind === "skipped" || candidate.kind === "received") break;
    }
  }
  return blocked;
}

/**
 * 다시 보내지 못하고 건너뛴(격리된) 사람의 메시지 — seq → 사유. 그 메시지는 배달되지 않았으므로 화면은 말풍선에
 * 「전달되지 않음」과 사유를 함께 단다. 기록은 덧붙이기만 하므로 나중 줄이 앞의 판정을 덮는다.
 */
export function skippedMessageReasons(entries: readonly CommodoreTranscriptEntry[]): ReadonlyMap<number, { readonly code: string; readonly detail?: string }> {
  const skipped = new Map<number, { readonly code: string; readonly detail?: string }>();
  for (const entry of entries) {
    if (entry.kind !== "skipped") continue;
    for (const seq of entry.seqs) skipped.set(seq, { code: entry.code, ...(entry.detail ? { detail: entry.detail } : {}) });
  }
  return skipped;
}

/** 다음 기동이 다시 깨울 보드 깨움 — 지난 종료가 듣지 못했다고 남긴 것. */
export interface CommodoreUnheardWakes {
  /** 대기 중인 그룹을 가리지 않고 다시 본다 — 목표를 가리키지 않는 이유가 남았거나 지난 실행이 종료를 기록하지 못했다. */
  readonly all: boolean;
  readonly empty: boolean;
  readonly objectiveIds: readonly string[];
}

/**
 * 마지막 `session` 줄이 `stopped` 면 그 바로 앞의 `unheard` 줄들이 다음 기동의 몫이다(없으면 깨울 것이 없다). 마지막 `session` 줄이
 * 열린 세션이면 지난 실행은 종료를 남기지 못하고 끝났다 — 무엇을 듣지 못했는지 모르므로 모두 다시 본다. 기록에 세션이 없으면 null.
 */
export function unheardWakes(entries: readonly CommodoreTranscriptEntry[]): CommodoreUnheardWakes | null {
  const last = entries.findLastIndex((entry) => entry.kind === "session");
  if (last < 0) return null;
  if ((entries[last] as Extract<CommodoreTranscriptEntry, { kind: "session" }>).event !== "stopped") return { all: true, empty: true, objectiveIds: [] };
  let all = false; let empty = false;
  const ids = new Set<string>();
  for (let index = last - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "unheard") break;
    if (entry.all) all = true;
    if (entry.codes.includes("empty")) empty = true;
    for (const id of entry.objectiveIds ?? []) ids.add(id);
  }
  return all || empty || ids.size ? { all, empty, objectiveIds: [...ids] } : null;
}
