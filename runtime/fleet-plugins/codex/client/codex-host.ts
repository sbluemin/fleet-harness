import { mountNavigatorApp } from "./codex/main.js";
import type { NavigatorController, NavigatorRequest } from "./codex/main.js";
import { mountReadingInto } from "./codex/reading-controller.js";
import type { MountReadingOptions, ReadingController } from "./codex/reading-controller.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { NavigatorRequest } from "./codex/main.js";
export type { MountReadingOptions } from "./codex/reading-controller.js";

export type ReaderSlotOptions = Omit<MountReadingOptions, "tocContainer" | "onEntryRendered" | "onTocChanged"> & {
  readonly sessionTheaterId: string | null;
};

export interface ReaderHistoryState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

interface ReaderSession {
  readonly entryId: string;
  readonly scrollTop: number;
  /** 새로고침 전에 확대(전체 읽기) 상태였는지 — 화면 모드까지 함께 복원한다. */
  readonly expanded: boolean;
}

interface HistoryEntry {
  readonly entryId: string;
  /** 이 문서를 떠날 때의 읽던 자리. 돌아오면 여기서 이어 읽는다. */
  scrollTop: number;
}

export interface ReaderDocumentState {
  readonly entryId: string | null;
  readonly title: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const READER_SESSION_PREFIX = "fleet.codex.reader.session.";
const SCROLL_SAVE_DELAY_MS = 500;

// Navigator 싱글톤 — appendChild 재배치로 컨테이너를 교체, destroy+remount 없음
let hostNode: HTMLDivElement | null = null;
let navigatorController: NavigatorController | null = null;
let onRequestOpenReaderHandler: ((r: NavigatorRequest) => void) | null = null;
let activeNavigatorWorkspaceId: string | null = null;

// Reader 싱글톤 — split·오버레이 사이를 같은 노드로 relocate하여 콘텐츠·스크롤 보존
let readerHostNode: HTMLDivElement | null = null;
let tocHostNode: HTMLDivElement | null = null;
// Cowork 도크 싱글톤 호스트 — 프레임 경계 슬롯(.codex-reader-composer)로 relocate된다.
let dockHostNode: HTMLDivElement | null = null;
let readerController: ReadingController | null = null;
let activeReaderKind: "entry" | "drydock" | "conflicts" | "schema" | null = null;
let activeReaderEntryId: string | null = null;
let activeReaderSubId: string | undefined = undefined;
let activeReaderSessionTheaterId: string | null = null;
let activeEntryRequest: ((entryId: string) => void) | null = null;
let lastReaderScrollTop = 0;
let scrollRestoreCleanup: (() => void) | null = null;
let scrollSaveSlot: HTMLElement | null = null;
let scrollSaveTimerId: ReturnType<typeof setTimeout> | null = null;
let lastObservedScrollTop = 0;
let pageHideBound = false;

let historyEntries: HistoryEntry[] = [];
let historyIndex = -1;
let historySnapshot: ReaderHistoryState = { canGoBack: false, canGoForward: false };
let pendingHistoryEntryId: string | null = null;
let pendingHistoryScrollTop = 0;
let pendingSessionRestore: ReaderSession | null = null;
const historyListeners = new Set<() => void>();

let pendingRestoredExpanded = false;
let documentSnapshot: ReaderDocumentState = { entryId: null, title: "" };
const documentListeners = new Set<() => void>();
let readerExpandedForSession = false;

// ─── Public API ───────────────────────────────────────────────────────────────

export function setOnRequestOpenReader(
  handler: ((r: NavigatorRequest) => void) | null,
): void {
  onRequestOpenReaderHandler = handler;
}

export function mountNavigatorInto(
  container: HTMLElement,
  initialTheaterId: string | null,
): void {
  const node = ensureHostNode();
  if (node.parentElement !== container) container.appendChild(node);
  if (!navigatorController) {
    navigatorController = mountNavigatorApp(node, {
      initialTheaterId,
      onRequest: (r) => onRequestOpenReaderHandler?.(r),
    });
  }
  // 컨트롤러가 이미 있으면 컨테이너 재배치만 한다. Theater 변경은 전용 setNavigatorTheater
  // 경로로만 처리 — 여기서 setTheater를 호출하면 split 진입(relocate)마다 currentEntryId가
  // 리셋되어 nav의 현재 항목 표시(is-current/aria-current)가 사라진다.
}

export function setNavigatorTheater(theaterId: string | null): void {
  if (theaterId === activeNavigatorWorkspaceId) return;
  activeNavigatorWorkspaceId = theaterId;
  navigatorController?.setTheater(theaterId);
}

/** 리더 문서의 태그 칩 클릭을 카탈로그 태그 필터로 잇는다. */
export function setNavigatorTagFilter(tag: string): void {
  navigatorController?.setActiveTag(tag);
}

export function restoreCodexReaderSession(theaterId: string): string | null {
  prepareReaderTheater(theaterId);
  const session = readReaderSession(theaterId);
  if (!session) return null;
  pendingSessionRestore = session;
  pendingRestoredExpanded = session.expanded;
  readerExpandedForSession = session.expanded;
  lastReaderScrollTop = session.scrollTop;
  return session.entryId;
}

export function getCodexReaderHistoryState(): ReaderHistoryState {
  return historySnapshot;
}

export function subscribeCodexReaderHistory(listener: () => void): () => void {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}

export function navigateCodexReaderHistory(direction: -1 | 1): void {
  const nextIndex = historyIndex + direction;
  const target = historyEntries[nextIndex];
  if (!target || nextIndex < 0 || nextIndex >= historyEntries.length) return;
  // 떠나기 전에 지금 자리를 현재 항목에 적어 둔다 — 돌아왔을 때 이어 읽기 위한 값이다.
  const current = historyEntries[historyIndex];
  const slot = readerHostNode?.parentElement;
  if (current && slot) current.scrollTop = slot.scrollTop;
  historyIndex = nextIndex;
  pendingHistoryEntryId = target.entryId;
  pendingHistoryScrollTop = target.scrollTop;
  emitHistoryState();
  activeEntryRequest?.(target.entryId);
}

/**
 * 주소가 지목한 문서가 저장된 세션의 문서와 같으면 그 자리를 복원 대상으로 세운다.
 *
 * 세션을 읽는 다른 경로(레일 패널의 최초 복원)는 리더가 아직 없을 때만 돈다. 링크나
 * 새로고침으로 주소가 먼저 문서를 열면 그 경로가 건너뛰어져, 저장된 자리를 아무도
 * 읽지 않은 채 문서가 맨 위에서 열린다.
 */
export function prepareReaderSessionScroll(theaterId: string, entryId: string): void {
  const session = readReaderSession(theaterId);
  if (!session || session.entryId !== entryId) return;
  prepareReaderTheater(theaterId);
  pendingSessionRestore = session;
  readerExpandedForSession = session.expanded;
  lastReaderScrollTop = session.scrollTop;
}

/**
 * 주소가 지목한 문서가 리더 기록의 바로 뒤/앞이면 그 걸음으로 옮긴다.
 *
 * 브라우저 뒤로가기는 리더에게는 그냥 "이 문서를 열어라"로 도착한다. 그대로 새 방문으로
 * 처리하면 같은 문서가 기록에 중복으로 쌓이고, 그 항목이 들고 있던 읽던 자리도 쓰이지
 * 않으며, 시트의 ←는 엉뚱한 문서를 가리킨 채 남는다.
 */
export function stepReaderHistoryTo(entryId: string): boolean {
  if (historyEntries[historyIndex - 1]?.entryId === entryId) {
    navigateCodexReaderHistory(-1);
    return true;
  }
  if (historyEntries[historyIndex + 1]?.entryId === entryId) {
    navigateCodexReaderHistory(1);
    return true;
  }
  return false;
}

export function getCodexReaderDocumentState(): ReaderDocumentState {
  return documentSnapshot;
}

export function subscribeCodexReaderDocument(listener: () => void): () => void {
  documentListeners.add(listener);
  return () => documentListeners.delete(listener);
}

/** 확대 여부는 리더 세션의 일부다 — 새로고침 뒤 같은 화면으로 돌아오게 한다. */
export function setCodexReaderExpandedForSession(expanded: boolean): void {
  if (readerExpandedForSession === expanded) return;
  readerExpandedForSession = expanded;
  const slot = readerHostNode?.parentElement;
  persistCurrentReaderSession(slot?.scrollTop ?? 0);
}

export function consumeRestoredReaderExpanded(): boolean {
  return pendingRestoredExpanded;
}

/** 열린 navigator/reader 문구를 현재 로케일로 다시 그린다(문서·스크롤 보존). */
export function refreshCodexLocale(): void {
  navigatorController?.refreshLocale();
  void readerController?.refreshLocale();
}

export function refreshCodexHealth(): void {
  navigatorController?.refreshHealth();
}

export function mountReaderInto(
  readSlot: HTMLElement,
  tocSlot: HTMLElement,
  dockSlot: HTMLElement,
  opts: ReaderSlotOptions,
): void {
  scrollRestoreCleanup?.();
  const rNode = ensureReaderHostNode();
  const tNode = ensureTocHostNode();
  const dNode = ensureDockHostNode();
  if (activeReaderKind === "entry" && rNode.parentElement) {
    persistCurrentReaderSession(rNode.parentElement.scrollTop);
  }
  const sameTheater = activeReaderSessionTheaterId === opts.sessionTheaterId;
  prepareReaderTheater(opts.sessionTheaterId);

  // 같은 엔트리를 split↔오버레이로 relocate할 때 외부 스크롤 컨테이너(.codex-doc-scroll ↔
  // .codex-reading-sheet-read)가 달라 scrollTop이 리셋된다. 이동 전 이전 컨테이너의
  // scrollTop을 저장했다가, 같은 엔트리면 새 컨테이너에 복원해 읽기 위치를 보존한다.
  const prevReadSlot = rNode.parentElement;
  const sameEntry =
    sameTheater && opts.kind === "entry" && activeReaderKind === "entry" && opts.initialEntryId === activeReaderEntryId;
  // 이전 컨테이너가 아직 살아 있으면(예: Expand 시 split doc-scroll) 그 scrollTop을 저장한다.
  // Esc 방향(overlay→split)은 overlay 언마운트 전 닫기 핸들러가 saveReaderScroll로 미리 저장.
  if (prevReadSlot && prevReadSlot !== readSlot && prevReadSlot.isConnected) {
    lastReaderScrollTop = prevReadSlot.scrollTop;
  }

  const sessionRestore =
    opts.kind === "entry" && pendingSessionRestore?.entryId === opts.initialEntryId
      ? pendingSessionRestore
      : null;
  if (opts.kind === "entry" && pendingSessionRestore && !sessionRestore) {
    pendingSessionRestore = null;
  }
  let historyRestoreScrollTop: number | null = null;
  if (opts.kind === "entry" && opts.initialEntryId) {
    if (pendingHistoryEntryId === opts.initialEntryId) {
      pendingHistoryEntryId = null;
      historyRestoreScrollTop = pendingHistoryScrollTop;
      pendingHistoryScrollTop = 0;
    } else if (sessionRestore) {
      // 복원된 문서는 방문이 아니지만 기록의 출발점이긴 하다 — 심어 두지 않으면 다음
      // 문서가 유일한 항목이 되어 ←로 돌아올 곳이 사라진다.
      seedHistoryEntry(opts.initialEntryId, sessionRestore.scrollTop);
    } else if (!sameEntry) {
      pushHistoryEntry(opts.initialEntryId);
    }
  }

  // DOM의 appendChild는 기존 부모에서 자동 detach → split·오버레이 사이를 콘텐츠 보존으로 relocate
  const relocated = rNode.parentElement !== readSlot;
  if (rNode.parentElement !== readSlot) readSlot.appendChild(rNode);
  if (tNode.parentElement !== tocSlot) tocSlot.appendChild(tNode);
  if (dNode.parentElement !== dockSlot) dockSlot.appendChild(dNode);

  const { sessionTheaterId: _sessionTheaterId, ...readingOpts } = opts;
  if (!readerController || activeReaderKind !== opts.kind || !sameTheater) {
    readerController?.destroy();
    readerController = mountReadingInto(rNode, {
      ...readingOpts,
      tocContainer: tNode,
      dockContainer: dNode,
      onEntryRendered: handleEntryRendered,
      onTocChanged: handleTocChanged,
      onDocumentChanged: emitDocumentState,
    });
    activeReaderKind = opts.kind;
    activeReaderSubId = opts.subId;
  } else if (opts.kind === "entry" && opts.initialEntryId && opts.initialEntryId !== activeReaderEntryId) {
    // 엔트리가 실제로 바뀐 경우에만 재렌더(같은 엔트리 relocate는 재렌더 없이 스크롤 보존).
    void readerController.setEntry(opts.initialEntryId);
  } else if ((opts.kind === "drydock" || opts.kind === "conflicts" || opts.kind === "schema") && opts.subId !== activeReaderSubId) {
    // 드라이독/컨플릭트: subId가 바뀐 경우(목록↔상세 전환) navigateSub으로 내부 재렌더
    activeReaderSubId = opts.subId;
    void readerController.navigateSub(opts.subId);
  }
  activeReaderEntryId = opts.kind === "entry" ? (opts.initialEntryId ?? null) : null;
  navigatorController?.setCurrentEntry(activeReaderEntryId);
  activeEntryRequest = opts.onRelatedClick;

  // relocate마다 현재 마운트 소유자(split/overlay)의 콜백을 컨트롤러에 반영한다.
  // 재생성 경로에서도 idempotent이므로 항상 호출한다.
  readerController.refreshCallbacks({
    onPatchOpen: opts.onPatchOpen,
    onConflictOpen: opts.onConflictOpen,
    onDecided: opts.onDecided,
    onRelatedClick: opts.onRelatedClick,
    onClose: opts.onClose,
    onTagClick: opts.onTagClick,
    theaterId: opts.theaterId,
  });
  syncInlineOutline(tNode);
  attachSessionScrollSaver(readSlot);
  // 노드만 옮기면 스크롤 스파이의 리스너는 옛 스크롤 루트를 계속 붙잡고 있다 —
  // relocate한 쪽에서 다시 세워야 확대 화면의 목차가 읽는 위치를 따라온다.
  if (relocated) readerController.refreshScrollSpy();

  const targetScrollTop =
    sessionRestore?.scrollTop ?? historyRestoreScrollTop ?? (sameEntry ? lastReaderScrollTop : 0);
  if (targetScrollTop <= 0) {
    requestAnimationFrame(() => {
      readSlot.scrollTop = targetScrollTop;
    });
    return;
  }
  startScrollRestore(readSlot, tNode, rNode, targetScrollTop);
}

// 컨테이너 전환(특히 overlay→split) 직전, 아직 살아 있는 reader 컨테이너의 scrollTop을 저장한다.
// React effect cleanup은 DOM 제거 후 실행돼 늦으므로, 닫기 핸들러에서 동기로 호출해야 한다.
export function saveReaderScroll(): void {
  const parent = readerHostNode?.parentElement;
  if (parent) {
    lastReaderScrollTop = parent.scrollTop;
    persistCurrentReaderSession(parent.scrollTop);
  }
}

export function teardownReaderNodes(): void {
  saveReaderScroll();
  documentSnapshot = { entryId: null, title: "" };
  for (const listener of documentListeners) listener();
  scrollRestoreCleanup?.();
  detachSessionScrollSaver();
  readerController?.destroy();
  readerController = null;
  activeReaderKind = null;
  activeReaderEntryId = null;
  activeReaderSubId = undefined;
  activeEntryRequest = null;
  if (readerHostNode?.parentElement) readerHostNode.parentElement.removeChild(readerHostNode);
  if (tocHostNode?.parentElement) tocHostNode.parentElement.removeChild(tocHostNode);
  if (dockHostNode?.parentElement) dockHostNode.parentElement.removeChild(dockHostNode);
}

export function teardownCodex(): void {
  teardownReaderNodes();
  navigatorController?.destroy();
  navigatorController = null;
  activeNavigatorWorkspaceId = null;
  activeReaderSessionTheaterId = null;
  clearHistory();
  pendingSessionRestore = null;
  if (hostNode?.parentElement) hostNode.parentElement.removeChild(hostNode);
}

// ─── Reader state ─────────────────────────────────────────────────────────────

function prepareReaderTheater(theaterId: string | null): void {
  if (activeReaderSessionTheaterId === theaterId) return;
  activeReaderSessionTheaterId = theaterId;
  lastReaderScrollTop = 0;
  pendingSessionRestore = null;
  pendingHistoryEntryId = null;
  clearHistory();
}

function pushHistoryEntry(entryId: string): void {
  if (historyEntries[historyIndex]?.entryId === entryId) return;
  // 새 문서로 떠나기 전에 현재 문서의 자리를 적는다(뒤로 돌아오면 그 자리에서 이어 읽는다).
  const current = historyEntries[historyIndex];
  const slot = readerHostNode?.parentElement;
  if (current && slot) current.scrollTop = slot.scrollTop;
  historyEntries = historyEntries.slice(0, historyIndex + 1);
  historyEntries.push({ entryId, scrollTop: 0 });
  historyIndex = historyEntries.length - 1;
  emitHistoryState();
}

function seedHistoryEntry(entryId: string, scrollTop: number): void {
  if (historyEntries.length > 0) return;
  historyEntries = [{ entryId, scrollTop }];
  historyIndex = 0;
  emitHistoryState();
}

function clearHistory(): void {
  historyEntries = [];
  historyIndex = -1;
  emitHistoryState();
}

function emitHistoryState(): void {
  const next = {
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex >= 0 && historyIndex < historyEntries.length - 1,
  };
  if (next.canGoBack === historySnapshot.canGoBack && next.canGoForward === historySnapshot.canGoForward) return;
  historySnapshot = next;
  for (const listener of historyListeners) listener();
}

function emitDocumentState(): void {
  const doc = readerController?.getDocument() ?? null;
  const next: ReaderDocumentState = {
    entryId: doc?.entryId ?? null,
    title: doc?.title ?? "",
  };
  if (next.entryId === documentSnapshot.entryId && next.title === documentSnapshot.title) return;
  documentSnapshot = next;
  for (const listener of documentListeners) listener();
}

/** 확대 헤드바가 현재 문서의 원문을 읽는다(원문 보기·복사). */
export function getCodexReaderMarkdown(): string | null {
  return readerController?.getDocument()?.markdown ?? null;
}

function handleEntryRendered(entryId: string): void {
  emitDocumentState();
  const completedSessionRestore = pendingSessionRestore?.entryId === entryId;
  pendingSessionRestore = null;
  if (completedSessionRestore) return;
  const scrollTop = readerHostNode?.parentElement?.scrollTop ?? 0;
  persistCurrentReaderSession(scrollTop);
}

function handleTocChanged(count: number): void {
  if (tocHostNode) tocHostNode.dataset.tocCount = String(count);
  syncInlineOutline(tocHostNode);
}

function syncInlineOutline(tocNode: HTMLElement | null): void {
  if (!tocNode) return;
  const outline = tocNode.closest<HTMLElement>("[data-codex-outline]");
  if (!outline) return;
  const parsedCount = Number.parseInt(tocNode.dataset.tocCount ?? "0", 10);
  const count = activeReaderKind === "entry" && Number.isFinite(parsedCount) ? parsedCount : 0;
  outline.dataset.tocCount = String(count);
  const countNode = outline.querySelector<HTMLElement>("[data-codex-outline-count]");
  if (countNode) countNode.textContent = String(count);
}

function attachSessionScrollSaver(slot: HTMLElement): void {
  if (scrollSaveSlot === slot) return;
  detachSessionScrollSaver();
  scrollSaveSlot = slot;
  lastObservedScrollTop = slot.scrollTop;
  slot.addEventListener("scroll", handleSessionScroll, { passive: true });
  if (!pageHideBound && typeof window !== "undefined") {
    pageHideBound = true;
    window.addEventListener("pagehide", flushReaderSession);
    document.addEventListener("visibilitychange", flushReaderSession);
  }
}

/**
 * 500ms 디바운스가 만료되기 전에 창을 떠나면 마지막 스크롤이 저장되지 않는다.
 * 다만 이탈 시점의 컨테이너는 이미 0으로 접혀 있을 수 있으므로, 그때는 마지막으로
 * 관측한 위치를 쓴다 — 그 값이 0이면 사용자가 정말로 맨 위에 있던 것이다.
 */
function flushReaderSession(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  if (scrollSaveTimerId !== null) {
    clearTimeout(scrollSaveTimerId);
    scrollSaveTimerId = null;
  }
  if (!scrollSaveSlot) return;
  const live = scrollSaveSlot.scrollTop;
  persistCurrentReaderSession(live > 0 ? live : lastObservedScrollTop);
}

function detachSessionScrollSaver(): void {
  if (scrollSaveSlot) scrollSaveSlot.removeEventListener("scroll", handleSessionScroll);
  scrollSaveSlot = null;
  if (scrollSaveTimerId !== null) clearTimeout(scrollSaveTimerId);
  scrollSaveTimerId = null;
}

function handleSessionScroll(): void {
  if (scrollSaveSlot) lastObservedScrollTop = scrollSaveSlot.scrollTop;
  if (pendingSessionRestore || scrollSaveTimerId !== null) return;
  scrollSaveTimerId = setTimeout(() => {
    scrollSaveTimerId = null;
    if (scrollSaveSlot) persistCurrentReaderSession(scrollSaveSlot.scrollTop);
  }, SCROLL_SAVE_DELAY_MS);
}

function persistCurrentReaderSession(scrollTop: number): void {
  if (activeReaderKind !== "entry" || !activeReaderEntryId || !activeReaderSessionTheaterId) return;
  writeReaderSession(activeReaderSessionTheaterId, {
    entryId: activeReaderEntryId,
    scrollTop,
    expanded: readerExpandedForSession,
  });
}

function readReaderSession(theaterId: string): ReaderSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(`${READER_SESSION_PREFIX}${theaterId}`) ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.entryId !== "string" || record.entryId.length === 0) return null;
    if (typeof record.scrollTop !== "number" || !Number.isFinite(record.scrollTop) || record.scrollTop < 0) return null;
    return { entryId: record.entryId, scrollTop: record.scrollTop, expanded: record.expanded === true };
  } catch {
    return null;
  }
}

function writeReaderSession(theaterId: string, session: ReaderSession): void {
  try {
    localStorage.setItem(`${READER_SESSION_PREFIX}${theaterId}`, JSON.stringify(session));
  } catch {
    // Storage is optional.
  }
}

function startScrollRestore(
  readSlot: HTMLElement,
  tocNode: HTMLElement,
  readerNode: HTMLElement,
  targetScrollTop: number,
): void {
  // 긴 문서는 마크다운 하이드레이션 뒤에도 높이가 바뀌므로 단발 rAF만으로는 읽기 위치가
  // 밀린다. 다단계 reflow의 임시 geometry에서는 scrollTop 연속 일치도 안정의 증거가
  // 아니므로 마지막 크기 변화 뒤 quiet window까지 보정하되 사용자 스크롤 시 즉시 포기한다.
  let active = true;
  let animationFrameId: number | null = null;
  let quietTimerId: ReturnType<typeof setTimeout> | null = null;
  let failsafeTimerId: ReturnType<typeof setTimeout> | null = null;
  let suspectTimerId: ReturnType<typeof setTimeout> | null = null;
  let observer: ResizeObserver | null = null;
  const userScrollEvents = ["wheel", "touchmove", "keydown"] as const;

  const cleanup = () => {
    if (!active) return;
    active = false;
    observer?.disconnect();
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    if (quietTimerId !== null) clearTimeout(quietTimerId);
    if (failsafeTimerId !== null) clearTimeout(failsafeTimerId);
    if (suspectTimerId !== null) clearTimeout(suspectTimerId);
    for (const eventName of userScrollEvents) {
      readSlot.removeEventListener(eventName, cleanup, { capture: true });
    }
    readSlot.removeEventListener("scroll", handleScroll);
    tocNode.removeEventListener("click", cleanup, { capture: true });
    if (scrollRestoreCleanup === cleanup) scrollRestoreCleanup = null;
  };

  // scroll anchoring도 scroll 이벤트를 만들지만 콘텐츠 크기 변화를 동반하므로, 짧은 RO
  // 상관 구간 안에 resize가 없을 때만 사용자의 스크롤바 이동으로 판정한다.
  const handleScroll = () => {
    if (!active) return;
    if (Math.abs(readSlot.scrollTop - targetScrollTop) <= 2) return;
    if (quietTimerId !== null) {
      clearTimeout(quietTimerId);
      quietTimerId = null;
    }
    if (suspectTimerId !== null) clearTimeout(suspectTimerId);
    suspectTimerId = setTimeout(() => {
      suspectTimerId = null;
      cleanup();
    }, 150);
  };

  scrollRestoreCleanup = cleanup;
  for (const eventName of userScrollEvents) {
    readSlot.addEventListener(eventName, cleanup, { passive: true, capture: true });
  }
  readSlot.addEventListener("scroll", handleScroll, { passive: true });
  tocNode.addEventListener("click", cleanup, { capture: true });

  const restore = () => {
    if (!active) return;
    readSlot.scrollTop = targetScrollTop;
  };
  const scheduleQuietCheck = () => {
    if (quietTimerId !== null) clearTimeout(quietTimerId);
    quietTimerId = setTimeout(() => {
      quietTimerId = null;
      if (!active) return;
      if (Math.abs(readSlot.scrollTop - targetScrollTop) <= 2) {
        cleanup();
        return;
      }
      restore();
      scheduleQuietCheck();
    }, 400);
  };

  restore();
  animationFrameId = requestAnimationFrame(restore);

  observer = new ResizeObserver(() => {
    if (!active) return;
    if (suspectTimerId !== null) {
      clearTimeout(suspectTimerId);
      suspectTimerId = null;
    }
    if (Math.abs(readSlot.scrollTop - targetScrollTop) > 2) {
      restore();
    }
    scheduleQuietCheck();
  });
  observer.observe(readerNode);
  scheduleQuietCheck();
  failsafeTimerId = setTimeout(cleanup, 5_000);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function ensureHostNode(): HTMLDivElement {
  if (!hostNode) {
    hostNode = document.createElement("div");
    hostNode.className = "codex-host";
  }
  return hostNode;
}

function ensureReaderHostNode(): HTMLDivElement {
  if (!readerHostNode) {
    readerHostNode = document.createElement("div");
    readerHostNode.className = "codex-reader-host";
  }
  return readerHostNode;
}

function ensureTocHostNode(): HTMLDivElement {
  if (!tocHostNode) {
    tocHostNode = document.createElement("div");
    tocHostNode.className = "codex-toc-host";
  }
  return tocHostNode;
}

function ensureDockHostNode(): HTMLDivElement {
  if (!dockHostNode) {
    dockHostNode = document.createElement("div");
    dockHostNode.className = "codex-dock-host";
  }
  return dockHostNode;
}
