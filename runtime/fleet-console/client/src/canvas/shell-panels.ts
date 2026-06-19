import { useSyncExternalStore } from "react";

import { liftTopZIndex, type PanelGeometry } from "./canvas-store.js";

export interface ShellPanelEntry {
  // 이 셸이 띄워진 Theater id. 백엔드 ticket이 이 id로 cwd(Theater 디렉터리)를 해석한다(raw 경로는 클라이언트에 없음).
  readonly theaterId: string;
  readonly geometry: PanelGeometry;
}

type Listener = () => void;

const STORAGE_KEY_PREFIX = "fleet-console.canvas.shell.";
const SAVE_DELAY_MS = 400;
const DEFAULT_SHELL_WIDTH = 560;
const DEFAULT_SHELL_HEIGHT = 360;

const listeners = new Set<Listener>();
// Theater별 sessionStorage에 영속한다(키: fleet-console.canvas.shell.<theaterId>). sessionStorage는 탭
// 단위라 같은 탭의 새로고침에는 복원되지만 다른 탭과는 격리된다 — localStorage로 두면 두 번째 탭이 같은
// shell:* PTY에 attach해 첫 탭의 세션을 가로채므로(terminal session manager가 sessionId 중복 attach 시
// 이전 소켓을 replacement code로 닫는다) 의도적으로 탭별로 제한한다. Operations 패널(canvas-store)은 서버
// durable 세션을 공유하므로 localStorage지만, 셸은 탭별 PTY라 영속 범위가 다르다.
// 새로고침하면 모듈은 비워지지만 loadShellPanelsForTheater가 복원하며, 같은 패널 id로 백엔드 PTY에 재부착한다.
let panels: Record<string, ShellPanelEntry> = {};
// 활성(포커스) 셸 패널 id. Operations의 activeTerminalSessionId와 별개의 단일 활성 상태다.
// 두 종류가 동시에 활성으로 보이지 않도록 하는 상호배타는 상위(canvas) 레이어에서 조정한다.
// 영속하지 않는다 — 새로고침 직후 어떤 셸도 활성 외형이 아니게 해 Operations 활성과 충돌하지 않게 한다.
let activeShellId: string | null = null;
// 현재 로드된 Theater id. 영속 저장 키를 해석하며, null이면 저장을 건너뛴다(canvas-store와 동일 규약).
let activeTheaterId: string | null = null;
let saveTimer: number | null = null;

export function useShellPanels(): Record<string, ShellPanelEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useActiveShellId(): string | null {
  return useSyncExternalStore(subscribe, getActiveShellId, getActiveShellId);
}

export function getShellPanels(): Record<string, ShellPanelEntry> {
  return panels;
}

export function getActiveShellId(): string | null {
  return activeShellId;
}

// 셸 패널을 활성(최상단 포커스)으로 표시한다. null이면 활성 셸 없음. activeShellId는 비영속이라 저장하지 않는다.
export function setActiveShellPanel(id: string | null): void {
  if (activeShellId === id) return;
  activeShellId = id;
  emit();
}

export function addShellPanel(theaterId: string, geometry: PanelGeometry): string {
  const id = newShellPanelId();
  panels = { ...panels, [id]: { theaterId, geometry } };
  scheduleSave();
  emit();
  return id;
}

export function setShellPanelGeometry(id: string, geometry: PanelGeometry): void {
  const existing = panels[id];
  if (!existing) return;
  panels = { ...panels, [id]: { ...existing, geometry } };
  scheduleSave();
  emit();
}

export function removeShellPanel(id: string): void {
  if (!(id in panels)) return;
  const next = { ...panels };
  delete next[id];
  panels = next;
  if (activeShellId === id) activeShellId = null;
  scheduleSave();
  emit();
}

// 메모리 레지스트리만 비운다(영속 저장은 건드리지 않는다). Theater 전환·새로고침에는 전체 교체를 담당하는
// loadShellPanelsForTheater를 쓰고, 이 함수는 영속 없이 화면만 비워야 하는 보조 경로용으로 남긴다.
export function clearShellPanels(): void {
  if (Object.keys(panels).length === 0 && activeShellId === null) return;
  panels = {};
  activeShellId = null;
  emit();
}

// Theater 전환·새로고침 시 호출한다. 이전 Theater의 보류 저장을 flush한 뒤 해당 Theater의 셸을 localStorage에서
// 복원한다. 복원된 셸의 최대 zIndex로 공유 카운터를 끌어올려 "활성화→최상단"이 새로고침 후에도 성립하게 한다.
export function loadShellPanelsForTheater(theaterId: string | null): void {
  flushScheduledSave();
  activeTheaterId = theaterId;
  panels = theaterId ? readStoredShellPanels(theaterId) : {};
  // 복원 직후에는 어떤 셸도 활성으로 두지 않는다(Operations 활성과의 상호배타를 깨지 않기 위함).
  activeShellId = null;
  liftTopZIndex(maxZIndexOf(panels));
  emit();
}

// Theater를 잊을 때 저장된 셸 패널도 함께 제거한다 — 안 그러면 같은 폴더를 같은 탭에서 재등록할 때 같은
// theaterId의 stale 엔트리가 삭제했던 셸을 되살리고 새 PTY를 마운트한다. Operations 패널은 서버 발급
// sessionId라 prune으로 자연 정리되지만, 셸 id는 클라이언트 발급이라 명시적 정리가 필요하다.
export function clearStoredShellPanelsForTheater(theaterId: string): void {
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(storageKey(theaterId));
    } catch {
      // 정리 실패는 stale 복원 가능성만 남기므로 런타임 흐름을 막지 않는다.
    }
  }
  // 잊는 Theater가 현재 로드된 것이면 보류 저장을 취소(잊은 키에 다시 쓰지 않도록)하고 메모리를 비운다.
  // 이후 activeTheater 전환이 loadShellPanelsForTheater로 새 Theater를 재로드한다.
  if (activeTheaterId === theaterId) {
    cancelScheduledSave();
    activeTheaterId = null;
    panels = {};
    activeShellId = null;
    emit();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Record<string, ShellPanelEntry> {
  return panels;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function scheduleSave(): void {
  if (!activeTheaterId || typeof window === "undefined") return;
  cancelScheduledSave();
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    writeStoredShellPanels(activeTheaterId, panels);
  }, SAVE_DELAY_MS);
}

function flushScheduledSave(): void {
  if (!saveTimer || !activeTheaterId || typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  writeStoredShellPanels(activeTheaterId, panels);
}

function cancelScheduledSave(): void {
  if (!saveTimer || typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
}

function readStoredShellPanels(theaterId: string): Record<string, ShellPanelEntry> {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.sessionStorage.getItem(storageKey(theaterId));
    if (!stored) return {};
    return normalizeStoredShellPanels(JSON.parse(stored), theaterId);
  } catch {
    return {};
  }
}

function writeStoredShellPanels(theaterId: string | null, value: Record<string, ShellPanelEntry>): void {
  if (!theaterId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(theaterId), JSON.stringify({ panels: value }));
  } catch {
    // 저장 실패는 셸 복구성만 낮추므로 런타임 흐름을 막지 않는다.
  }
}

function storageKey(theaterId: string): string {
  return `${STORAGE_KEY_PREFIX}${theaterId}`;
}

// 저장된 셸 패널을 검증·정규화한다. 셸 id가 아니거나 theaterId가 저장 키와 어긋난 stale 항목은 버린다.
function normalizeStoredShellPanels(value: unknown, theaterId: string): Record<string, ShellPanelEntry> {
  if (!isRecord(value) || !isRecord(value.panels)) return {};
  const result: Record<string, ShellPanelEntry> = {};
  for (const [id, entry] of Object.entries(value.panels)) {
    if (!id.startsWith("shell:") || !isRecord(entry)) continue;
    // 저장 키가 theaterId별이므로 entry.theaterId는 그 값과 일치해야 한다. 어긋나면 손상으로 보고 버린다.
    if (entry.theaterId !== theaterId) continue;
    result[id] = { theaterId, geometry: normalizeGeometry(entry.geometry) };
  }
  return result;
}

function normalizeGeometry(value: unknown): PanelGeometry {
  if (!isRecord(value)) {
    return { x: 0, y: 0, width: DEFAULT_SHELL_WIDTH, height: DEFAULT_SHELL_HEIGHT, zIndex: 0 };
  }
  return {
    x: readFiniteNumber(value.x, 0),
    y: readFiniteNumber(value.y, 0),
    width: readPositiveNumber(value.width, DEFAULT_SHELL_WIDTH),
    height: readPositiveNumber(value.height, DEFAULT_SHELL_HEIGHT),
    zIndex: readFiniteNumber(value.zIndex, 0),
  };
}

function maxZIndexOf(value: Record<string, ShellPanelEntry>): number {
  return Math.max(0, ...Object.values(value).map((entry) => entry.geometry.zIndex));
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 전역 고유 셸 패널 id. "shell:" prefix는 백엔드 theater-shell 판별을 위해 유지하되, 탭 간 충돌을 막도록
// 무작위 성분을 붙인다 — 다른 브라우저 컨텍스트가 같은 sessionId로 서로의 PTY에 잘못 attach/대체되는 것을
// 막는다. 같은 탭의 새로고침은 sessionStorage 복원으로 동일 id를 재사용해 살아 있는 PTY에 재부착한다.
function newShellPanelId(): string {
  const unique = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `shell:${unique}`;
}
