import type { ConsoleState } from "../../../core/client/src/integration/types.js";
const WHATS_NEW_SEEN_VERSION_STORAGE_KEY = "fleet-console.whatsNewSeenVersion";
let whatsNewSeenVersionMemo: string | null = null;

export function evaluateAutomaticWhatsNew(current: ConsoleState): Pick<ConsoleState, "whatsNewOpen" | "automaticWhatsNewVersion" | "selectedReleaseNoteKey"> {
  const firstRealIndex = current.releaseNotes.findIndex((note) => note.version !== "Unreleased");
  const firstReal = firstRealIndex >= 0 ? current.releaseNotes[firstRealIndex] : undefined;
  const unchanged = {
    whatsNewOpen: current.whatsNewOpen,
    automaticWhatsNewVersion: current.automaticWhatsNewVersion,
    selectedReleaseNoteKey: current.selectedReleaseNoteKey,
  };
  if (!firstReal || !current.version || firstReal.version !== current.version || readStoredWhatsNewSeenVersion() === firstReal.version) {
    return unchanged;
  }
  // 처음 설치한 사람에게는 "새 소식"이 성립하지 않는다 — 그들에게는 전부가 처음이라, 지난
  // 릴리스 묶음을 펼쳐 봤자 아직 본 적 없는 제품의 변경 이력일 뿐이다. 본 기록이 없고
  // Theater도 아직 없으면 첫 실행으로 보고, 현재 버전을 읽은 것으로 표시해 다음 릴리스부터
  // 알린다. Theater가 있으면 이 브라우저가 처음일 뿐인 기존 사용자이므로 평소대로 연다.
  if (readStoredWhatsNewSeenVersion() === null && current.bootstrapped && current.theaters.length === 0) {
    writeStoredWhatsNewSeenVersion(firstReal.version);
    return unchanged;
  }
  return {
    whatsNewOpen: true,
    automaticWhatsNewVersion: firstReal.version,
    selectedReleaseNoteKey: releaseNoteKey(firstReal.version, firstRealIndex),
  };
}

export function remapReleaseNoteKey(
  previousNotes: readonly { readonly version: string }[],
  previousKey: string | null,
  nextNotes: readonly { readonly version: string }[],
): string | null {
  if (previousKey === null) return firstReleaseNoteKey(nextNotes);
  const previousIndex = previousNotes.findIndex((note, index) => releaseNoteKey(note.version, index) === previousKey);
  const selected = previousNotes[previousIndex];
  if (!selected) return firstReleaseNoteKey(nextNotes);

  const occurrence = previousNotes.slice(0, previousIndex + 1).filter((note) => note.version === selected.version).length;
  let seen = 0;
  for (let index = 0; index < nextNotes.length; index += 1) {
    if (nextNotes[index]?.version !== selected.version) continue;
    seen += 1;
    if (seen === occurrence) return releaseNoteKey(selected.version, index);
  }
  return firstReleaseNoteKey(nextNotes);
}

export function firstReleaseNoteKey(notes: readonly { readonly version: string }[]): string | null {
  return notes[0] ? releaseNoteKey(notes[0].version, 0) : null;
}

export function releaseNoteKeyExists(notes: readonly { readonly version: string }[], key: string): boolean {
  return notes.some((note, index) => releaseNoteKey(note.version, index) === key);
}

export function releaseNoteKey(version: string, index: number): string {
  return `${version}:${index}`;
}

export function readStoredWhatsNewSeenVersion(): string | null {
  if (whatsNewSeenVersionMemo !== null) return whatsNewSeenVersionMemo;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_VERSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredWhatsNewSeenVersion(version: string): void {
  whatsNewSeenVersionMemo = version;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_VERSION_STORAGE_KEY, version);
  } catch {
    // 저장소가 막힌 환경에서는 in-memory watermark만 유지한다.
  }
}
