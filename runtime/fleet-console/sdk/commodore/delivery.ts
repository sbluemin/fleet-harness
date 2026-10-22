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
