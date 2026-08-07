import type { DeveloperNote } from "./types.js";

/**
 * 읽음 표식은 `<id>:<content hash>` 쌍이다. id만 기록하면 개발자가 본문을 고쳐도 읽은
 * 상태로 남아 갱신이 전달되지 않고, 해시만 기록하면 "고쳐진 것"과 "처음 보는 것"을
 * 구분할 수 없다. 둘을 함께 들고 있어야 수정된 노트를 다시 올리면서 그 이유까지 말할 수 있다.
 *
 * GitHub의 `updated_at`을 쓰지 않는 이유도 같다 — 댓글 하나에도 올라가므로 본문이
 * 그대로인 노트가 전 사용자에게 다시 뜬다.
 */
export function developerNoteSeenKey(note: DeveloperNote): string {
  return `${note.id}:${note.hash}`;
}

export function isDeveloperNoteRead(seen: readonly string[], note: DeveloperNote): boolean {
  return seen.includes(developerNoteSeenKey(note));
}

/** 같은 노트의 다른 판본을 읽은 적이 있으면 "수정됨"이다. */
export function isDeveloperNoteEdited(seen: readonly string[], note: DeveloperNote): boolean {
  if (isDeveloperNoteRead(seen, note)) return false;
  const prefix = `${note.id}:`;
  return seen.some((entry) => entry.startsWith(prefix));
}

export function countUnreadDeveloperNotes(seen: readonly string[], notes: readonly DeveloperNote[]): number {
  return notes.reduce((total, note) => (isDeveloperNoteRead(seen, note) ? total : total + 1), 0);
}

/**
 * 철회(close)된 노트의 표식을 지운다. 지우지 않으면 durable state가 단조 증가하고,
 * 상한에 닿는 순간 오래된 표식이 밀려나 이미 읽은 노트가 다시 미읽음으로 돌아온다.
 * 배열이 그대로면 같은 참조를 돌려주어 불필요한 저장을 막는다.
 */
export function pruneDeveloperNoteSeen(seen: readonly string[], notes: readonly DeveloperNote[]): readonly string[] {
  const liveIds = new Set(notes.map((note) => note.id));
  const next = seen.filter((entry) => {
    const separator = entry.indexOf(":");
    return separator > 0 && liveIds.has(entry.slice(0, separator));
  });
  return next.length === seen.length ? seen : next;
}

export function withDeveloperNoteRead(seen: readonly string[], note: DeveloperNote): readonly string[] {
  const key = developerNoteSeenKey(note);
  if (seen.includes(key)) return seen;
  // 같은 노트의 옛 판본 표식은 대체한다 — 판본마다 쌓이면 상한을 빨리 소모한다.
  const prefix = `${note.id}:`;
  return [...seen.filter((entry) => !entry.startsWith(prefix)), key];
}
