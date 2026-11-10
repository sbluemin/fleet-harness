import type { DesktopBrowserChromeTab } from "@fleet-console/protocol/desktop";
import type { ChromeUiState } from "../contract.js";
import { agentGlyph, clear, G, glyph, h, hostOf, keyed } from "./dom.js";
import { paintColors, post, shownSpace, spaceHue, spaceName, tabCount, tr, type T } from "./shared.js";

const LEAVE_MS = 160;

/**
 * 세로 탭 레일 문서. 접힘(아이콘 열)·호버 펼침·고정은 이 한 문서가 그린다 — 뷰 폭만 main 이 바꾼다.
 * 레일은 지금 띄운 스페이스 하나의 탭만 그린다. 맨 위 머리가 어느 스페이스인지 말하고, 누르면 스페이스 선택 화면이 열린다.
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
  root.append(pinButton, h("div", { class: "divider", attrs: { role: "separator" } }), spaceHead, scroll);

  let last: ChromeUiState | null = null;
  let hovered = false;
  let keyboard = false;
  let leave: ReturnType<typeof setTimeout> | null = null;
  const tabCache = new Map<string, HTMLElement>();
  let markKey = "";

  const open = (): boolean => last?.pinned === true || hovered || keyboard;
  const syncOpen = (): void => { root.classList.toggle("open", open()); };

  // 호버는 이 문서가 직접 받는다. 펼치면 main 이 뷰 폭을 키우므로 펼친 영역 안에 머무는 포인터는 떠나지 않은 것이다.
  document.documentElement.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch") return;
    if (leave !== null) { clearTimeout(leave); leave = null; }
    if (!hovered) { hovered = true; syncOpen(); post("rail", "expand", { expanded: true }); }
  });
  document.documentElement.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "touch") return;
    if (leave !== null) clearTimeout(leave);
    leave = setTimeout(() => { leave = null; hovered = false; syncOpen(); if (!keyboard) post("rail", "expand", { expanded: false }); }, LEAVE_MS);
  });
  root.addEventListener("focusin", (event) => { if ((event.target as HTMLElement).matches(":focus-visible")) { keyboard = true; syncOpen(); post("rail", "expand", { expanded: true }); } });
  root.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && root.contains(next)) return;
    keyboard = false; syncOpen(); if (!hovered) post("rail", "expand", { expanded: false });
  });

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
    root.classList.toggle("pinned", state.pinned);
    // 조작 중 표시는 지금 보는 스페이스의 것이다(주소줄과 같은 규칙).
    const shownDriving = shownSpace(state)?.driving === true;
    root.classList.toggle("driving", shownDriving);
    root.setAttribute("aria-label", shownDriving ? t("driving") : t("tabs"));
    if (previous?.pinned !== state.pinned) syncOpen();
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
