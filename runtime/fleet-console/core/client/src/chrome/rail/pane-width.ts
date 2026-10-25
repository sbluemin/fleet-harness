import type { PaneDescriptor, PaneWidthClass } from "../../../../../features/workspace/shared/pane.js";

/**
 * 레일 카드 폭의 단일 출처 — 등급표, 기본값 해석, 그리고 도구별 기억.
 *
 * 폭을 한 모듈이 소유하는 이유는 두 번 데었기 때문이다.
 *
 * **하나.** 폭의 기억은 패널별(#373)에서 카드 단일(#963)을 거쳐 도구별이 되었다(#968). 대화
 * 중심 화면의 사령관·지휘관 탭은 그 뒤로 각자 레일 패널이 되어, 도구별 기억이 탭마다 다른
 * 외곽 폭으로 되살아났다. 오른쪽 사이드바의 외곽 폭은 다시 하나다. 표면 안 primary/detail
 * 분할과 solo 폭은 이 선호가 아니다 — 그 기억은 pane 폭 저장이 그대로 가진다.
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
 * - `standard` — 계량기·행 카드가 한 줄에 서는 폭(사용 한도 계열). 실측 무릎 368px 위.
 * - `wide` — 안에서 2열 격자가 서야 하는 본문. 코어 CSS의 설정 테마 격자 문턱(420px)을
 *   반드시 넘는다.
 * - `broad` — 제목·컨트롤 행이 한 줄에 서는 본문(설정). 설정 행이 세로로 접히는 문턱(640px)과
 *   고급 섹션의 Backend API 행 문턱(720px)을 넘고, AI Gateway 모델 로스터의 한 줄 레코드
 *   (공급자·모델·강도 사다리·호스트 전용)가 실측상 페인 958px부터 한 줄에 서므로 그 위에 둔다.
 *   설정을 열면 모든 행이 처음부터 접히지 않은 꼴로 선다. 화면이 좁으면 레일이 예산으로 클램프한다.
 */
export const PANE_WIDTH_CLASS_PX: Readonly<Record<PaneWidthClass, number>> = {
  narrow: 328,
  standard: 392,
  wide: 440,
  broad: 1000,
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

/* ── 외곽 폭 하나 ──────────────────────────────────────────────────────────── */

const PREFS_OUTER_WIDTH = "fleet-console.rail.outerWidth";
/** #968의 도구별 지도. 단일 외곽 폭으로 한 번 승계하고 걷는다. */
const LEGACY_PREFS_PANEL_WIDTHS = "fleet-console.rail.panelWidths";
/** #963~#968의 카드 단일 폭. */
const LEGACY_PREFS_CARD_WIDTH = "fleet-console.rail.cardWidth";
/** #373 이전의 단일 폭. */
const LEGACY_PREFS_PANEL_WIDTH = "fleet-console.rail.panelWidth";

function sanitize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_PANEL_WIDTH) return null;
  return Math.round(value);
}

function writeOuter(width: number): void {
  try { localStorage.setItem(PREFS_OUTER_WIDTH, JSON.stringify(width)); } catch { /* ignore */ }
}

function drop(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function readOuterNumber(): number | null {
  const raw = localStorage.getItem(PREFS_OUTER_WIDTH);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = Number(raw); }
  return sanitize(typeof parsed === "number" ? parsed : Number.NaN);
}

/**
 * 도구별 지도. 유효 항목이 하나도 없으면 `null` — 깨진 지도는 권위가 아니다.
 * 항목이 없으면 함께 남아 있던 옛 단일 폭을 버릴 근거도 없다.
 */
function readWidthMap(): Record<string, number> | null {
  const raw = localStorage.getItem(LEGACY_PREFS_PANEL_WIDTHS);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const widths: Record<string, number> = {};
  for (const [id, value] of Object.entries(parsed)) {
    const px = sanitize(value);
    if (id !== "" && px !== null) widths[id] = px;
  }
  return Object.keys(widths).length === 0 ? null : widths;
}

/**
 * 레거시에서 단일 외곽 폭으로 올릴 값. 순서는 고정이다.
 *
 * 1. 지금 활성 패널 id의 유효 지도값 — 화면에 있는 폭이 사용자가 마지막으로 본 폭이다.
 * 2. 옛 카드 단일 폭, 그다음 옛 패널 단일 폭.
 * 3. 지도에 남은 유효 값 중 id 오름차순 첫 값 — 활성이 비어 있어도 조절 기록이 사라지지 않는다.
 */
function chooseLegacyOuterWidth(activePanelId: string | null): number | null {
  const map = readWidthMap();
  if (map !== null && activePanelId !== null && activePanelId !== "" && map[activePanelId] !== undefined) {
    return map[activePanelId];
  }
  const card = sanitize(Number(localStorage.getItem(LEGACY_PREFS_CARD_WIDTH)));
  if (card !== null) return card;
  const panel = sanitize(Number(localStorage.getItem(LEGACY_PREFS_PANEL_WIDTH)));
  if (panel !== null) return panel;
  if (map === null) return null;
  const first = Object.keys(map).sort()[0];
  return first === undefined ? null : map[first] ?? null;
}

function dropLegacyWidthKeys(): void {
  drop(LEGACY_PREFS_PANEL_WIDTHS);
  drop(LEGACY_PREFS_CARD_WIDTH);
  drop(LEGACY_PREFS_PANEL_WIDTH);
}

/**
 * 저장된 외곽 폭 하나. 없으면 `null` — 부르는 쪽은 선언 기본값을 세션에서 한 번만 붙잡고,
 * 탭이 바뀔 때마다 그 선언값으로 다시 덮지 않는다.
 *
 * 단일 키가 이미 유효하면 그것이 권위다. 없거나 깨졌으면 레거시를 위 순서로 한 번 승계하고
 * 옛 키를 지운다. 남겨 두면 다음 로드가 같은 승계를 다시 심는다. 읽을 수 없는 단일 키도 걷는다.
 */
export function readStoredOuterWidth(activePanelId: string | null): number | null {
  try {
    const current = readOuterNumber();
    if (current !== null) {
      dropLegacyWidthKeys();
      return current;
    }
    const chosen = chooseLegacyOuterWidth(activePanelId);
    dropLegacyWidthKeys();
    drop(PREFS_OUTER_WIDTH);
    if (chosen === null) return null;
    writeOuter(chosen);
    return chosen;
  } catch { return null; }
}

/** 외곽 폭 하나를 기록한다. 클램프된 표시 폭을 뷰포트 변화만으로 덮어쓰지 않는 것은 부르는 쪽의 몫이다. */
export function saveStoredOuterWidth(width: number): number | null {
  const px = sanitize(Math.round(width));
  if (px === null) return null;
  writeOuter(px);
  return px;
}

/** 외곽 폭 기억을 지운다. 다음 표시 폭은 부르는 쪽이 지금 패널의 선언값으로 다시 붙잡는다. */
export function clearStoredOuterWidth(): void {
  drop(PREFS_OUTER_WIDTH);
}
