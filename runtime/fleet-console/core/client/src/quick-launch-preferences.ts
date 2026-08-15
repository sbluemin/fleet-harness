/**
 * Quick Launch 컴포저가 마지막으로 고른 조합(Theater · 모델 · 추론 강도)과 고정 여부를
 * 브라우저에 기억한다.
 *
 * 서버 durable state가 아니라 localStorage인 이유: 이 값은 "이 브라우저에서 방금 뭘 골랐나"라는
 * 화면 상태이지 Console이 소유한 작전 상태가 아니다. Codex cowork 인라인 컨트롤이 cli/model/effort
 * 3종 조합을 같은 방식으로 기억하고 있고(fleet.codex.cowork.settings), activeTheaterId도 같은 계층이다.
 * 고정(pinned)도 같은 이유로 여기 산다 — 컴포저가 이 화면에서 어디에 서 있느냐는 배치 상태다.
 */

const STORAGE_KEY = "fleet-console.quickLaunch.selection";

export interface QuickLaunchSelection {
  readonly theaterId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly pinned: boolean;
}

export const EMPTY_QUICK_LAUNCH_SELECTION: QuickLaunchSelection = {
  theaterId: null,
  model: null,
  effort: null,
  pinned: false,
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

/**
 * `ultracode` 고지 줄을 몇 번 보였는지. 문장으로 가르치는 표면은 배우고 나면 소음이 되므로
 * 세 번 뒤에는 물러나고 칩만 남는다 — 상태 자체는 칩이 계속 말한다.
 */
const ULTRACODE_NOTICE_KEY = "fleet-console.quickLaunch.ultracodeNoticeSeen";
export const QUICK_LAUNCH_ULTRACODE_NOTICE_LIMIT = 3;

export function readUltracodeNoticeSeen(): number {
  try {
    const raw = window.localStorage.getItem(ULTRACODE_NOTICE_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    // 스토리지가 막혀 있으면 "아직 못 봤다"로 읽는다 — 가르치는 쪽으로 기운다.
    return 0;
  }
}

export function writeUltracodeNoticeSeen(seen: number): void {
  try {
    window.localStorage.setItem(ULTRACODE_NOTICE_KEY, String(seen));
  } catch {
    // 기억에 실패해도 인식 자체는 막지 않는다.
  }
}
