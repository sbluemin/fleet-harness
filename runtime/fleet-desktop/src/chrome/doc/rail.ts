import type { DesktopBrowserChromeTab } from "@fleet-console/protocol/desktop";
import type { ChromeUiState } from "../contract.js";
import { agentGlyph, clear, G, glyph, h, hostOf, keyed } from "./dom.js";
import { paintColors, post, shownSpace, spaceHue, spaceName, tabCount, tr, type T } from "./shared.js";

const LEAVE_MS = 160;
/** 접힘 전환이 끝났다고 보는 여유 — 전환 시간 뒤 이만큼 더 기다렸다가 main 에 뷰 폭을 줄여 달라고 한다. */
const SETTLE_MS = 30;

/**
 * 탭 표시줄 문서. 세로 레일(접힘·호버 펼침·고정)과 가로 표시줄(주소줄 위 한 줄)을 이 한 문서가 그린다 — 뷰의 자리와 크기만 main 이 바꾼다.
 * 표시줄은 지금 띄운 스페이스 하나의 탭만 그린다. 머리가 어느 스페이스인지 말하고, 누르면 스페이스 선택 화면이 열린다.
 * 세로 레일의 폭은 CSS 전환으로 이어져 변한다: 펼칠 때는 main 이 뷰를 먼저 넓히고, 접을 때는 전환이 끝난 뒤에 뷰를 줄여 달라고 한다.
 */
export function mountRail(): (state: ChromeUiState) => void {
  const root = h("div", { class: "rail", attrs: { role: "group" } });
  document.body.append(root);
  const pinButton = h("button", { class: "row rail-pin", type: "button", on: { click: () => post("rail", "pin", { pinned: !last?.pinned }) } });
  const pinLabel = h("span", { class: "label" });
  pinButton.append(h("span", { class: "glyph" }, glyph(G.pin)), pinLabel);
  // 스페이스 머리 — 접힌 레일에서는 표식(글리프·머리글자) 하나, 펼치면 이름과 탭 수가 붙는다.
  const spaceMark = h("span", { class: "space-mark" });
  const spaceLabel = h("span", { class: "label space-name" });
  const spaceTabs = h("span", { class: "space-count" });
  const spaceHead = h("button", { class: "row space-head", type: "button", attrs: { "aria-haspopup": "dialog" }, on: { click: () => post("rail", "overlay", { kind: last?.overlay?.kind === "spaces" ? null : "spaces" }) } }, spaceMark, spaceLabel, spaceTabs);
  const scroll = h("div", { class: "scroll" });
  const tabsBox = h("div", { class: "tabs", attrs: { role: "tablist" } });
  const newButton = h("button", { class: "row new", type: "button", on: { click: () => post("rail", "new-tab") } });
  // Chrome 의 새 탭 단추처럼 글자 없이 가운데 「+」 하나 — 「새 탭」은 접근성 이름(aria-label·title)으로 남는다.
  newButton.append(h("span", { class: "glyph", text: "+" }));
  scroll.append(tabsBox, newButton);
  // 가로 표시줄이 맨 위 줄일 때 신호등·캡션 버튼 자리를 비우는 여백 — 세로 레일에서는 자리를 차지하지 않는다.
  const leading = h("span", { class: "pad" });
  const trailing = h("span", { class: "pad" });
  root.append(leading, pinButton, h("div", { class: "divider", attrs: { role: "separator" } }), spaceHead, scroll, trailing);

  let last: ChromeUiState | null = null;
  let hovered = false;
  let keyboard = false;
  let leave: ReturnType<typeof setTimeout> | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  const tabCache = new Map<string, HTMLElement>();
  let markKey = "";

  const horizontal = (): boolean => last?.orientation === "horizontal";
  const open = (): boolean => !horizontal() && (last?.pinned === true || hovered || keyboard);
  const syncOpen = (): void => { root.classList.toggle("open", open()); };
  /** 폭 전환이 도는 시간(ms). 동작 줄이기에서는 0 이다 — CSS 가 정한 값을 그대로 읽는다. */
  const widthMotionMs = (): number => {
    const first = getComputedStyle(root).transitionDuration.split(",")[0]?.trim() ?? "";
    const value = Number.parseFloat(first);
    return Number.isFinite(value) ? value * (first.endsWith("ms") ? 1 : 1000) : 0;
  };
  const expand = (): void => {
    if (settle !== null) { clearTimeout(settle); settle = null; }
    syncOpen();
    post("rail", "expand", { expanded: true });
  };
  /** 접는다 — 클래스를 먼저 내려 폭이 줄어드는 것을 보이고, 전환이 끝난 뒤에 main 이 뷰를 줄인다(먼저 줄이면 접히는 모습이 잘린다). */
  const collapse = (): void => {
    syncOpen();
    if (settle !== null) clearTimeout(settle);
    const done = (): void => { settle = null; if (!open()) post("rail", "expand", { expanded: false }); };
    const ms = widthMotionMs();
    if (ms <= 0) done(); else settle = setTimeout(done, ms + SETTLE_MS);
  };

  // 호버는 표시줄 몸이 직접 받는다. 펼치면 main 이 뷰 폭을 키우므로 펼친 영역 안에 머무는 포인터는 떠나지 않은 것이고,
  // 접히는 동안 뷰의 빈 자리(이미 줄어든 몸 바깥)를 지나는 포인터는 다시 펼치지 않는다.
  root.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch" || horizontal() || last?.autoExpand === false) return;
    if (leave !== null) { clearTimeout(leave); leave = null; }
    if (!hovered) { hovered = true; expand(); }
  });
  root.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "touch" || !hovered) return;
    if (leave !== null) clearTimeout(leave);
    leave = setTimeout(() => { leave = null; hovered = false; if (!keyboard) collapse(); }, LEAVE_MS);
  });
  root.addEventListener("focusin", (event) => { if (!horizontal() && (event.target as HTMLElement).matches(":focus-visible")) { keyboard = true; expand(); } });
  root.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && root.contains(next)) return;
    if (!keyboard) return;
    keyboard = false; if (!hovered) collapse();
  });
  // 표시줄 어디서든 우클릭하면 표시줄 메뉴가 뜬다 — 메뉴는 주소줄 문서가 그리므로 자리만 알린다.
  document.addEventListener("contextmenu", (event) => { event.preventDefault(); post("rail", "tabs-menu", { x: event.clientX, y: event.clientY }); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && last?.overlay?.kind === "tabs-menu") post("rail", "overlay", { kind: null }); });
  // 가로 표시줄은 주소줄 뷰 위에 있어 메뉴의 바깥 누름이 여기로 온다 — 다른 곳을 누르면 메뉴를 닫는다.
  document.addEventListener("pointerdown", (event) => { if (event.button !== 2 && last?.overlay?.kind === "tabs-menu") post("rail", "overlay", { kind: null }); });
  // 가로 표시줄은 세로 휠로도 옆으로 넘긴다.
  scroll.addEventListener("wheel", (event) => { if (horizontal() && event.deltaX === 0 && event.deltaY !== 0) { scroll.scrollLeft += event.deltaY; event.preventDefault(); } }, { passive: false });

  const makeTab = (): HTMLElement => {
    const icon = h("span", { class: "tab-icon" });
    const title = h("span", { class: "tab-title" });
    const agent = h("span", { class: "tab-agent", attrs: { role: "img" } }, agentGlyph());
    const close = h("button", { class: "tab-close", type: "button", text: "×" });
    const tab = h("div", { class: "tab", role: "tab", tabindex: 0 }, icon, title, agent, close);
    tab.addEventListener("mousedown", (event) => { if (event.button === 1) { event.preventDefault(); post("rail", "close-tab", { id: tab.dataset.id }); } });
    tab.addEventListener("click", () => { if (tab.getAttribute("aria-selected") !== "true") post("rail", "select-tab", { id: tab.dataset.id }); });
    tab.addEventListener("keydown", (event) => { if (event.target === tab && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); tab.click(); } });
    close.addEventListener("click", (event) => { event.stopPropagation(); post("rail", "close-tab", { id: tab.dataset.id }); });
    return tab;
  };
  const updateTab = (t: T, active: string | null, agentIds: ReadonlySet<string>) => (element: HTMLElement, tab: DesktopBrowserChromeTab): void => {
    const title = tab.title || hostOf(tab.url) || t("newTab");
    const isActive = tab.id === active;
    const agent = agentIds.has(tab.id);
    element.dataset.id = tab.id;
    element.setAttribute("aria-selected", String(isActive));
    element.setAttribute("aria-label", title);
    element.title = agent ? `${title} — ${tab.url} · ${t("space.agentTab")}` : `${title} — ${tab.url}`;
    element.classList.toggle("active", isActive);
    element.classList.toggle("loading", tab.loading);
    (element.querySelector(".tab-title") as HTMLElement).textContent = title;
    const iconBox = element.querySelector(".tab-icon") as HTMLElement;
    const favicon = tab.favicon;
    if (iconBox.dataset.favicon !== (favicon ?? "")) {
      iconBox.dataset.favicon = favicon ?? "";
      clear(iconBox);
      if (favicon) {
        const image = h("img", { src: favicon, alt: "", draggable: false });
        image.addEventListener("error", () => { clear(iconBox); iconBox.append(glyph(G.globe)); });
        iconBox.append(image);
      } else iconBox.append(glyph(G.globe));
    }
    element.classList.toggle("is-agent", agent);
    (element.querySelector(".tab-agent") as HTMLElement).hidden = !agent;
    (element.querySelector(".tab-agent") as HTMLElement).setAttribute("aria-label", t("space.agentTab"));
    (element.querySelector(".tab-close") as HTMLElement).setAttribute("aria-label", t("closeTab"));
  };

  const render = (state: ChromeUiState): void => {
    const previous = last;
    last = state;
    paintColors(state.colors);
    document.documentElement.lang = state.lang;
    document.documentElement.dataset.platform = state.platform;
    const t = tr(state);
    const chrome = state.chrome;
    const flat = state.orientation === "horizontal";
    document.documentElement.dataset.orientation = state.orientation;
    root.classList.toggle("horizontal", flat);
    root.classList.toggle("pinned", state.pinned && !flat);
    tabsBox.setAttribute("aria-orientation", state.orientation);
    leading.style.width = `${flat ? state.leading : 0}px`; trailing.style.width = `${flat ? state.trailing : 0}px`;
    if (flat && (hovered || keyboard)) { hovered = false; keyboard = false; }
    // 조작 중 표시는 지금 보는 스페이스의 것이다(주소줄과 같은 규칙).
    const shownDriving = shownSpace(state)?.driving === true;
    root.classList.toggle("driving", shownDriving);
    root.setAttribute("aria-label", shownDriving ? t("driving") : t("tabs"));
    // 고정을 풀면(메뉴의 「탭 접기」) 포인터가 레일 밖에 있으니 접히는 것을 보인 뒤에 뷰를 줄인다 — main 은 그동안 뷰를 펼친 폭으로 둔다.
    if (previous?.orientation !== state.orientation || previous?.pinned !== state.pinned) { if (previous?.pinned === true && !state.pinned && !flat && !hovered && !keyboard) collapse(); else syncOpen(); }
    if (previous && previous.autoExpand !== state.autoExpand && !state.autoExpand && hovered) { hovered = false; if (!keyboard) collapse(); }
    const pinText = t(state.pinned ? "rail.unpin" : "rail.pin");
    pinButton.title = pinText; pinButton.setAttribute("aria-label", pinText); pinButton.setAttribute("aria-pressed", String(state.pinned));
    pinButton.classList.toggle("set", state.pinned);
    pinLabel.textContent = pinText;
    newButton.title = t("newTab"); newButton.setAttribute("aria-label", t("newTab"));
    // 스페이스 머리 — 스냅샷이 오기 전에도 자리를 지킨다(디폴트로 그린다).
    const space = shownSpace(state);
    const name = spaceName(t, space);
    const tabs = chrome ? chrome.tabs.filter((tab) => tab.spaceId === state.spaceId) : [];
    const key = `${space?.kind ?? "default"}:${name}`;
    if (key !== markKey) {
      markKey = key;
      clear(spaceMark);
      if (space?.kind === "commodore") spaceMark.append(h("span", { class: "space-initial", text: Array.from(name)[0] ?? "" }));
      else spaceMark.append(glyph(G.home));
    }
    spaceHead.dataset.kind = space?.kind ?? "default";
    spaceHead.style.setProperty("--space-hue", String(spaceHue(state.spaceId)));
    spaceHead.classList.toggle("driving", space?.driving === true);
    spaceHead.classList.toggle("open", state.overlay?.kind === "spaces");
    const headTip = `${t("spaces.head", { name })} · ${tabCount(t, tabs.length)}${space?.driving ? ` · ${t("space.driving")}` : ""}`;
    spaceHead.title = state.overlay?.kind === "spaces" ? "" : headTip; spaceHead.setAttribute("aria-label", headTip);
    spaceHead.setAttribute("aria-expanded", String(state.overlay?.kind === "spaces"));
    spaceLabel.textContent = name;
    spaceTabs.textContent = String(tabs.length);
    spaceTabs.hidden = tabs.length === 0;
    if (!chrome) { tabsBox.hidden = true; return; }
    const ready = chrome.available;
    newButton.disabled = !ready || state.busy;
    spaceHead.disabled = !ready;
    tabsBox.hidden = tabs.length === 0;
    tabsBox.setAttribute("aria-label", `${name} — ${t("tabs")}`);
    keyed(tabsBox, tabs, (tab) => tab.id, makeTab, updateTab(t, chrome.activeTabId, new Set(space?.agentTabIds ?? [])), tabCache);
  };

  return render;
}
