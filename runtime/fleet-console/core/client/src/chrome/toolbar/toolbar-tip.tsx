import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * 도구모음 말풍선 — 도구모음의 모든 칸이 쓰는 한 장. 칸마다 말풍선을 들지 않고 도구모음 루트가 겨눔·포커스를
 * 위임받아, 겨눈 칸의 이름을 한 장의 말풍선에 싣는다. 그래서 접기·레일 도구·설정·찾기·원격·도움말·Zen과
 * 플러그인이 둔 항목(부관 글리프)이 같은 모양·같은 지연·같은 모션으로 말한다.
 *
 * - 이름은 `data-tip` → (칸이 든 네이티브 title) → aria-label 순으로 읽는다. 네이티브 title은 도구모음이
 *   보는 즉시 걷어 보관한다 — 남겨 두면 브라우저 말풍선이 한 번 더 뜬다. 플러그인은 코드를 고치지 않아도
 *   title이나 aria-label만으로 이 말풍선을 입는다.
 * - 상단 바에서는 아래로, Zen 트레이(화면 아래 끝)에서는 위로 뜬다. 칸 가운데에 서되 뷰포트 끝에서는
 *   안으로 밀려 들어오고, 꼬리는 칸을 계속 가리킨다.
 * - 메뉴가 열린 칸(aria-expanded="true")과 누른 직후의 칸은 말하지 않는다 — 누른 칸은 포인터가 떠날 때까지.
 * - 칸 안의 메뉴·대화상자(도움말 메뉴, 원격 패널)는 대상이 아니다.
 */

const SHOW_DELAY_MS = 180;
/** 이웃 칸으로 건너가는 사이의 틈 — 이 안에 다음 칸을 겨누면 지연 없이 바로 옮겨 말한다. */
const HANDOFF_GRACE_MS = 300;
const TIP_GAP = 10;
const VIEWPORT_MARGIN = 8;
const ARROW_INSET = 12;

const ITEM_SELECTOR = ".console-toolbar-fold, .console-toolbar-zen, .right-rail-ico, .command-band-button, .console-toolbar-plugins button";
const POPUP_SELECTOR = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';
const STASHED_TITLE = "data-toolbar-tip-title";

type Placement = "below" | "above";

interface TipState {
  readonly target: HTMLElement;
  readonly text: string;
  readonly placement: Placement;
}

function toolbarItemOf(node: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const item = node.closest<HTMLElement>(ITEM_SELECTOR);
  if (item === null || !root.contains(item)) return null;
  if (item.getAttribute("role")?.startsWith("menuitem")) return null;
  const popup = item.closest(POPUP_SELECTOR);
  if (popup !== null && root.contains(popup)) return null;
  return item;
}

/** 칸의 네이티브 title을 걷어 보관한다 — 말풍선은 한 장이어야 한다. */
function stashTitle(element: Element, root: HTMLElement): void {
  if (!(element instanceof HTMLElement) || !element.hasAttribute("title")) return;
  if (toolbarItemOf(element, root) !== element) return;
  element.setAttribute(STASHED_TITLE, element.getAttribute("title") ?? "");
  element.removeAttribute("title");
}

function tipTextOf(item: HTMLElement): string {
  return item.dataset.tip || item.getAttribute(STASHED_TITLE) || item.getAttribute("aria-label") || "";
}

export function ToolbarTipLayer({ rootRef }: { readonly rootRef: RefObject<HTMLElement | null> }) {
  const tipId = useId();
  const tipRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;

    // 네이티브 title은 보이는 즉시 걷는다 — 겨누는 순간에 걷으면 브라우저가 이미 말풍선을 예약했을 수 있다.
    for (const element of root.querySelectorAll("[title]")) stashTitle(element, root);
    const titleObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") stashTitle(record.target as Element, root);
        else for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          stashTitle(node, root);
          for (const element of node.querySelectorAll("[title]")) stashTitle(element, root);
        }
      }
    });
    titleObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

    let showTimer: number | null = null;
    let hovered: HTMLElement | null = null;
    let suppressed: HTMLElement | null = null;
    let shownFor: HTMLElement | null = null;
    let hiddenAt = 0;
    let describedBy: HTMLElement | null = null;
    let targetObserver: MutationObserver | null = null;

    const clearTimer = () => {
      if (showTimer === null) return;
      window.clearTimeout(showTimer);
      showTimer = null;
    };
    const releaseTarget = () => {
      targetObserver?.disconnect();
      targetObserver = null;
      describedBy?.removeAttribute("aria-describedby");
      describedBy = null;
    };
    const hide = () => {
      clearTimer();
      if (shownFor !== null) hiddenAt = performance.now();
      shownFor = null;
      releaseTarget();
      setVisible(false);
    };
    const show = (item: HTMLElement) => {
      const text = tipTextOf(item);
      if (text === "" || item.getAttribute("aria-expanded") === "true" || !item.isConnected || item.getClientRects().length === 0) {
        hide();
        return;
      }
      releaseTarget();
      shownFor = item;
      // 접근 이름과 다른 말(단축키·Console Use 안내)을 할 때만 설명으로 잇는다. 같은 말을 두 번 읽히지 않게.
      if (text !== item.getAttribute("aria-label") && !item.hasAttribute("aria-describedby")) {
        item.setAttribute("aria-describedby", tipId);
        describedBy = item;
      }
      // 칸의 이름이 바뀌면(업데이트 표식·원격 이름) 말풍선도 따라 바뀌고, 메뉴가 열리면 물러난다.
      targetObserver = new MutationObserver(() => {
        if (shownFor !== item) return;
        if (item.getAttribute("aria-expanded") === "true" || !item.isConnected) { hide(); return; }
        setTip((current) => current?.target === item ? { ...current, text: tipTextOf(item) } : current);
      });
      targetObserver.observe(item, { attributes: true, attributeFilter: ["data-tip", STASHED_TITLE, "aria-label", "aria-expanded"] });
      setTip({ target: item, text, placement: item.closest(".zen-bar") !== null ? "above" : "below" });
      setVisible(true);
    };
    const request = (item: HTMLElement) => {
      clearTimer();
      if (item === suppressed) return;
      if (shownFor !== null || performance.now() - hiddenAt < HANDOFF_GRACE_MS) { show(item); return; }
      showTimer = window.setTimeout(() => {
        showTimer = null;
        show(item);
      }, SHOW_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const item = toolbarItemOf(event.target, root);
      if (item === hovered) return;
      hovered = item;
      if (suppressed !== null && suppressed !== item) suppressed = null;
      if (item === null) { hide(); return; }
      request(item);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (toolbarItemOf(event.relatedTarget, root) !== null) return;
      hovered = null;
      suppressed = null;
      hide();
    };
    // 도구모음이 자리를 옮기면(Zen 켜기·끄기) 포인터 밑의 칸이 통째로 사라져 pointerout이 오지 않는다 —
    // 도구모음 밖을 겨누는 순간 기억한 칸과 누른 칸을 잊는다. 잊지 않으면 새 자리의 같은 칸이 말하지 않는다.
    const onWindowPointerOver = (event: PointerEvent) => {
      if (event.target instanceof Node && root.contains(event.target)) return;
      if (hovered === null && suppressed === null && shownFor === null && showTimer === null) return;
      hovered = null;
      suppressed = null;
      hide();
    };
    const onPointerDown = (event: PointerEvent) => {
      suppressed = toolbarItemOf(event.target, root);
      hiddenAt = 0;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const item = toolbarItemOf(event.target, root);
      if (item === null || !item.matches(":focus-visible")) return;
      request(item);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (shownFor === null && showTimer === null) return;
      if (hovered !== null && hovered === shownFor) return;
      if (toolbarItemOf(event.relatedTarget, root) === null) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || shownFor === null) return;
      suppressed = shownFor;
      hide();
    };
    const onViewportChange = () => { if (shownFor !== null || showTimer !== null) hide(); };

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerout", onPointerOut);
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    root.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerover", onWindowPointerOver, true);
    window.addEventListener("blur", onViewportChange);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      titleObserver.disconnect();
      clearTimer();
      releaseTarget();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerover", onWindowPointerOver, true);
      window.removeEventListener("blur", onViewportChange);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [rootRef, tipId]);

  // 자리는 실측으로 정한다 — 말풍선의 폭은 말에 따라 달라진다.
  useLayoutEffect(() => {
    const element = tipRef.current;
    if (element === null || tip === null || !visible) return;
    const rect = tip.target.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const center = rect.left + rect.width / 2;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(center - width / 2, window.innerWidth - width - VIEWPORT_MARGIN));
    const top = tip.placement === "below" ? rect.bottom + TIP_GAP : rect.top - TIP_GAP - height;
    const arrow = Math.max(ARROW_INSET, Math.min(center - left, width - ARROW_INSET));
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.setProperty("--toolbar-tip-arrow-x", `${Math.round(arrow)}px`);
  }, [tip, visible]);

  return createPortal(
    <span
      ref={tipRef}
      id={tipId}
      className={`console-toolbar-tip${visible ? " is-visible" : ""}`}
      data-placement={tip?.placement ?? "below"}
      role="tooltip"
      aria-hidden={!visible || undefined}
    >
      {tip?.text}
    </span>,
    document.body,
  );
}
