/**
 * OpenUI 하이드레이터 — 정제된 자리표시자 옆의 소유 칸에 블록별 React 루트를 둔다.
 * 원문·확정 여부가 바뀌면 같은 루트를 갱신하고, 폴백·블록 제거·호스트 해제 때 루트를 걷는다.
 * 렌더러는 처음 블록을 만날 때 지연 로드한다. 모듈 상태는 이 번들 안에서만 쓰며 다른 번들과 조율하지 않는다.
 * 답장 포트는 설치 root마다 주입하고 React 컴포넌트의 클릭 클로저로만 건넨다. DOM 속성은 행동의 권한이 아니다.
 */

import { decodeMermaidSource } from "@fleet-console/markdown/core";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { OpenUIRenderLabels, OpenUIState, OpenUITone } from "./openui-library.js";

export interface OpenUIHydratorLabels extends OpenUIRenderLabels {
  /** 뿌리 문장이 아직 오지 않은 블록의 한 줄 보조 글자. */
  readonly pending: string;
}

export type { OpenUIState, OpenUITone };

/** 답 단추가 고른 문장을 그 표면의 입력창 초안으로 옮긴다. 보내지 않는다. */
export type OpenUIReplyPort = (reply: string) => void;

type Library = typeof import("./openui-library.js");
interface Mounted {
  readonly root: Root;
  readonly view: HTMLElement;
  source: string;
  final: boolean;
}
interface Installation {
  configure(labels: OpenUIHydratorLabels, reply: OpenUIReplyPort | null): void;
  dispose(): void;
}

const BLOCK_SELECTOR = ".openui-block[data-openui-source]";
const OWNED_SELECTOR = ":scope > [data-openui-owned]";
const DEFAULT_LABELS: OpenUIHydratorLabels = {
  pending: "Drawing…",
  states: { todo: "Queued", running: "Running", waiting: "Waiting", done: "Done", blocked: "Blocked" },
  tones: { good: "Good", warn: "Caution", bad: "Problem" },
};

const installations = new WeakMap<Element, Installation>();
const roots = new WeakMap<HTMLElement, Mounted>();
let libraryLoader: Promise<Library> | null = null;

function loadLibrary(): Promise<Library> {
  libraryLoader ??= import("./openui-library.js").catch((error: unknown) => { libraryLoader = null; throw error; });
  return libraryLoader;
}

/** 같은 root에 다시 설치하면 라벨·포트만 갱신해 단추 노드와 초점을 지킨다. */
export function installOpenUIHydrator(root: Element, nextLabels?: OpenUIHydratorLabels, reply?: OpenUIReplyPort | null): void {
  const existing = installations.get(root);
  if (existing) {
    existing.configure(nextLabels ?? DEFAULT_LABELS, reply ?? null);
    return;
  }
  let labels = nextLabels ?? DEFAULT_LABELS;
  let port = reply ?? null;
  let disposed = false;
  const generations = new WeakMap<HTMLElement, number>();
  // 제거된 블록도 찾을 수 있도록 설치마다 소유 블록을 추적한다. 전역 맵은 약한 참조만 갖는다.
  const mine = new Set<HTMLElement>();

  const release = (block: HTMLElement) => {
    const mounted = roots.get(block);
    if (!mounted) return;
    roots.delete(block);
    mine.delete(block);
    // StrictMode 해제→재설치가 같은 컨테이너에 createRoot를 두 번 걸지 않도록 소유 칸은 즉시 뗀다.
    mounted.view.remove();
    if (block.getAttribute("data-openui-state") === "rendered") block.removeAttribute("data-openui-state");
    // 바깥 React 루트의 커밋 중일 수 있으므로 실제 unmount는 다음 마이크로태스크에 한다.
    queueMicrotask(() => mounted.root.unmount());
  };
  const paint = (mounted: Mounted, library: Library) => {
    mounted.root.render(createElement(library.OpenUIView, { source: mounted.source, final: mounted.final, labels, reply: port }));
  };
  const fallback = (block: HTMLElement) => {
    release(block);
    block.querySelector(OWNED_SELECTOR)?.remove();
    block.setAttribute("data-openui-state", "fallback");
  };
  async function hydrate(block: HTMLElement): Promise<void> {
    const generation = (generations.get(block) ?? 0) + 1;
    generations.set(block, generation);
    const final = block.getAttribute("data-openui-final") !== "0";
    let source: string;
    try { source = decodeMermaidSource(block.getAttribute("data-openui-source") ?? ""); } catch { source = ""; }
    if (!block.hasAttribute("data-openui-state")) showPending(block, labels);
    let library: Library;
    try { library = await loadLibrary(); }
    catch {
      if (!disposed && generations.get(block) === generation && final) fallback(block);
      return;
    }
    if (disposed || generations.get(block) !== generation || !root.contains(block) || !block.isConnected) return;
    const verdict = library.judge(source, final);
    if (verdict.kind === "fallback") return fallback(block);
    if (verdict.kind === "hold") return; // 지난 그림(또는 보조 글자)을 지킨다.
    const mounted = roots.get(block);
    if (!mounted) {
      const view = owned(block);
      view.replaceChildren();
      const created: Mounted = { root: createRoot(view, { identifierPrefix: "openui-" }), view, source, final };
      roots.set(block, created);
      mine.add(block);
      // await loadLibrary() 뒤라 설치 effect·옵저버의 호출 스택(React 커밋 포함)을 이미 벗어났다.
      // 첫 그림은 브라우저가 빈 칸을 그리기 전에 커밋하고, 그 뒤에만 rendered 표식을 세운다.
      flushSync(() => paint(created, library));
    } else {
      mounted.source = source;
      mounted.final = final;
      // 살아 있는 루트는 이전 DOM이 남아 있으므로 흐르는 중 갱신을 동기로 강제하지 않는다.
      paint(mounted, library);
    }
    block.setAttribute("data-openui-state", "rendered");
  }

  const observer = new MutationObserver((mutations) => {
    const touched = new Set<HTMLElement>();
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        if (mutation.target instanceof HTMLElement && mutation.target.matches(BLOCK_SELECTOR)) touched.add(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(BLOCK_SELECTOR)) touched.add(node);
        for (const block of node.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) touched.add(block);
      }
    }
    for (const block of mine) if (!root.contains(block) || !block.isConnected) release(block);
    for (const block of touched) if (root.contains(block) && block.isConnected) void hydrate(block);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-openui-source", "data-openui-final"] });
  installations.set(root, {
    configure(next, reply) {
      labels = next;
      port = reply;
      if (!mine.size) return;
      void loadLibrary().then((library) => {
        if (disposed) return;
        for (const block of mine) {
          const mounted = roots.get(block);
          if (mounted) paint(mounted, library);
        }
      });
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      for (const block of mine) release(block);
    },
  });
  for (const block of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) void hydrate(block);
}

/** 호스트 언마운트·OpenUI 비활성화 때 옵저버와 모든 블록 루트를 해제한다. */
export function releaseOpenUIHydrator(root: Element): void {
  installations.get(root)?.dispose();
  installations.delete(root);
}

function owned(block: HTMLElement): HTMLElement {
  const existing = block.querySelector<HTMLElement>(OWNED_SELECTOR);
  if (existing) return existing;
  const view = block.ownerDocument.createElement("div");
  view.className = "openui-view";
  view.setAttribute("data-openui-owned", "");
  block.append(view);
  return view;
}

function showPending(block: HTMLElement, labels: OpenUIHydratorLabels): void {
  const caption = block.ownerDocument.createElement("p");
  caption.className = "openui-pending";
  caption.textContent = labels.pending;
  owned(block).replaceChildren(caption);
  block.setAttribute("data-openui-state", "pending");
}
