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
 *
 * 답 단추(`.openui-choice`)의 행동은 root 마다 주입한 포트(`OpenUIReplyPort`)로만 건넌다 — 이 패키지는 입력창을 모른다. 포트는 그 root
 * 에 그린 말이 서 있는 표면의 입력창을 채울 뿐 보내지 않는다(발사는 언제나 사람의 Enter 다). 포트를 부르는 길은 root 의 위임 click
 * 하나뿐이고 사람의 클릭(`isTrusted`)만 받는다 — 그리기·다시 그리기·다시 불러오기에는 포트 호출이 없다. 단추는 확정 블록이고 포트가 있는
 * root 에서만 열리며, 흐르는 동안은 `disabled`, 포트가 없는 root(읽기 전용 원장 등)에서는 `aria-disabled` 정적 칩이다.
 * 포트에 닿는 단추는 이 하이드레이터가 렌더러 결과로 들인 단추뿐이다(`drawnChoices`). 말 속 원시 HTML 이 같은 클래스·속성으로 흉내 낸
 * 단추는 DOM 표식이 같아도 그 집합에 없으므로 열리지도 불리지도 않는다 — 보낼 문장도 DOM 속성이 아니라 그 집합에서 읽는다.
 */

import { decodeMermaidSource } from "@fleet-console/markdown/core";

import type { OpenUIRenderer, OpenUIRenderLabels, OpenUIState, OpenUITone } from "./openui-render.js";

export interface OpenUIHydratorLabels extends OpenUIRenderLabels {
  /** 뿌리 문장이 아직 오지 않은 블록의 한 줄 보조 글자. */
  readonly pending: string;
}

export type { OpenUIState, OpenUITone };

/** 답 단추가 고른 문장을 그 표면의 입력창 초안으로 옮긴다. 보내지 않는다. */
export type OpenUIReplyPort = (reply: string) => void;

const BLOCK_SELECTOR = ".openui-block[data-openui-source]";
const OWNED_SELECTOR = ":scope > [data-openui-owned]";
const CHOICE_SELECTOR = "button.openui-choice";

const DEFAULT_LABELS: OpenUIHydratorLabels = {
  pending: "Drawing…",
  states: { todo: "Queued", running: "Running", waiting: "Waiting", done: "Done", blocked: "Blocked" },
  tones: { good: "Good", warn: "Caution", bad: "Problem" },
};

const hydratedRoots = new WeakSet<Node>();
// 포트는 root 마다 따로 둔다 — 한 화면에 그룹 대화와 사령관 칸이 함께 서도 단추가 다른 표면의 입력창으로 새지 않는다.
const replyPorts = new WeakMap<Element, OpenUIReplyPort>();
// 렌더러가 만든 답 단추와 그 문장 — DOM 속성은 위조할 수 있어도 이 집합의 소속은 위조할 수 없다.
const drawnChoices = new WeakMap<HTMLButtonElement, string>();
// 블록마다 마지막으로 시작한 그리기만 반영한다 — 지연 로드 중에 원문이 더 자라도 늦게 끝난 옛 결과가 덮지 않는다.
const generations = new WeakMap<Element, number>();
let labels: OpenUIHydratorLabels = DEFAULT_LABELS;
let rendererLoader: Promise<OpenUIRenderer> | null = null;

export function installOpenUIHydrator(root: Element, nextLabels?: OpenUIHydratorLabels, reply?: OpenUIReplyPort | null): void {
  if (nextLabels) labels = nextLabels;
  // 포트는 설치를 거듭할 때마다 고친다(표면이 입력창을 얻거나 잃는다) — 이미 그린 단추도 새 포트에 맞춰 열고 잠근다.
  const hadPort = replyPorts.has(root);
  if (reply) replyPorts.set(root, reply);
  else replyPorts.delete(root);
  if (hydratedRoots.has(root)) {
    if (hadPort !== !!reply) for (const block of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) syncChoices(block, root);
    return;
  }
  hydratedRoots.add(root);
  root.addEventListener("click", (event) => onChoiceClick(root, event));
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
    for (const button of result.node.querySelectorAll<HTMLButtonElement>(CHOICE_SELECTOR)) {
      const reply = button.getAttribute("data-openui-reply");
      if (reply) drawnChoices.set(button, reply);
    }
    owned(block).replaceChildren(result.node);
    block.setAttribute("data-openui-state", "rendered");
    syncChoices(block);
  } else if (result.kind === "fallback") {
    showFallback(block);
  } else if (block.getAttribute("data-openui-state") !== "rendered") {
    // 흐르는 동안 잠시 그릴 수 없으면 이미 그린 그림을 지킨다. 아직 그린 적이 없을 때만 보조 글자를 둔다.
    showPending(block);
  }
}

/** 이 블록을 그린 root — 단추 상태와 클릭은 가장 가까운 설치 root 의 포트만 본다(바깥 root 가 안쪽 말의 단추를 가로채지 않는다). */
function ownerRoot(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) if (hydratedRoots.has(node)) return node;
  return null;
}

/** 확정 블록이고 root 에 포트가 있을 때만 단추를 연다. 흐르는 중은 잠그고(disabled), 포트가 없으면 정적 칩(aria-disabled)이다. */
function syncChoices(block: HTMLElement, root: Element | null = ownerRoot(block)): void {
  const final = block.getAttribute("data-openui-final") !== "0";
  const port = root ? replyPorts.has(root) : false;
  for (const button of block.querySelectorAll<HTMLButtonElement>(CHOICE_SELECTOR)) {
    if (!drawnChoices.has(button)) continue;
    button.disabled = !final;
    if (final && !port) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  }
}

function onChoiceClick(root: Element, event: Event): void {
  // 사람의 클릭만 — 스크립트가 만든 click(합성 이벤트)은 입력창을 건드리지 못한다.
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>(CHOICE_SELECTOR);
  const reply = button ? drawnChoices.get(button) : undefined;
  if (!button || !reply || ownerRoot(button) !== root || button.disabled || button.getAttribute("aria-disabled") === "true") return;
  const block = button.closest<HTMLElement>(BLOCK_SELECTOR);
  if (!block || block.getAttribute("data-openui-state") !== "rendered" || block.getAttribute("data-openui-final") === "0") return;
  const port = replyPorts.get(root);
  if (reply && port) port(reply);
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
