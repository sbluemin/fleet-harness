/**
 * 새 세션이 마지막으로 고른 조합(Theater · 모델 · 추론 강도)을 브라우저에 기억한다 — 데스크톱 화면과 모바일 시트가 같은 기억을 쓴다.
 *
 * 서버 durable state가 아니라 localStorage인 이유: 이 값은 "이 브라우저에서 방금 뭘 골랐나"라는
 * 화면 상태이지 Console이 소유한 작전 상태가 아니다. Codex cowork 인라인 컨트롤이 cli/model/effort
 * 3종 조합을 같은 방식으로 기억하고 있고(fleet.codex.cowork.settings)와 같은 계층이다.
 * 시작 표면(터미널·채팅)은 따로 기억한다(launch-start-surface).
 */

import { canonicalLaunchModel } from "../../../execution/client/launch-selection.js";

const STORAGE_KEY = "fleet-console.newSession.selection";

export interface NewSessionSelection {
  readonly theaterId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}

const EMPTY_SELECTION: NewSessionSelection = { theaterId: null, model: null, effort: null };

export function readNewSessionSelection(): NewSessionSelection {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_SELECTION;
    const parsed = JSON.parse(raw) as Partial<Record<keyof NewSessionSelection, unknown>>;
    const selection = {
      theaterId: readNonEmptyString(parsed.theaterId),
      model: canonicalLaunchModel(readNonEmptyString(parsed.model)),
      effort: readNonEmptyString(parsed.effort),
    };
    // 네이티브 모델은 1M 좌표로 실행한다. 남아 있던 bare 기억은 한 번 다시 써서, 재오픈이 은퇴한 카탈로그 id를 되살리지 않게 한다.
    if (selection.model !== readNonEmptyString(parsed.model)) writeNewSessionSelection(selection);
    return selection;
  } catch {
    // 파싱 불가·스토리지 차단(사생활 보호 모드)은 "기억 없음"과 같은 상태다.
    return EMPTY_SELECTION;
  }
}

function writeNewSessionSelection(selection: NewSessionSelection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 기억에 실패해도 실행 자체는 막지 않는다.
  }
}

export function writeNewSessionModelEffort(model: string | null, effort: string | null): void {
  writeNewSessionSelection({ ...readNewSessionSelection(), model, effort });
}

/**
 * Theater도 모델·강도와 같은 "고르면 기억" 계층이다. 실행까지만 기억을 미루면, 쓰던 초안이 재오픈에서 옛 Theater로
 * 되돌아간 채 발사 좌표만 어긋난다.
 */
export function writeNewSessionTheater(theaterId: string | null): void {
  writeNewSessionSelection({ ...readNewSessionSelection(), theaterId });
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
