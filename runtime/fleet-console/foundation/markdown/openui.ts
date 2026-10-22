/**
 * OpenUI 하이드레이터 — `renderMarkdown({ openui: true })`가 남긴 `.openui-block` 자리표시자를 그린다.
 *
 * 자리표시자 안에는 평소의 코드 블록(`pre.code-block`)이 그대로 있고, 하이드레이터는 그 옆(블록의 마지막 자식)에 자기 소유
 * 칸(`[data-openui-owned]`)을 만들어 그림을 둔다. 원문이 자라면(`data-openui-source`) 그 칸만 다시 그리고, 확정
 * (`data-openui-final="1"`) 때 그릴 수 없으면 소유 칸을 걷어 코드 블록이 폴백이 된다. 상태는 `data-openui-state`
 * (`pending` → `rendered` | `fallback`)에 적고, CSS가 그 상태로 코드 블록을 숨기거나 보인다.
 *
 * 렌더러(파서 + 화이트리스트 DOM 빌더)는 블록을 처음 만날 때만 지연 로드한다. 모듈 상태(로더·root 표식)는 이 모듈을
 * 불러온 번들 안에서만 쓰인다 — 다른 번들과 조율하지 않는다.
 */

import { decodeMermaidSource } from "@fleet-console/markdown/core";

import type { OpenUIRenderer, OpenUIRenderLabels, OpenUIState, OpenUITone } from "./openui-render.js";

export interface OpenUIHydratorLabels extends OpenUIRenderLabels {
  /** 뿌리 문장이 아직 오지 않은 블록의 한 줄 보조 글자. */
  readonly pending: string;
}

export type { OpenUIState, OpenUITone };

const BLOCK_SELECTOR = ".openui-block[data-openui-source]";
const OWNED_SELECTOR = ":scope > [data-openui-owned]";

const DEFAULT_LABELS: OpenUIHydratorLabels = {
  pending: "Drawing…",
  states: { todo: "Queued", running: "Running", waiting: "Waiting", done: "Done", blocked: "Blocked" },
  tones: { good: "Good", warn: "Caution", bad: "Problem" },
};

const hydratedRoots = new WeakSet<Node>();
// 블록마다 마지막으로 시작한 그리기만 반영한다 — 지연 로드 중에 원문이 더 자라도 늦게 끝난 옛 결과가 덮지 않는다.
const generations = new WeakMap<Element, number>();
let labels: OpenUIHydratorLabels = DEFAULT_LABELS;
let rendererLoader: Promise<OpenUIRenderer> | null = null;

export function installOpenUIHydrator(root: Element, nextLabels?: OpenUIHydratorLabels): void {
  if (nextLabels) labels = nextLabels;
  if (hydratedRoots.has(root)) return;
  hydratedRoots.add(root);
  for (const block of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) void hydrate(block);
  new MutationObserver((mutations) => {
    const blocks = new Set<HTMLElement>();
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        if (mutation.target instanceof HTMLElement && mutation.target.matches(BLOCK_SELECTOR)) blocks.add(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(BLOCK_SELECTOR)) blocks.add(node);
        for (const block of node.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) blocks.add(block);
      }
    }
    for (const block of blocks) if (block.isConnected) void hydrate(block);
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-openui-source", "data-openui-final"] });
}

function loadRenderer(): Promise<OpenUIRenderer> {
  rendererLoader ??= import("./openui-render.js")
    .then((module) => module.createOpenUIRenderer())
    .catch((error: unknown) => { rendererLoader = null; throw error; });
  return rendererLoader;
}

async function hydrate(block: HTMLElement): Promise<void> {
  const generation = (generations.get(block) ?? 0) + 1;
  generations.set(block, generation);
  const final = block.getAttribute("data-openui-final") !== "0";
  let source: string;
  try { source = decodeMermaidSource(block.getAttribute("data-openui-source") ?? ""); } catch { source = ""; }
  if (!block.hasAttribute("data-openui-state")) showPending(block);
  let renderer: OpenUIRenderer;
  try { renderer = await loadRenderer(); }
  catch {
    if (generations.get(block) === generation && final) showFallback(block);
    return;
  }
  if (generations.get(block) !== generation || !block.isConnected) return;
  const result = source.trim() ? renderer.render(block.ownerDocument, source, final, labels) : { kind: final ? "fallback" : "pending" } as const;
  if (result.kind === "tree") {
    owned(block).replaceChildren(result.node);
    block.setAttribute("data-openui-state", "rendered");
  } else if (result.kind === "fallback") {
    showFallback(block);
  } else if (block.getAttribute("data-openui-state") !== "rendered") {
    // 흐르는 동안 잠시 그릴 수 없으면 이미 그린 그림을 지킨다. 아직 그린 적이 없을 때만 보조 글자를 둔다.
    showPending(block);
  }
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

function showPending(block: HTMLElement): void {
  const caption = block.ownerDocument.createElement("p");
  caption.className = "openui-pending";
  caption.textContent = labels.pending;
  owned(block).replaceChildren(caption);
  block.setAttribute("data-openui-state", "pending");
}

function showFallback(block: HTMLElement): void {
  block.querySelector(OWNED_SELECTOR)?.remove();
  block.setAttribute("data-openui-state", "fallback");
}
