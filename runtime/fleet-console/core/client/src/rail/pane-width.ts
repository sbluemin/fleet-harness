import type { PaneDescriptor, PaneWidthClass } from "@fleet-console/sdk/pane";

/**
 * 레일 카드 폭의 단일 출처 — 등급표, 기본값 해석, 그리고 도구별 기억.
 *
 * 폭을 한 모듈이 소유하는 이유는 두 번 데었기 때문이다.
 *
 * **하나.** 폭의 기억은 한때 패널별이었다(#373). 레일이 다중 Pin 스택이 되면서 두 패널이 한
 * 카드에 동시에 상주하게 되자 "패널마다 다른 폭"이 성립하지 않아 카드 단일 값으로 접혔다
 * (#963). 그 전제는 독점 슬롯 회귀(#968)로 사라졌지만 기제는 남아, 한 도구를 넓히면 나머지
 * 다섯이 함께 넓어지고 그 상태가 재부팅을 넘어 살아남았다. 폭의 소유자는 다시 도구다.
 *
 * **둘.** 페인이 자기 폭을 픽셀로 발명하면 그 픽셀이 자기 컨테이너 브레이크포인트와 어긋나도
 * 아무도 잡지 못한다 — 설정 페인은 `defaultWidth: 360`을 선언했는데 자기 테마 격자가 2열이
 * 되는 문턱은 420이어서, 기본 상태에서 그 격자가 한 번도 2열로 서지 못했다. 그래서 새 페인은
 * 픽셀이 아니라 **등급**을 말하고, 픽셀은 여기서만 해석한다. 등급표가 브레이크포인트를
 * 넘는지는 `tests/instrument-design-contract.test.ts`가 지킨다.
 */

/** 카드가 이보다 좁아지지 않는다. 아래 등급은 전부 이 바닥 위에 있어야 한다. */
export const MIN_PANEL_WIDTH = 240;

/** 폭에 대해 아무 말도 하지 않은 페인의 몫. */
export const DEFAULT_PANEL_WIDTH = 312;

/**
 * 등급 → px. 페인이 픽셀을 발명하는 대신 고르는 어휘다.
 *
 * - `narrow` — 폭이 판독을 거의 바꾸지 않는 목록(스킬 계열). 실측상 336px 위로는 내용이 더
 *   펴지지 않는다.
 * - `standard` — 계량기·행 카드가 한 줄에 서는 폭(사용 한도·원장 계열). 실측 무릎 368px 위.
 * - `wide` — 안에서 2열 격자가 서야 하는 본문(설정 계열). 코어 CSS의 설정 페인 컨테이너
 *   문턱(420px)을 반드시 넘는다.
 */
export const PANE_WIDTH_CLASS_PX: Readonly<Record<PaneWidthClass, number>> = {
  narrow: 328,
  standard: 392,
  wide: 440,
};

/**
 * 카드 폭과 페인 컨테이너 폭의 차(px).
 *
 * `@container` 질의는 카드가 아니라 페인 요소의 폭으로 판정한다. 등급표가 브레이크포인트를
 * "겨우" 넘으면 이 차이만큼 판정이 뒤집히므로, 계약 테스트는 이 여유를 얹고 비교한다.
 *
 * 값은 실측이다 — 카드 440px에서 `.settings-pane`의 폭은 428px이었다(테두리·패딩 몫).
 */
export const PANE_CONTAINER_INSET_ALLOWANCE = 12;

/** 페인이 선언한 폭 — 픽셀이 먼저고, 없으면 등급, 그것도 없으면 호스트 기본값. */
export function resolvePaneDefaultWidth(pane: Pick<PaneDescriptor, "defaultWidth" | "widthClass"> | null | undefined): number {
  if (pane === null || pane === undefined) return DEFAULT_PANEL_WIDTH;
  if (pane.defaultWidth !== undefined && Number.isFinite(pane.defaultWidth)) return Math.round(pane.defaultWidth);
  if (pane.widthClass !== undefined) return PANE_WIDTH_CLASS_PX[pane.widthClass];
  return DEFAULT_PANEL_WIDTH;
}

/* ── 도구별 기억 ───────────────────────────────────────────────────────────── */

/** 도구 id → 사용자가 조절한 폭(px). 조절하지 않은 도구는 여기 없다. */
export type StoredPanelWidths = Readonly<Record<string, number>>;

const PREFS_PANEL_WIDTHS = "fleet-console.rail.panelWidths";
/** #963~#968의 카드 단일 폭. 마지막 활성 도구에게 상속시키고 걷는다. */
const LEGACY_PREFS_CARD_WIDTH = "fleet-console.rail.cardWidth";
/** #373 이전의 단일 폭. 같은 방식으로 상속시킨다. */
const LEGACY_PREFS_PANEL_WIDTH = "fleet-console.rail.panelWidth";

function sanitize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_PANEL_WIDTH) return null;
  return Math.round(value);
}

function write(widths: StoredPanelWidths): void {
  try {
    if (Object.keys(widths).length === 0) localStorage.removeItem(PREFS_PANEL_WIDTHS);
    else localStorage.setItem(PREFS_PANEL_WIDTHS, JSON.stringify(widths));
  } catch { /* ignore */ }
}

function drop(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/** 저장된 지도. 키가 없거나 읽을 수 없으면 `null` — 부르는 쪽은 둘을 똑같이 "없음"으로 다룬다. */
function readWidthMap(): Record<string, number> | null {
  const raw = localStorage.getItem(PREFS_PANEL_WIDTHS);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const widths: Record<string, number> = {};
  for (const [id, value] of Object.entries(parsed)) {
    const px = sanitize(value);
    if (id !== "" && px !== null) widths[id] = px;
  }
  return widths;
}

/**
 * 저장된 도구별 폭을 읽는다. 단일 폭 시절의 값은 여기서 **1회** 승계된다.
 *
 * 승계는 마지막으로 열려 있던 도구에게만 간다. 그 값은 사용자가 그 도구를 보면서 정한
 * 폭이었고, 화면에 없던 다섯 도구가 그 폭을 물려받을 근거는 처음부터 없었다 — 그 근거 없는
 * 상속이 바로 이번에 걷어내는 결함이다. 열려 있던 도구가 없으면 그 값은 주인이 없으므로 버린다.
 *
 * 승계한 뒤에는 옛 키를 지운다. 남겨 두면 다음 로드가 같은 상속을 다시 심는다.
 */
export function readStoredPanelWidths(activePanelId: string | null): StoredPanelWidths {
  try {
    // 읽을 수 없는 지도는 **없는 것으로 친다.** 여기서 통째로 포기하면 함께 남아 있던 멀쩡한
    // 단일 폭이 영원히 가려지고, 깨진 지도 자체도 걷히지 않는다(v1.79.0의 마이그레이션이
    // 깨진 지도를 만나면 그대로 두었으므로 둘이 공존하는 상태가 실제로 존재한다).
    const widths = readWidthMap();
    if (widths !== null) {
      // 옛 단일 키가 함께 남아 있으면 걷는다 — 도구별 지도가 있는 한 그 값은 주인이 없다.
      drop(LEGACY_PREFS_CARD_WIDTH);
      drop(LEGACY_PREFS_PANEL_WIDTH);
      return widths;
    }

    const legacy = sanitize(Number(localStorage.getItem(LEGACY_PREFS_CARD_WIDTH)))
      ?? sanitize(Number(localStorage.getItem(LEGACY_PREFS_PANEL_WIDTH)));
    drop(LEGACY_PREFS_CARD_WIDTH);
    drop(LEGACY_PREFS_PANEL_WIDTH);
    if (legacy === null || activePanelId === null) {
      // 승계할 값이 없어도 읽을 수 없던 지도는 걷는다 — 남겨 두면 다음 로드도 같은 자리에서 막힌다.
      drop(PREFS_PANEL_WIDTHS);
      return {};
    }
    const migrated = { [activePanelId]: legacy };
    write(migrated);
    return migrated;
  } catch { return {}; }
}

/** 한 도구의 폭을 기록한다. 다른 도구의 기억은 건드리지 않는다. */
export function saveStoredPanelWidth(current: StoredPanelWidths, panelId: string, width: number): StoredPanelWidths {
  const px = sanitize(Math.round(width));
  if (px === null) return current;
  if (current[panelId] === px) return current;
  const next = { ...current, [panelId]: px };
  write(next);
  return next;
}

/** 한 도구의 기억만 지운다 — 그 도구는 다음부터 자기 선언 기본값으로 열린다. */
export function clearStoredPanelWidth(current: StoredPanelWidths, panelId: string): StoredPanelWidths {
  if (!(panelId in current)) return current;
  const next = { ...current };
  delete next[panelId];
  write(next);
  return next;
}
