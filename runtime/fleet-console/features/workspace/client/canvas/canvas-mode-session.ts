/**
 * 캔버스 모드(War Room)를 탭 세션에 적어 둔다. 모드는 여태 모듈 메모리에만 있어서
 * 페이지가 새로 뜨면 언제나 Cruise로 떨어졌다 — 로컬↔원격 콘솔 이동은 origin을 건너뛰는 전체 페이지
 * 이동이라 모듈 메모리가 통째로 사라지기 때문이다. 표식을 sessionStorage에 적으면 같은 탭에 머무는 한
 * 살아남아, 콘솔을 오가도 보고 있던 모드가 그대로 선다.
 *
 * 수명과 경계는 부팅 최소화 표식(boot-minimization-session)과 같다: 같은 탭이면 콘솔 전환·새로고침을
 * 건너 살아남고, 새 탭은 Cruise로 깨끗하게 시작하며, sessionStorage는 origin별이라 콘솔마다 자기 몫을
 * 따로 기억한다. 저장소를 못 쓰는 브라우저에서는 읽기·쓰기가 조용히 실패해 종전처럼 Cruise로 뜬다.
 *
 * 모두 정렬은 Theater별 CanvasState(스냅 유지)에 살아 세션 표식이 필요 없다. 옛 formationTheaters
 * 필드가 저장값에 남아 있어도 읽을 때 무시한다.
 */

/** 테스트가 탭 세션의 생존을 직접 다룰 수 있도록 열어 둔다 — 키 문자열을 양쪽에 베끼지 않기 위해서다. */
export const CANVAS_MODE_STORAGE_KEY = "fleet.console.canvas-mode";

export interface CanvasModeSession {
  /** War Room(선별 처리) 활성 여부 — Theater와 무관한 전역 모드다. */
  readonly warRoom: boolean;
}

const EMPTY_SESSION: CanvasModeSession = { warRoom: false };

export function readCanvasModeSession(): CanvasModeSession {
  const storage = sessionStorage();
  if (!storage) return EMPTY_SESSION;
  try {
    const stored = storage.getItem(CANVAS_MODE_STORAGE_KEY);
    if (!stored) return EMPTY_SESSION;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_SESSION;
    const record = parsed as Record<string, unknown>;
    return { warRoom: record.warRoom === true };
  } catch {
    // 읽기 실패는 "기억이 없다"로 수렴한다 — 최악이라도 종전처럼 Cruise로 뜰 뿐이다.
    return EMPTY_SESSION;
  }
}

export function rememberWarRoomActive(warRoom: boolean): void {
  writeCanvasModeSession({ warRoom });
}

/** 테스트가 세션을 다시 시작한 상태로 되돌린다. */
export function resetCanvasModeSession(): void {
  const storage = sessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(CANVAS_MODE_STORAGE_KEY);
  } catch {
    // 지우기 실패는 다음 쓰기가 덮어쓰므로 흐름을 막지 않는다.
  }
}

// 한 키에 옛 formationTheaters가 남아 있어도 덮어쓸 때 떨어진다 — 읽기는 warRoom만 본다.
function writeCanvasModeSession(patch: Partial<CanvasModeSession>): void {
  const storage = sessionStorage();
  if (!storage) return;
  const next: CanvasModeSession = { ...readCanvasModeSession(), ...patch };
  try {
    storage.setItem(CANVAS_MODE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장 실패는 콘솔 전환 시 Cruise로 돌아가는 정도의 손실이라 런타임 흐름을 막지 않는다.
  }
}

function sessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    // 저장소 접근 자체를 막는 브라우저 설정에서도 캔버스는 그대로 떠야 한다.
    return null;
  }
}
