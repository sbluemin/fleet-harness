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

// Reader 싱글톤 — split·오버레이 사이를 같은 노드로 relocate하여 콘텐츠·스크롤 보존
let readerHostNode: HTMLDivElement | null = null;
let tocHostNode: HTMLDivElement | null = null;
let readerController: ReadingController | null = null;
let activeReaderKind: "entry" | "drydock" | "conflicts" | null = null;

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
  } else {
    navigatorController.setTheater(initialTheaterId);
  }
}

export function setNavigatorTheater(theaterId: string | null): void {
  navigatorController?.setTheater(theaterId);
}

export function mountReaderInto(
  readSlot: HTMLElement,
  tocSlot: HTMLElement,
  opts: ReaderSlotOptions,
): void {
  const rNode = ensureReaderHostNode();
  const tNode = ensureTocHostNode();
  // DOM의 appendChild는 기존 부모에서 자동 detach → split·오버레이 사이를 콘텐츠 보존으로 relocate
  if (rNode.parentElement !== readSlot) readSlot.appendChild(rNode);
  if (tNode.parentElement !== tocSlot) tocSlot.appendChild(tNode);

  if (!readerController || activeReaderKind !== opts.kind) {
    readerController?.destroy();
    readerController = mountReadingInto(rNode, { ...opts, tocContainer: tNode });
    activeReaderKind = opts.kind;
  } else if (opts.kind === "entry" && opts.initialEntryId) {
    void readerController.setEntry(opts.initialEntryId);
  }
}

export function teardownReaderNodes(): void {
  readerController?.destroy();
  readerController = null;
  activeReaderKind = null;
  if (readerHostNode?.parentElement) readerHostNode.parentElement.removeChild(readerHostNode);
  if (tocHostNode?.parentElement) tocHostNode.parentElement.removeChild(tocHostNode);
}

export function teardownCodex(): void {
  teardownReaderNodes();
  navigatorController?.destroy();
  navigatorController = null;
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
