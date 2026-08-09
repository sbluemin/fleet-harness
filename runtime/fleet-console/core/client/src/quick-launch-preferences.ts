/**
 * Quick Launch 컴포저가 마지막으로 고른 조합(Theater · 모델 · 추론 강도)을 브라우저에 기억한다.
 *
 * 서버 durable state가 아니라 localStorage인 이유: 이 값은 "이 브라우저에서 방금 뭘 골랐나"라는
 * 화면 상태이지 Console이 소유한 작전 상태가 아니다. Codex cowork 인라인 컨트롤이 cli/model/effort
 * 3종 조합을 같은 방식으로 기억하고 있고(fleet.codex.cowork.settings), activeTheaterId도 같은 계층이다.
 */

const STORAGE_KEY = "fleet-console.quickLaunch.selection";

export interface QuickLaunchSelection {
  readonly theaterId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}

export const EMPTY_QUICK_LAUNCH_SELECTION: QuickLaunchSelection = {
  theaterId: null,
  model: null,
  effort: null,
};

export function readQuickLaunchSelection(): QuickLaunchSelection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_QUICK_LAUNCH_SELECTION;
    const parsed = JSON.parse(raw) as Partial<Record<keyof QuickLaunchSelection, unknown>>;
    const selection = {
      theaterId: readNonEmptyString(parsed.theaterId),
      model: migrateRememberedModel(readNonEmptyString(parsed.model)),
      effort: readNonEmptyString(parsed.effort),
    };
    // Canvas/Quick Launch Opus now launches as `opus[1m]`. Rewrite a leftover bare
    // `opus` once so a reopen does not restore a retired catalog id into React state.
    if (selection.model !== readNonEmptyString(parsed.model)) {
      writeQuickLaunchSelection(selection);
    }
    return selection;
  } catch {
    // 파싱 불가·스토리지 차단(사생활 보호 모드)은 "기억 없음"과 같은 상태다.
    return EMPTY_QUICK_LAUNCH_SELECTION;
  }
}

/** Bare `opus` was the pre-1M menu id; keep the same Opus row under `opus[1m]`. */
function migrateRememberedModel(model: string | null): string | null {
  return model === "opus" ? "opus[1m]" : model;
}

export function writeQuickLaunchSelection(selection: QuickLaunchSelection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 기억에 실패해도 실행 자체는 막지 않는다.
  }
}

export function writeQuickLaunchModelEffort(model: string | null, effort: string | null): void {
  const remembered = readQuickLaunchSelection();
  writeQuickLaunchSelection({ ...remembered, model, effort });
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
