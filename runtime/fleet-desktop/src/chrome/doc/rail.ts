import type { DesktopBrowserChromeSpace, DesktopBrowserChromeTab } from "@fleet-console/protocol/desktop";
import type { ChromeUiState } from "../contract.js";
import { agentGlyph, clear, G, glyph, h, hostOf, keyed } from "./dom.js";
import { paintColors, post, spaceHue, tr, type T } from "./shared.js";

const LEAVE_MS = 160;
const HUMAN = "human";

/** 세로 탭 레일 문서. 접힘(아이콘 열)·호버 펼침·고정은 이 한 문서가 그린다 — 뷰 폭만 main 이 바꾼다. */
export function mountRail(): (state: ChromeUiState) => void {
  const root = h("div", { class: "rail", attrs: { role: "group" } });
  document.body.append(root);
  const pinButton = h("button", { class: "row rail-pin", type: "button", on: { click: () => post("rail", "pin", { pinned: !last?.pinned }) } });
  const pinLabel = h("span", { class: "label" });
  pinButton.append(h("span", { class: "glyph" }, glyph(G.pin)), pinLabel);
  const scroll = h("div", { class: "scroll" });
  const humanBox = h("div", { class: "tabs human", attrs: { role: "tablist" } });
  const groupsBox = h("div", { class: "groups" });
  const newButton = h("button", { class: "row new", type: "button", on: { click: () => post("rail", "new-tab") } });
  const newLabel = h("span", { class: "label" });
  newButton.append(h("span", { class: "glyph", text: "+" }), newLabel);
  scroll.append(humanBox, groupsBox, newButton);
  root.append(pinButton, h("div", { class: "divider", attrs: { role: "separator" } }), scroll);

  let last: ChromeUiState | null = null;
  let hovered = false;
  let keyboard = false;
  let leave: ReturnType<typeof setTimeout> | null = null;
  const openSpaces = new Set<string>();
  const tabCache = new Map<string, HTMLElement>();
  const groupCache = new Map<string, HTMLElement>();

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

  const spaceName = (t: T, space: DesktopBrowserChromeSpace): string => ((space.kind === "objective" || space.kind === "commodore") && space.label) || t(`space.${space.kind === "human" ? "session" : space.kind}`);

  const render = (state: ChromeUiState): void => {
    const previous = last;
    last = state;
    paintColors(state.colors);
    document.documentElement.lang = state.lang;
    document.documentElement.dataset.platform = state.platform;
    const t = tr(state);
    const chrome = state.chrome;
    root.classList.toggle("pinned", state.pinned);
    root.classList.toggle("driving", chrome?.driving === true);
    root.setAttribute("aria-label", chrome?.driving ? t("driving") : t("tabs"));
    if (previous?.pinned !== state.pinned) syncOpen();
    const pinText = t(state.pinned ? "rail.unpin" : "rail.pin");
    pinButton.title = pinText; pinButton.setAttribute("aria-label", pinText); pinButton.setAttribute("aria-pressed", String(state.pinned));
    pinButton.classList.toggle("set", state.pinned);
    pinLabel.textContent = pinText;
    newLabel.textContent = t("newTab"); newButton.title = t("newTab"); newButton.setAttribute("aria-label", t("newTab"));
    if (!chrome) { humanBox.hidden = true; clear(groupsBox); groupCache.clear(); return; }
    const ready = chrome.available;
    newButton.disabled = !ready || state.busy;
    const agentIds = new Set(chrome.spaces.flatMap((space) => space.agentTabIds));
    const humanTabs = chrome.tabs.filter((tab) => tab.spaceId === HUMAN);
    humanBox.hidden = humanTabs.length === 0;
    humanBox.setAttribute("aria-label", t("tabs"));
    keyed(humanBox, humanTabs, (tab) => tab.id, makeTab, updateTab(t, chrome.activeTabId, agentIds), tabCache);
    // 그룹은 탭이 있거나 에이전트가 쓰는 중인 스페이스만. 프레임이 싣지 않은 스페이스(탭만 아는 것)는 여기서 채운다.
    const grouped = chrome.tabs.filter((tab) => tab.spaceId !== HUMAN);
    const byId = new Map<string, DesktopBrowserChromeSpace>();
    for (const space of chrome.spaces) if (space.id !== HUMAN) byId.set(space.id, space);
    for (const tab of grouped) if (!byId.has(tab.spaceId)) byId.set(tab.spaceId, { id: tab.spaceId, kind: "objective", label: "", driving: false, agentTabIds: [] });
    const displayed = chrome.displayedSpaceId;
    const groups = [...byId.values()]
      .sort((a, b) => Number(b.id === displayed) - Number(a.id === displayed))
      .map((space) => ({ space, tabs: grouped.filter((tab) => tab.spaceId === space.id), open: space.id === displayed || openSpaces.has(space.id) }))
      .filter((group) => group.tabs.length > 0 || group.space.driving);
    keyed(groupsBox, groups, (group) => group.space.id, () => {
      const chip = h("button", { class: "space", type: "button" }, h("span", { class: "space-initial" }), h("span", { class: "space-name" }), h("span", { class: "space-count" }));
      const list = h("div", { class: "tabs", attrs: { role: "tablist" } });
      return h("div", { class: "space-group" }, chip, list);
    }, (element, group) => {
      const { space } = group;
      const name = spaceName(t, space);
      element.dataset.spaceId = space.id;
      element.dataset.kind = space.kind;
      element.style.setProperty("--space-hue", String(spaceHue(space.id)));
      element.classList.toggle("open", group.open);
      const chip = element.querySelector(".space") as HTMLButtonElement;
      const count = String(group.tabs.length);
      const tip = `${t("space.chip", { name, count })}${space.driving ? ` · ${t("space.driving")}` : ""}`;
      chip.title = tip; chip.setAttribute("aria-label", tip); chip.setAttribute("aria-expanded", String(group.open));
      chip.disabled = !ready;
      chip.classList.toggle("open", group.open);
      chip.onclick = () => {
        if (group.open) { openSpaces.delete(space.id); if (displayed === space.id) post("rail", "select-space", { id: "human" }); }
        else { openSpaces.add(space.id); post("rail", "select-space", { id: space.id }); }
        if (last) rerender();
      };
      (chip.querySelector(".space-initial") as HTMLElement).textContent = Array.from(name)[0] ?? "";
      (chip.querySelector(".space-name") as HTMLElement).textContent = name;
      const counter = chip.querySelector(".space-count") as HTMLElement;
      counter.textContent = count; counter.hidden = group.open;
      const list = element.querySelector(".tabs") as HTMLElement;
      list.hidden = !(group.open && group.tabs.length > 0);
      list.setAttribute("aria-label", `${name} — ${t("tabs")}`);
      const cache = (element as HTMLElement & { tabCache?: Map<string, HTMLElement> }).tabCache ?? ((element as HTMLElement & { tabCache?: Map<string, HTMLElement> }).tabCache = new Map());
      keyed(list, group.open ? group.tabs : [], (tab) => tab.id, makeTab, updateTab(t, chrome.activeTabId, new Set(space.agentTabIds)), cache);
    }, groupCache);
  };

  function rerender(): void { if (last) render(last); }
  return render;
}
