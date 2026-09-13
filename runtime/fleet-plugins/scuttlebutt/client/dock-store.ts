import type { AdmiralId } from "./chat-session.js";

/**
 * 상단 바에 둔 부관의 글리프와 무리를 잇는 다리.
 *
 * 글리프는 호스트의 커맨드 밴드 안에 마운트되고 무리는 부유 레이어에 마운트된다 — 둘은 리액트
 * 트리가 다르다. 그래서 글리프가 자기 요소와 클릭을 여기에 싣고, 무리는 그 요소를 시트의 닻으로
 * 읽으며 열림·읽지 않음·답하는 중을 여기에 써서 글리프가 그리게 한다.
 *
 * 멘션 다리와 같은 이유로 이 싱글턴은 **플러그인 번들 안에서만** 산다(호스트와 플러그인은 모듈
 * 사본을 따로 실을 수 있다).
 */
export interface DockSnapshot {
  /** 시트가 열려 있는 부관. 글리프는 aria-expanded로 말한다. */
  readonly open: AdmiralId | null;
  /** 시트가 닫힌 채 답이 도착한 부관. 글리프에 점이 선다. */
  readonly unread: readonly AdmiralId[];
  /** 답하는 중인 부관. 글리프가 숨을 쉰다. */
  readonly busy: readonly AdmiralId[];
  /** 새를 밴드로 끌고 오는 중 — 글리프 옆에 내려놓을 자리를 보인다. */
  readonly dropArmed: boolean;
  /**
   * 글리프가 설 커맨드 밴드 슬롯이 마운트돼 있는가. 모바일 배치는 밴드를 그리지 않으므로 거기서는
   * 저장된 「상단 바에 두기」가 있어도 새를 캔버스에 둔다 — 글리프도 떼어내기도 없는 곳에 부관을
   * 숨기면 되찾을 길이 없다.
   */
  readonly host: boolean;
}

const EMPTY: DockSnapshot = { open: null, unread: [], busy: [], dropArmed: false, host: false };
let snapshot: DockSnapshot = EMPTY;
const listeners = new Set<() => void>();
const glyphs = new Map<AdmiralId, HTMLButtonElement>();
let activate: ((admiral: AdmiralId) => void) | null = null;

export function readDockSnapshot(): DockSnapshot {
  return snapshot;
}

export function subscribeDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function writeDock(patch: Partial<DockSnapshot>): void {
  const next = { ...snapshot, ...patch };
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** 글리프가 마운트될 때 자기 요소를 싣는다. 시트는 이 요소의 사각형 아래로 내려온다. */
export function registerDockGlyph(admiral: AdmiralId, element: HTMLButtonElement | null): void {
  if (element) glyphs.set(admiral, element);
  else glyphs.delete(admiral);
  // 닻이 생기고 사라지는 것도 배치 사건이다 — 시트가 다시 재게 알린다.
  for (const listener of listeners) listener();
}

export function readDockGlyph(admiral: AdmiralId): HTMLButtonElement | null {
  return glyphs.get(admiral) ?? null;
}

/** 근무 중이며 상단 바에 선 첫 글리프 — 캔버스에 새가 하나도 없을 때 소식 말풍선의 닻이다. */
export function firstDockGlyph(): HTMLButtonElement | null {
  for (const element of glyphs.values()) return element;
  return null;
}

export function connectDockActivate(next: (admiral: AdmiralId) => void): () => void {
  activate = next;
  return () => {
    if (activate === next) activate = null;
  };
}

export function activateDock(admiral: AdmiralId): void {
  activate?.(admiral);
}

function sameSnapshot(left: DockSnapshot, right: DockSnapshot): boolean {
  return left.open === right.open
    && left.dropArmed === right.dropArmed
    && left.host === right.host
    && sameList(left.unread, right.unread)
    && sameList(left.busy, right.busy);
}

function sameList(left: readonly AdmiralId[], right: readonly AdmiralId[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
