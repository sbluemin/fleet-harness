/**
 * "이 Theater는 이번 세션에 이미 깨끗하게 열었다"는 사실만 담는다. 부팅 최소화는 Theater마다 세션 중
 * 한 번이어야 하는데, 그 "한 번"을 페이지 수명으로 세면 콘솔 전환이 새 부팅으로 잡힌다 — 로컬↔원격
 * 이동은 origin을 건너뛰는 전체 페이지 이동이라 모듈 메모리가 통째로 사라지기 때문이다. 표식을
 * sessionStorage에 적으면 같은 탭에 머무는 한 살아남아, 콘솔을 오가도 사용자가 펼쳐둔 패널이 다시
 * 접히지 않는다.
 *
 * localStorage가 아닌 이유: 탭을 새로 열거나 콘솔을 다시 시작하면 다시 깨끗한 Map으로 시작해야 한다.
 *
 * 알려진 경계: 브라우저는 탭 복제나 opener가 있는 새 창에 sessionStorage를 복사해 준다. 그렇게 갈라져
 * 나온 탭은 원본의 표식을 물려받아 부팅 최소화를 건너뛴다 — 복제한 탭이 원본과 같은 화면으로 열리는
 * 것은 복제의 뜻에 맞으므로 그대로 둔다. 주소창에서 새로 연 탭은 복사본을 받지 않아 깨끗하게 열린다.
 */

/** 테스트가 탭 세션의 생존을 직접 다룰 수 있도록 열어 둔다 — 키 문자열을 양쪽에 베끼지 않기 위해서다. */
export const BOOT_MINIMIZATION_STORAGE_KEY = "fleet.console.boot-minimized-theaters";

// sessionStorage를 쓸 수 없는 브라우저에서도 한 페이지 안에서는 종전처럼 한 번만 접도록 남기는 대비책.
const inMemory = new Set<string>();

/**
 * 이 Theater의 부팅 최소화 권리를 한 번만 내준다. 처음 여는 것이면 `true`를 돌려주며 표식을 남기고,
 * 이번 세션에 이미 열었던 Theater면 `false`를 돌려준다.
 */
export function claimTheaterBootMinimization(theaterId: string): boolean {
  const opened = readOpenedTheaters();
  if (opened.has(theaterId)) return false;
  opened.add(theaterId);
  writeOpenedTheaters(opened);
  return true;
}

/** 테스트가 세션을 다시 시작한 상태로 되돌린다. */
export function resetBootMinimizationSession(): void {
  inMemory.clear();
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(BOOT_MINIMIZATION_STORAGE_KEY);
  } catch {
    // 저장소 접근 실패는 메모리 집합만으로도 회복되므로 흐름을 막지 않는다.
  }
}

function readOpenedTheaters(): Set<string> {
  const opened = new Set(inMemory);
  if (typeof window === "undefined") return opened;
  try {
    const stored = window.sessionStorage.getItem(BOOT_MINIMIZATION_STORAGE_KEY);
    if (!stored) return opened;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return opened;
    for (const entry of parsed) {
      if (typeof entry === "string" && entry.length > 0) opened.add(entry);
    }
  } catch {
    // 읽기 실패는 "아직 열지 않았다"로 수렴한다 — 최악이라도 종전의 깨끗한 열기로 돌아갈 뿐이다.
  }
  return opened;
}

function writeOpenedTheaters(opened: ReadonlySet<string>): void {
  inMemory.clear();
  for (const theaterId of opened) inMemory.add(theaterId);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(BOOT_MINIMIZATION_STORAGE_KEY, JSON.stringify([...opened]));
  } catch {
    // 저장 실패는 콘솔 전환 시 패널이 다시 접히는 정도의 손실이라 런타임 흐름을 막지 않는다.
  }
}
