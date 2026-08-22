/**
 * Quick Launch 컴포저가 마지막으로 고른 조합(Theater · 모델 · 추론 강도)과 고정 여부를
 * 브라우저에 기억한다.
 *
 * 서버 durable state가 아니라 localStorage인 이유: 이 값은 "이 브라우저에서 방금 뭘 골랐나"라는
 * 화면 상태이지 Console이 소유한 작전 상태가 아니다. Codex cowork 인라인 컨트롤이 cli/model/effort
 * 3종 조합을 같은 방식으로 기억하고 있고(fleet.codex.cowork.settings), activeTheaterId도 같은 계층이다.
 * 고정(pinned)과 포커스 멘션(mentionFocused)도 같은 이유로 여기 산다 — 컴포저가 이 화면에서
 * 어디에 서 있느냐, 열릴 때 보고 있는 패널을 행선지로 삼느냐는 배치·습관 상태다.
 */

const STORAGE_KEY = "fleet-console.quickLaunch.selection";

export interface QuickLaunchSelection {
  readonly theaterId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly pinned: boolean;
  readonly mentionFocused: boolean;
  /**
   * 다음 Operation이 태어날 표면. 모델·강도와 같은 "고르면 기억" 계층에 산다 — 대화로 하는 작업은
   * 한 번으로 끝나지 않기 때문이다. 기억해도 숨은 모드가 되지 않는 근거는 무장이 문면 위 안내줄과
   * 카드 외곽선으로 **상시** 보인다는 것이다. 덱을 열어야만 보이는 값이었다면 기억해선 안 된다.
   */
  readonly view: QuickLaunchStartView;
}

export type QuickLaunchStartView = "terminal" | "chat";

const EMPTY_QUICK_LAUNCH_SELECTION: QuickLaunchSelection = {
  theaterId: null,
  model: null,
  effort: null,
  pinned: false,
  mentionFocused: false,
  view: "terminal",
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
      pinned: parsed.pinned === true,
      mentionFocused: parsed.mentionFocused === true,
      // 모르는 값·없는 값은 모두 터미널이다 — 시작 표면의 기본은 기억이 아니라 계약이 정한다.
      view: parsed.view === "chat" ? "chat" as const : "terminal" as const,
    };
    // Canvas/Quick Launch native models now launch on their 1M coordinates. Rewrite a leftover bare
    // selection once so a reopen does not restore a retired catalog id into React state.
    if (selection.model !== readNonEmptyString(parsed.model)) {
      writeQuickLaunchSelection(selection);
    }
    return selection;
  } catch {
    // 파싱 불가·스토리지 차단(사생활 보호 모드)은 "기억 없음"과 같은 상태다.
    return EMPTY_QUICK_LAUNCH_SELECTION;
  }
}

/** Bare native model ids were the pre-1M menu ids; keep their rows under the 1M coordinates. */
function migrateRememberedModel(model: string | null): string | null {
  if (model === "opus") return "opus[1m]";
  if (model === "fable") return "fable[1m]";
  return model;
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

export function writeQuickLaunchPinned(pinned: boolean): void {
  const remembered = readQuickLaunchSelection();
  writeQuickLaunchSelection({ ...remembered, pinned });
}

/** 시작 표면도 모델·강도와 같은 "고르면 기억" 계층이다. */
export function writeQuickLaunchStartView(view: QuickLaunchStartView): void {
  const remembered = readQuickLaunchSelection();
  writeQuickLaunchSelection({ ...remembered, view });
}

export function writeQuickLaunchMentionFocused(mentionFocused: boolean): void {
  const remembered = readQuickLaunchSelection();
  writeQuickLaunchSelection({ ...remembered, mentionFocused });
}

/**
 * Theater도 모델·강도(writeQuickLaunchModelEffort)와 같은 "고르면 기억" 계층이다. 실행까지만
 * 기억을 미루면, 보존된 초안이 재오픈에서 옛 Theater로 되돌아간 채 발사 좌표만 어긋난다.
 */
export function writeQuickLaunchTheater(theaterId: string | null): void {
  const remembered = readQuickLaunchSelection();
  writeQuickLaunchSelection({ ...remembered, theaterId });
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
