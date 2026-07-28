import { mountNavigatorApp } from "./codex/main.js";
import type { NavigatorController, NavigatorRequest } from "./codex/main.js";
import { mountReadingInto } from "./codex/reading-controller.js";
import type { MountReadingOptions, ReadingController } from "./codex/reading-controller.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { NavigatorRequest } from "./codex/main.js";
export type { MountReadingOptions } from "./codex/reading-controller.js";

export type ReaderSlotOptions = Omit<MountReadingOptions, "tocContainer">;

// ─── Constants ────────────────────────────────────────────────────────────────

// Navigator 싱글톤 — appendChild 재배치로 컨테이너를 교체, destroy+remount 없음
let hostNode: HTMLDivElement | null = null;
let navigatorController: NavigatorController | null = null;
let onRequestOpenReaderHandler: ((r: NavigatorRequest) => void) | null = null;
let activeNavigatorWorkspaceId: string | null = null;

// Reader 싱글톤 — split·오버레이 사이를 같은 노드로 relocate하여 콘텐츠·스크롤 보존
let readerHostNode: HTMLDivElement | null = null;
let tocHostNode: HTMLDivElement | null = null;
let readerController: ReadingController | null = null;
let activeReaderKind: "entry" | "drydock" | "conflicts" | "schema" | null = null;
let activeReaderEntryId: string | null = null;
let activeReaderSubId: string | undefined = undefined;
let lastReaderScrollTop = 0;
let scrollRestoreCleanup: (() => void) | null = null;

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

/** 열린 navigator/reader 문구를 현재 로케일로 다시 그린다(문서·스크롤 보존). */
export function refreshCodexLocale(): void {
  navigatorController?.refreshLocale();
  void readerController?.refreshLocale();
}

export function mountReaderInto(
  readSlot: HTMLElement,
  tocSlot: HTMLElement,
  opts: ReaderSlotOptions,
): void {
  scrollRestoreCleanup?.();
  const rNode = ensureReaderHostNode();
  const tNode = ensureTocHostNode();
  // 같은 엔트리를 split↔오버레이로 relocate할 때 외부 스크롤 컨테이너(.codex-doc-scroll ↔
  // .codex-reading-sheet-read)가 달라 scrollTop이 리셋된다. 이동 전 이전 컨테이너의
  // scrollTop을 저장했다가, 같은 엔트리면 새 컨테이너에 복원해 읽기 위치를 보존한다.
  const prevReadSlot = rNode.parentElement;
  const sameEntry =
    opts.kind === "entry" && activeReaderKind === "entry" && opts.initialEntryId === activeReaderEntryId;
  // 이전 컨테이너가 아직 살아 있으면(예: Expand 시 split doc-scroll) 그 scrollTop을 저장한다.
  // Esc 방향(overlay→split)은 overlay 언마운트 전 닫기 핸들러가 saveReaderScroll로 미리 저장.
  if (prevReadSlot && prevReadSlot !== readSlot && prevReadSlot.isConnected) {
    lastReaderScrollTop = prevReadSlot.scrollTop;
  }

  // DOM의 appendChild는 기존 부모에서 자동 detach → split·오버레이 사이를 콘텐츠 보존으로 relocate
  if (rNode.parentElement !== readSlot) readSlot.appendChild(rNode);
  if (tNode.parentElement !== tocSlot) tocSlot.appendChild(tNode);

  if (!readerController || activeReaderKind !== opts.kind) {
    readerController?.destroy();
    readerController = mountReadingInto(rNode, { ...opts, tocContainer: tNode });
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

  // relocate마다 현재 마운트 소유자(split/overlay)의 콜백을 컨트롤러에 반영한다.
  // 재생성 경로에서도 idempotent이므로 항상 호출한다.
  readerController.refreshCallbacks({
    onPatchOpen: opts.onPatchOpen,
    onDecided: opts.onDecided,
    onRelatedClick: opts.onRelatedClick,
    onClose: opts.onClose,
    theaterId: opts.theaterId,
  });

  const targetScrollTop = sameEntry ? lastReaderScrollTop : 0;
  if (targetScrollTop <= 0) {
    requestAnimationFrame(() => {
      readSlot.scrollTop = targetScrollTop;
    });
    return;
  }

  // 긴 문서는 마크다운 하이드레이션 뒤에도 높이가 바뀌므로 단발 rAF만으로는 읽기 위치가
  // 밀린다. 다단계 reflow의 임시 geometry에서는 scrollTop 연속 일치도 안정의 증거가
  // 아니므로 마지막 크기 변화 뒤 quiet window까지 보정하되 사용자 스크롤 시 즉시 포기한다.
  let active = true;
  let animationFrameId: number | null = null;
  let quietTimerId: ReturnType<typeof setTimeout> | null = null;
  let failsafeTimerId: ReturnType<typeof setTimeout> | null = null;
  let observer: ResizeObserver | null = null;
  const userScrollEvents = ["wheel", "touchmove", "keydown"] as const;

  const cleanup = () => {
    if (!active) return;
    active = false;
    observer?.disconnect();
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    if (quietTimerId !== null) clearTimeout(quietTimerId);
    if (failsafeTimerId !== null) clearTimeout(failsafeTimerId);
    for (const eventName of userScrollEvents) {
      readSlot.removeEventListener(eventName, cleanup, { capture: true });
    }
    if (scrollRestoreCleanup === cleanup) scrollRestoreCleanup = null;
  };

  scrollRestoreCleanup = cleanup;
  for (const eventName of userScrollEvents) {
    readSlot.addEventListener(eventName, cleanup, { passive: true, capture: true });
  }

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
    if (Math.abs(readSlot.scrollTop - targetScrollTop) > 2) {
      restore();
    }
    scheduleQuietCheck();
  });
  observer.observe(rNode);
  scheduleQuietCheck();
  failsafeTimerId = setTimeout(cleanup, 5_000);
}

// 컨테이너 전환(특히 overlay→split) 직전, 아직 살아 있는 reader 컨테이너의 scrollTop을 저장한다.
// React effect cleanup은 DOM 제거 후 실행돼 늦으므로, 닫기 핸들러에서 동기로 호출해야 한다.
export function saveReaderScroll(): void {
  const parent = readerHostNode?.parentElement;
  if (parent) lastReaderScrollTop = parent.scrollTop;
}

export function teardownReaderNodes(): void {
  scrollRestoreCleanup?.();
  readerController?.destroy();
  readerController = null;
  activeReaderKind = null;
  activeReaderSubId = undefined;
  if (readerHostNode?.parentElement) readerHostNode.parentElement.removeChild(readerHostNode);
  if (tocHostNode?.parentElement) tocHostNode.parentElement.removeChild(tocHostNode);
}

export function teardownCodex(): void {
  teardownReaderNodes();
  navigatorController?.destroy();
  navigatorController = null;
  activeNavigatorWorkspaceId = null;
  if (hostNode?.parentElement) hostNode.parentElement.removeChild(hostNode);
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
