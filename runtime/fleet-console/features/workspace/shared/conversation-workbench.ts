/**
 * 대화별 도구 작업대(도구 분할 영역)의 배치 — 서버 저장과 브라우저 상태가 함께 쓰는 순수 모델이다. DOM·Node 어느 쪽도 import 하지 않는다.
 *
 * 한 대화(사령관·지휘관·일반 Operation)마다 배치 하나다: 대화 오른쪽 분할 영역의 열(최대 3)과 열 안의 칸(최대 3), 대화 아래 한 줄
 * (최대 2칸), 대화와 분할 영역의 폭 비율, 아래 줄의 높이 비율, 펼친 칸. 오른쪽 사이드바(세부 정보)의 열림은 여기 없다 — 그것은
 * 지금처럼 Console 전체에 하나다.
 *
 * 칸이 담는 것은 세 가지다: 레일 엔트리가 세우는 페인 묶음(`entry`: 파일·Codex·스킬 등), 확대 표면 서술자 하나(`surface`: 저장소·Shell
 * 등 — params 를 함께 든다), 그 대화의 Session 브라우저(`browser`). 무엇을 어디서 여는지(작업 위치 컨텍스트)는 이 모델의 몫이 아니라
 * 그리는 쪽이 대화에서 파생한다 — 2단계에서 칸의 params 에 파생 값을 더 싣더라도 배치의 모양은 그대로다.
 *
 * 저장 경계: 서버는 이 모양을 검증해 그대로 둔다. 절대 경로처럼 보이는 params 값은 저장하지 않는다(브라우저 DTO 에 원시 경로를 싣지
 * 않는 Console 계약). Shell 인스턴스·브라우저 탭 같은 런타임 상태는 저장하지 않는다.
 */

export const CONVERSATION_WORKBENCH_API_PATH = "/api/v1/conversation-workbench";

export const WORKBENCH_MAX_COLUMNS = 3;
export const WORKBENCH_MAX_TILES_PER_COLUMN = 3;
export const WORKBENCH_MAX_BELOW = 2;
/** 저장하는 대화 배치의 상한 — 넘치면 오래 손대지 않은 대화부터 버린다. */
export const WORKBENCH_MAX_LAYOUTS = 240;

const MAX_KEY_LENGTH = 320;
const MAX_ID_LENGTH = 64;
const MAX_PARAMS = 16;
const MAX_PARAM_VALUE_LENGTH = 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:#@-]+$/;

export type WorkbenchTileSource =
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "surface"; readonly surfaceId: string; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: "browser" };

export type WorkbenchTile = WorkbenchTileSource & { readonly id: string };

/** 칸이 줄지어 선 묶음 — 분할 영역의 열(위아래) 또는 대화 아래 줄(좌우). weights 는 tiles 와 같은 길이의 양수 가중치다. */
export interface WorkbenchStack {
  readonly tiles: readonly WorkbenchTile[];
  readonly weights: readonly number[];
}

export interface WorkbenchLayout {
  readonly columns: readonly WorkbenchStack[];
  readonly columnWeights: readonly number[];
  readonly below: WorkbenchStack;
  /** 대화와 분할 영역이 나눈 폭에서 분할 영역의 몫(0~1). null 이면 기본 몫. */
  readonly splitRatio: number | null;
  /** 대화 칸 높이에서 아래 줄의 몫(0~1). null 이면 기본 몫. */
  readonly belowRatio: number | null;
  readonly expandedTileId: string | null;
}

export interface StoredWorkbenchLayout {
  readonly layout: WorkbenchLayout;
  readonly updatedAt: number;
}

export interface WorkbenchStoreData {
  readonly version: 1;
  readonly layouts: Readonly<Record<string, StoredWorkbenchLayout>>;
}

/** 한 대화의 배치를 쓰는 요청 — layout 이 null 이면 그 대화의 배치를 지운다. */
export interface WorkbenchWrite {
  readonly key: string;
  readonly layout: WorkbenchLayout | null;
}

export const EMPTY_WORKBENCH_STACK: WorkbenchStack = Object.freeze({ tiles: Object.freeze([]), weights: Object.freeze([]) }) as WorkbenchStack;

export const EMPTY_WORKBENCH_LAYOUT: WorkbenchLayout = Object.freeze({
  columns: Object.freeze([]) as readonly WorkbenchStack[],
  columnWeights: Object.freeze([]) as readonly number[],
  below: EMPTY_WORKBENCH_STACK,
  splitRatio: null,
  belowRatio: null,
  expandedTileId: null,
});

export function workbenchTiles(layout: WorkbenchLayout): readonly WorkbenchTile[] {
  return [...layout.columns.flatMap((column) => column.tiles), ...layout.below.tiles];
}

export function isWorkbenchEmpty(layout: WorkbenchLayout): boolean {
  return layout.columns.length === 0 && layout.below.tiles.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown, max = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && ID_PATTERN.test(value);
}

export function isWorkbenchKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_KEY_LENGTH && !/[\u0000-\u001f]/.test(value);
}

/** 절대 경로처럼 보이는 값 — 저장하지 않는다. 상대 경로·id·문서 주소는 그대로 둔다. */
function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("file:");
}

export function sanitizeWorkbenchParams(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {};
  const params: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_PARAMS) break;
    if (!validId(key) || typeof raw !== "string" || raw.length > MAX_PARAM_VALUE_LENGTH || looksLikeAbsolutePath(raw)) continue;
    params[key] = raw;
    count += 1;
  }
  return params;
}

function sanitizeTile(value: unknown, seen: Set<string>): WorkbenchTile | null {
  if (!isRecord(value) || !validId(value.id) || seen.has(value.id)) return null;
  const id = value.id;
  let tile: WorkbenchTile | null = null;
  if (value.kind === "entry" && validId(value.entryId)) tile = { id, kind: "entry", entryId: value.entryId };
  else if (value.kind === "surface" && validId(value.surfaceId)) tile = { id, kind: "surface", surfaceId: value.surfaceId, params: sanitizeWorkbenchParams(value.params) };
  else if (value.kind === "browser") tile = { id, kind: "browser" };
  if (tile !== null) seen.add(id);
  return tile;
}

function sanitizeWeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1e6 ? value : 1;
}

function sanitizeStack(value: unknown, limit: number, seen: Set<string>): WorkbenchStack {
  if (!isRecord(value) || !Array.isArray(value.tiles)) return EMPTY_WORKBENCH_STACK;
  const weights = Array.isArray(value.weights) ? value.weights : [];
  const tiles: WorkbenchTile[] = [];
  const kept: number[] = [];
  value.tiles.forEach((raw, index) => {
    if (tiles.length >= limit) return;
    const tile = sanitizeTile(raw, seen);
    if (tile === null) return;
    tiles.push(tile);
    kept.push(sanitizeWeight(weights[index]));
  });
  return tiles.length === 0 ? EMPTY_WORKBENCH_STACK : { tiles, weights: kept };
}

function sanitizeRatio(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : null;
}

export function sanitizeWorkbenchLayout(value: unknown): WorkbenchLayout | null {
  if (!isRecord(value)) return null;
  const seen = new Set<string>();
  const columns: WorkbenchStack[] = [];
  const columnWeights: number[] = [];
  const rawColumns = Array.isArray(value.columns) ? value.columns : [];
  const rawColumnWeights = Array.isArray(value.columnWeights) ? value.columnWeights : [];
  rawColumns.forEach((raw, index) => {
    if (columns.length >= WORKBENCH_MAX_COLUMNS) return;
    const column = sanitizeStack(raw, WORKBENCH_MAX_TILES_PER_COLUMN, seen);
    if (column.tiles.length === 0) return;
    columns.push(column);
    columnWeights.push(sanitizeWeight(rawColumnWeights[index]));
  });
  const below = sanitizeStack(value.below, WORKBENCH_MAX_BELOW, seen);
  const expanded = typeof value.expandedTileId === "string" && seen.has(value.expandedTileId) ? value.expandedTileId : null;
  return {
    columns,
    columnWeights,
    below,
    splitRatio: sanitizeRatio(value.splitRatio),
    belowRatio: sanitizeRatio(value.belowRatio),
    expandedTileId: expanded,
  };
}

export function sanitizeWorkbenchStoreData(value: unknown): WorkbenchStoreData {
  const record = isRecord(value) && value.version === 1 && isRecord(value.layouts) ? value.layouts : {};
  return { version: 1, layouts: sanitizeLayoutBook(record) };
}

/** 저장된 배치 묶음 — 응답(GET)과 파일이 같은 정제기를 지난다. 빈 배치와 상한을 넘는 오래된 배치는 버린다. */
export function sanitizeLayoutBook(value: unknown): Readonly<Record<string, StoredWorkbenchLayout>> {
  if (!isRecord(value)) return {};
  const entries: [string, StoredWorkbenchLayout][] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!isWorkbenchKey(key) || !isRecord(raw)) continue;
    const layout = sanitizeWorkbenchLayout(raw.layout);
    if (layout === null || isWorkbenchEmpty(layout)) continue;
    const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    entries.push([key, { layout, updatedAt }]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, WORKBENCH_MAX_LAYOUTS));
}

export function sanitizeWorkbenchWrite(value: unknown): WorkbenchWrite | null {
  if (!isRecord(value) || !isWorkbenchKey(value.key)) return null;
  if (value.layout === null) return { key: value.key, layout: null };
  const layout = sanitizeWorkbenchLayout(value.layout);
  return layout === null ? null : { key: value.key, layout };
}

/** 쓰기 하나를 묶음에 반영한다. 빈 배치는 지우기와 같다. */
export function applyWorkbenchWrite(book: Readonly<Record<string, StoredWorkbenchLayout>>, write: WorkbenchWrite, now: number): Readonly<Record<string, StoredWorkbenchLayout>> {
  const next: Record<string, StoredWorkbenchLayout> = { ...book };
  if (write.layout === null || isWorkbenchEmpty(write.layout)) delete next[write.key];
  else next[write.key] = { layout: write.layout, updatedAt: now };
  return sanitizeLayoutBook(next);
}
