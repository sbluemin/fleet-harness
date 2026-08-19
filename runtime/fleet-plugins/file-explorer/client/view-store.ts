import { useSyncExternalStore } from "react";

import { MIN_TREE_PX, TREE_PANE_DEFAULT_WIDTH } from "./layout.js";

export type ViewState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "code"; relativePath: string; content: string; lang: string; truncated?: boolean; sizeBytes?: number }
  | { kind: "image"; relativePath: string; name: string; src: string }
  | { kind: "binary"; name: string }
  | { kind: "error"; message: string };

/** 뷰어 칩 하나 — 경로당 정확히 하나만 존재한다(paseo의 결정적 탭 문법). */
export interface OpenDocument {
  readonly relativePath: string;
  readonly name: string;
}

export interface DocSession {
  readonly openDocs: readonly OpenDocument[];
  readonly activePath: string | null;
  readonly history: readonly string[];
  readonly historyIndex: number;
}

interface TheaterViewState extends DocSession {
  readonly selectedPath: string | null;
  /** 경로별 뷰 내용 캐시 — 칩 전환을 즉시 그리기 위한 메모리 전용 상태. */
  readonly docStates: ReadonlyMap<string, ViewState>;
}

interface FileExplorerViewState extends TheaterViewState {
  readonly treePaneWidth: number;
}

type Listener = () => void;

const PREFS_TREE_PANE_WIDTH = "fleet-console.file-explorer.treePaneWidth";
const SESSION_KEY_PREFIX = "fleet-console.fileExplorer.session.";
const SESSION_OPEN_DOC_CAP = 20;

export const EMPTY_DOC_SESSION: DocSession = {
  openDocs: [],
  activePath: null,
  history: [],
  historyIndex: -1,
};

const DEFAULT_THEATER_STATE: TheaterViewState = {
  ...EMPTY_DOC_SESSION,
  selectedPath: null,
  docStates: new Map(),
};

const DEFAULT_SERVER_SNAPSHOT: FileExplorerViewState = {
  ...DEFAULT_THEATER_STATE,
  treePaneWidth: TREE_PANE_DEFAULT_WIDTH,
};

const theaterStateMap = new Map<string, TheaterViewState>();
const snapshotMap = new Map<string, FileExplorerViewState>();
const listeners = new Set<Listener>();
let treePaneWidth = readTreePaneWidth();

export function useFileExplorerViewState(theaterId: string | null): FileExplorerViewState {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(theaterId),
    () => DEFAULT_SERVER_SNAPSHOT,
  );
}

export function setSelectedPath(theaterId: string | null, selectedPath: string | null): void {
  if (!theaterId) return;
  patchTheaterState(theaterId, { selectedPath });
}

// ═══ 다중 열림 문서 세션 ═══════════════════════════════════════════════════════

/** 순수 전이: 문서 활성화 — 칩이 없으면 만들고, 이력의 앞쪽 가지를 잘라 끝에 쌓는다. */
export function activateDocument(session: DocSession, doc: OpenDocument): DocSession {
  const openDocs = session.openDocs.some((d) => d.relativePath === doc.relativePath)
    ? session.openDocs
    : [...session.openDocs, doc].slice(-SESSION_OPEN_DOC_CAP);
  if (session.activePath === doc.relativePath) return { ...session, openDocs };
  const kept = session.history.slice(0, session.historyIndex + 1);
  const history = kept.at(-1) === doc.relativePath ? kept : [...kept, doc.relativePath];
  return { openDocs, activePath: doc.relativePath, history, historyIndex: history.length - 1 };
}

/** 순수 전이: 이력 이동 — 닫힌 문서는 건너뛴다. */
export function navigateDocumentHistory(session: DocSession, delta: -1 | 1): DocSession {
  const openPaths = new Set(session.openDocs.map((d) => d.relativePath));
  for (let i = session.historyIndex + delta; i >= 0 && i < session.history.length; i += delta) {
    const candidate = session.history[i];
    if (candidate !== undefined && openPaths.has(candidate)) {
      return { ...session, activePath: candidate, historyIndex: i };
    }
  }
  return session;
}

export function canNavigateDocumentHistory(session: DocSession, delta: -1 | 1): boolean {
  return navigateDocumentHistory(session, delta) !== session;
}

/** 순수 전이: 문서 닫기 — 이력에서 해당 경로를 걷어내고, 활성은 직전 이력(없으면 마지막 칩)으로. */
export function closeDocument(session: DocSession, relativePath: string): DocSession {
  const openDocs = session.openDocs.filter((d) => d.relativePath !== relativePath);
  const collapsed: string[] = [];
  let historyIndex = -1;
  for (let i = 0; i < session.history.length; i += 1) {
    const entry = session.history[i];
    if (entry === undefined || entry === relativePath) continue;
    if (collapsed.at(-1) !== entry) collapsed.push(entry);
    if (i <= session.historyIndex) historyIndex = collapsed.length - 1;
  }
  if (historyIndex < 0) historyIndex = collapsed.length - 1;
  const activePath = session.activePath === relativePath
    ? collapsed[historyIndex] ?? openDocs.at(-1)?.relativePath ?? null
    : session.activePath;
  return { openDocs, activePath, history: collapsed, historyIndex };
}

export function activateStoredDocument(theaterId: string | null, doc: OpenDocument): void {
  if (!theaterId) return;
  const current = getOrDefault(theaterId);
  const next = activateDocument(current, doc);
  patchTheaterState(theaterId, { ...next, selectedPath: next.activePath });
  persistDocSession(theaterId, next);
}

export function navigateStoredHistory(theaterId: string | null, delta: -1 | 1): void {
  if (!theaterId) return;
  const current = getOrDefault(theaterId);
  const next = navigateDocumentHistory(current, delta);
  if (next === current) return;
  patchTheaterState(theaterId, { ...next, selectedPath: next.activePath });
  persistDocSession(theaterId, next);
}

export function closeStoredDocument(theaterId: string | null, relativePath: string): void {
  if (!theaterId) return;
  const current = getOrDefault(theaterId);
  const next = closeDocument(current, relativePath);
  const docStates = new Map(current.docStates);
  docStates.delete(relativePath);
  patchTheaterState(theaterId, { ...next, selectedPath: next.activePath, docStates });
  persistDocSession(theaterId, next);
}

export function setDocViewState(theaterId: string | null, relativePath: string, viewState: ViewState): void {
  if (!theaterId) return;
  const current = getOrDefault(theaterId);
  // 닫힌 문서의 늦은 응답은 캐시에 되살리지 않는다.
  if (!current.openDocs.some((d) => d.relativePath === relativePath)) return;
  const docStates = new Map(current.docStates);
  docStates.set(relativePath, viewState);
  patchTheaterState(theaterId, { docStates });
}

/** 저장된 세션을 스토어에 되살린다 — 이미 열린 문서가 있으면(메모리 우선) 건드리지 않는다. */
export function hydrateStoredSession(theaterId: string | null): void {
  if (!theaterId) return;
  const current = getOrDefault(theaterId);
  if (current.openDocs.length > 0 || current.activePath !== null) return;
  const persisted = readDocSession(theaterId);
  if (!persisted || persisted.openDocs.length === 0) return;
  patchTheaterState(theaterId, { ...persisted, selectedPath: persisted.activePath });
}

export function setTreePaneWidth(nextWidth: number): void {
  treePaneWidth = clampStoredTreePaneWidth(nextWidth);
  try {
    localStorage.setItem(PREFS_TREE_PANE_WIDTH, String(treePaneWidth));
  } catch {
    // localStorage 접근 실패 무시
  }
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function getOrDefault(theaterId: string): TheaterViewState {
  return theaterStateMap.get(theaterId) ?? DEFAULT_THEATER_STATE;
}

function getSnapshot(theaterId: string | null): FileExplorerViewState {
  const key = theaterId ?? "__none__";
  const base = theaterId != null ? getOrDefault(theaterId) : DEFAULT_THEATER_STATE;
  const prev = snapshotMap.get(key);
  if (
    prev
    && prev.selectedPath === base.selectedPath
    && prev.openDocs === base.openDocs
    && prev.activePath === base.activePath
    && prev.history === base.history
    && prev.historyIndex === base.historyIndex
    && prev.docStates === base.docStates
    && prev.treePaneWidth === treePaneWidth
  ) {
    return prev;
  }
  const next = { ...base, treePaneWidth };
  snapshotMap.set(key, next);
  return next;
}

function patchTheaterState(theaterId: string, patch: Partial<TheaterViewState>): void {
  theaterStateMap.set(theaterId, { ...getOrDefault(theaterId), ...patch });
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ═══ 세션 지속 ═══════════════════════════════════════════════════════════════

interface PersistedDocSession {
  readonly openDocs: readonly OpenDocument[];
  readonly activePath: string | null;
}

function persistDocSession(theaterId: string, session: DocSession): void {
  try {
    const payload: PersistedDocSession = {
      openDocs: session.openDocs,
      activePath: session.activePath,
    };
    if (payload.openDocs.length === 0) {
      localStorage.removeItem(SESSION_KEY_PREFIX + theaterId);
      return;
    }
    localStorage.setItem(SESSION_KEY_PREFIX + theaterId, JSON.stringify(payload));
  } catch {
    // localStorage 접근 실패 무시
  }
}

function readDocSession(theaterId: string): DocSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY_PREFIX + theaterId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDocSession>;
    if (!Array.isArray(parsed.openDocs)) return null;
    const openDocs = parsed.openDocs
      .filter((d): d is OpenDocument =>
        typeof d === "object" && d !== null
        && typeof (d as OpenDocument).relativePath === "string"
        && typeof (d as OpenDocument).name === "string")
      .slice(0, SESSION_OPEN_DOC_CAP);
    if (openDocs.length === 0) return null;
    const activePath = typeof parsed.activePath === "string"
      && openDocs.some((d) => d.relativePath === parsed.activePath)
      ? parsed.activePath
      : openDocs.at(-1)?.relativePath ?? null;
    // 이력은 지속하지 않는다 — 복원 세션은 활성 문서 하나짜리 이력으로 시작한다.
    return {
      openDocs,
      activePath,
      history: activePath ? [activePath] : [],
      historyIndex: activePath ? 0 : -1,
    };
  } catch {
    return null;
  }
}

function readTreePaneWidth(): number {
  try {
    return clampStoredTreePaneWidth(Number(localStorage.getItem(PREFS_TREE_PANE_WIDTH)));
  } catch {
    return TREE_PANE_DEFAULT_WIDTH;
  }
}

function clampStoredTreePaneWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return TREE_PANE_DEFAULT_WIDTH;
  return Math.max(MIN_TREE_PX, Math.round(width));
}
