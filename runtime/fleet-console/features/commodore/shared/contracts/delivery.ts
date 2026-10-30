// 브라우저 번들도 읽는 모듈이다 — 타입 외의 의존성을 두지 않는다.
import type { CommodoreTranscriptEntry } from "./types.js";

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
