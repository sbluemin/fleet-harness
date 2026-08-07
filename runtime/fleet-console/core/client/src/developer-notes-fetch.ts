import { fetchDeveloperNotes } from "./api.js";
import { applyDeveloperNotes } from "./store.js";

// 서버 캐시가 GitHub 호출을 1시간에 한 번으로 묶으므로, 탭이 몇 개든 실제 외부 요청은
// 인스턴스당 시간 1회다. 브라우저가 닫혀 있으면 폴링도 멈춘다 — 알릴 사람이 없을 때
// 나가는 요청은 예산 낭비다.
const POLL_INTERVAL_MS = 30 * 60 * 1000;

let activeAbortController: AbortController | null = null;
let requestGeneration = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function requestDeveloperNotes(options: { readonly force?: boolean } = {}): Promise<void> {
  activeAbortController?.abort();
  const controller = new AbortController();
  const generation = ++requestGeneration;
  activeAbortController = controller;
  return fetchDeveloperNotes({ force: options.force, signal: controller.signal })
    .then((response) => {
      if (generation === requestGeneration) applyDeveloperNotes(response);
    })
    // 노트 조회 실패는 사용자에게 알리지 않는다. 개발자가 할 말이 없는 상태와
    // 구분되지 않아야 하고, 오프라인이 오류 표면을 만들 이유도 없다.
    .catch(() => undefined)
    .finally(() => {
      if (generation === requestGeneration) activeAbortController = null;
    });
}

export function startDeveloperNotesPolling(): () => void {
  void requestDeveloperNotes();
  pollTimer ??= setInterval(() => void requestDeveloperNotes(), POLL_INTERVAL_MS);
  return stopDeveloperNotesPolling;
}

export function stopDeveloperNotesPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  activeAbortController?.abort();
  activeAbortController = null;
  requestGeneration += 1;
}
