import type { ChromeImportSources, ChromeOverlay, ChromeSuggestion, ChromeUiState } from "../contract.js";
import { mountAnnotate, type Annotator } from "./annotate.js";
import { agentGlyph, clear, G, glyph, h, hostOf, moreGlyph } from "./dom.js";
import { paintColors, post, shownSpace, spaceHue, spaceName, tabCount, tr, type T } from "./shared.js";

const SUGGEST_DELAY_MS = 200;
const PERSISTENT = "default";
/** 스페이스 칸 하나가 미리 보여 주는 탭 아이콘 수 — 넘치면 「+n」으로 줄인다. */
const TILE_ICONS = 4;

/** 주소줄 문서. 메뉴·스페이스 선택 화면·주소 제안·대화상자·주석은 이 문서가 같은 몸으로 그린다 — 오버레이가 열리면 main 이 이 뷰를 표면 높이로 키운다. */
export function mountBar(): { render(state: ChromeUiState): void; inspected(seq: number, element: unknown): void; captured(seq: number, shot: unknown): void } {
  const strip = h("div", { class: "strip" });
  const overlay = h("div", { class: "overlay", hidden: true as unknown as boolean });
  document.body.append(strip, overlay);

  const back = h("button", { class: "icon", type: "button", on: { click: () => post("bar", "navigate", { url: "back" }) } }, "←");
  const forward = h("button", { class: "icon", type: "button", on: { click: () => post("bar", "navigate", { url: "forward" }) } }, "→");
  const reload = h("button", { class: "icon reload", type: "button", on: { click: () => post("bar", "navigate", { url: "reload" }) } }, glyph(G.reload));
  const display = h("span", { class: "url-display", attrs: { "aria-hidden": "true" } });
  const input = h("input", { class: "url-input", type: "text", autocomplete: "off", spellcheck: false, attrs: { inputmode: "url", role: "combobox", "aria-autocomplete": "list" } });
  const form = h("form", { class: "url" }, display, input);
  const detach = h("button", { class: "icon detach", type: "button", on: { mousedown: (event) => event.preventDefault(), click: () => post("bar", "toggle-mode") } }, "↗");
  // 스페이스 — 도구 메뉴 바로 왼쪽. 누르면 스페이스들이 그리드로 펼쳐지고, 사령관 스페이스를 보는 동안에는 그 스페이스의 색으로 물든다.
  // 누르면 초점이 주소줄을 떠난다(mousedown 을 막지 않는다): 스페이스를 옮긴 뒤 주소줄이 고치던 중으로 남아 옛 주소를 붙잡지 않게.
  const spacesButton = h("button", { class: "icon spaces-button", type: "button", attrs: { "aria-haspopup": "dialog" }, on: { click: () => post("bar", "overlay", { kind: last?.overlay?.kind === "spaces" ? null : "spaces" }) } }, glyph(G.spaces, 16));
  const more = h("button", { class: "icon more-button", type: "button", attrs: { "aria-haspopup": "menu" }, on: { click: () => post("bar", "overlay", { kind: last?.overlay?.kind === "menu" ? null : "menu" }) } }, moreGlyph());
  const leading = h("span", { class: "pad" });
  const trailing = h("span", { class: "pad" });
  strip.append(leading, back, forward, reload, form, detach, spacesButton, more, trailing);

  let last: ChromeUiState | null = null;
  let editing = false;
  let dirty = false;
  let composing = false;
  let selected = -1;
  let suggestTimer: ReturnType<typeof setTimeout> | null = null;
  let annotator: Annotator | null = null;
  let infoTimer: ReturnType<typeof setTimeout> | null = null;
  let infoKey = "";
  let lastUrl = "";
  let dialogFocusSeen = 0;

  const submit = (value: string): void => {
    dirty = false; editing = false;
    post("bar", "draft", { value: null });
    closeSuggestions();
    input.blur();
    const target = value.trim();
    if (target) post("bar", "navigate", { url: target });
  };
  const closeSuggestions = (): void => {
    if (suggestTimer !== null) { clearTimeout(suggestTimer); suggestTimer = null; }
    selected = -1;
    post("bar", "suggest", { query: "" });
  };
  const askSuggest = (value: string): void => {
    if (suggestTimer !== null) clearTimeout(suggestTimer);
    selected = -1;
    if (!value.trim() || value.length > 2048 || composing) { post("bar", "suggest", { query: "" }); return; }
    suggestTimer = setTimeout(() => { suggestTimer = null; post("bar", "suggest", { query: value }); }, SUGGEST_DELAY_MS);
  };
  const suggestionsOf = (): readonly ChromeSuggestion[] => (editing && !composing && last?.overlay?.kind === "suggestions" ? last.suggestions : []);

  form.addEventListener("submit", (event) => { event.preventDefault(); if (!composing) submit(input.value); });
  form.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && (form.contains(next) || overlay.contains(next))) return;
    // 제안 목록의 항목은 mousedown 을 막아 초점을 뺏지 않는다 — 여기까지 온 것은 정말 주소줄을 떠난 것이다.
    editing = false; render(last!); closeSuggestions();
  });
  input.addEventListener("focus", () => { editing = true; input.select(); render(last!); });
  input.addEventListener("input", () => { editing = true; dirty = true; post("bar", "draft", { value: input.value }); askSuggest(input.value); render(last!); });
  input.addEventListener("compositionstart", () => { composing = true; closeSuggestions(); });
  input.addEventListener("compositionend", () => { composing = false; askSuggest(input.value); });
  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
    const list = suggestionsOf();
    if (event.key === "Escape") { dirty = false; post("bar", "draft", { value: null }); event.preventDefault(); closeSuggestions(); editing = false; input.blur(); render(last!); }
    else if (list.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      selected = event.key === "ArrowDown" ? (selected + 1) % list.length : (selected <= 0 ? list.length : selected) - 1;
      renderOverlay(last!);
    } else if (event.key === "Enter" && list.length > 0 && selected >= 0) { event.preventDefault(); submit(list[selected]!.value); }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && last?.overlay && last.overlay.kind !== "suggestions" && last.overlay.kind !== "annotate") post("bar", "dialog-close"); });

  const item = (t: T, glyphPaths: string, label: string, onClick: () => void, options: { disabled?: boolean; checked?: boolean; help?: string; title?: string } = {}): HTMLElement =>
    h("button", { class: "menu-item", type: "button", role: options.checked === undefined ? "menuitem" : "menuitemcheckbox", disabled: options.disabled === true, title: options.title, attrs: options.checked === undefined ? {} : { "aria-checked": String(options.checked) }, on: { click: onClick } },
      h("span", { class: "menu-glyph" }, glyph(glyphPaths)),
      h("span", { class: "menu-body" }, h("strong", { text: label }), options.help ? h("span", { class: "help", text: options.help }) : null));

  const buildMenu = (state: ChromeUiState, t: T): HTMLElement => {
    const chrome = state.chrome;
    // 뷰포트는 스페이스마다 따로다 — 지금 보고 있는 스페이스의 것을 가리킨다.
    const viewportPreset = shownSpace(state)?.viewportPreset ?? "responsive";
    const ready = chrome !== null && chrome.available && !state.busy;
    const tab = chrome?.tabs.find((candidate) => candidate.id === chrome.activeTabId) ?? null;
    const hasCapture = tab !== null && tab.url !== "about:blank";
    const menu = h("div", { class: "menu", role: "menu", attrs: { "aria-label": t("moreTools") } });
    if (hasCapture) menu.append(item(t, G.camera, t("attachScreenshot"), () => post("bar", "attach-screenshot"), { disabled: !state.captureAvailable || state.busy }));
    menu.append(item(t, G.comment, t("annotate"), () => post("bar", "annotate"), { disabled: !state.captureAvailable || tab === null }));
    if (tab && /^https?:\/\//iu.test(tab.url)) menu.append(item(t, G.external, t("openExternal"), () => post("bar", "open-external")));
    menu.append(h("div", { class: "menu-sep", role: "separator" }), h("div", { class: "menu-label", text: t("menu.session") }));
    for (const value of [null, PERSISTENT] as const) {
      const row = h("div", { class: "menu-item", role: "menuitemradio", tabindex: ready ? 0 : -1, title: t(value ? "profile.persistentTip" : "profile.ephemeralTip"), attrs: { "aria-checked": String((chrome?.profile ?? null) === value), "aria-disabled": String(!ready) } });
      const choose = (): void => { if (ready) post("bar", "profile", { profile: value }); };
      row.addEventListener("click", choose);
      row.addEventListener("keydown", (event) => { if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); choose(); } });
      const tail = h("span", { class: "menu-tail" });
      if ((chrome?.defaultProfile ?? null) === value) tail.append(h("span", { class: "menu-default", text: t("profile.default") }));
      else {
        const pin = h("button", { class: "menu-pin", type: "button", attrs: { "aria-label": t("profile.makeDefault"), "data-tip": t("profile.makeDefault") } }, glyph(G.pin));
        pin.addEventListener("click", (event) => { event.stopPropagation(); post("bar", "default-profile", { profile: value }); });
        pin.addEventListener("keydown", (event) => event.stopPropagation());
        tail.append(pin);
      }
      row.append(h("span", { class: "menu-glyph" }, glyph(value ? G.profile : G.ephemeral)),
        h("span", { class: "menu-body" }, h("strong", { text: t(value ? "profile.persistent" : "profile.ephemeral") }), h("span", { class: "help", text: t(value ? "profile.persistentHelp" : "profile.ephemeralHelp") })), tail);
      menu.append(row);
    }
    menu.append(item(t, G.import, t("import.title"), () => post("bar", "import-open"), { disabled: state.importUnavailable || !ready, title: state.importUnavailable ? t("import.windowsPending") : undefined }));
    menu.append(item(t, G.erase, t("profile.clearItem"), () => post("bar", "clear-open"), { disabled: !ready, help: t("profile.clearScope") }));
    menu.append(h("div", { class: "menu-sep", role: "separator" }), h("div", { class: "menu-label", text: t("viewport") }));
    for (const preset of ["responsive", "mobile", "tablet"] as const) {
      menu.append(h("button", { class: "menu-item", type: "button", role: "menuitemradio", disabled: !ready, attrs: { "aria-checked": String(viewportPreset === preset) }, on: { click: () => post("bar", "viewport", { preset }) } },
        h("span", { class: "menu-glyph" }, glyph(preset === "mobile" ? G.phone : preset === "tablet" ? G.tablet : G.monitor)),
        h("span", { class: "menu-body" }, h("strong", { text: t(`preset.${preset}`) }))));
    }
    return menu;
  };

  /**
   * 스페이스 선택 화면 — 디폴트와 모든 사령관 스페이스를 그리드로. 칸을 누르면 그 스페이스로 옮긴다(옮기는 일은 main 이 한다).
   * 칸은 이름, 열린 탭의 아이콘과 수, 에이전트가 쓰는 중인지만 말한다 — 고르는 데 필요 없는 설명은 싣지 않는다.
   */
  const buildSpaces = (state: ChromeUiState, t: T): HTMLElement => {
    const chrome = state.chrome;
    const grid = h("div", { class: "spaces-grid", role: "list" });
    for (const space of chrome?.spaces ?? []) {
      const tabs = chrome!.tabs.filter((tab) => tab.spaceId === space.id);
      const name = spaceName(t, space);
      const current = space.id === state.spaceId;
      const count = tabCount(t, tabs.length);
      const mark = h("span", { class: "space-mark" });
      if (space.kind === "commodore") mark.append(h("span", { class: "space-initial", text: Array.from(name)[0] ?? "" })); else mark.append(glyph(G.home));
      const top = h("span", { class: "tile-top" }, mark, h("span", { class: "tile-name", text: name }));
      if (space.driving) top.append(h("span", { class: "tile-agent", title: t("space.driving"), attrs: { role: "img", "aria-label": t("space.driving") } }, agentGlyph()));
      const icons = h("span", { class: "tile-icons" });
      for (const tab of tabs.slice(0, TILE_ICONS)) {
        const icon = h("span", { class: "tab-icon" });
        if (tab.favicon) {
          const image = h("img", { src: tab.favicon, alt: "", draggable: false });
          image.addEventListener("error", () => { clear(icon); icon.append(glyph(G.globe)); });
          icon.append(image);
        } else icon.append(glyph(G.globe));
        icons.append(icon);
      }
      if (tabs.length > TILE_ICONS) icons.append(h("span", { class: "tile-more", text: `+${tabs.length - TILE_ICONS}` }));
      const foot = h("span", { class: "tile-foot" }, icons, h("span", { class: "tile-count", text: count }));
      const label = `${t("spaces.tile", { name, tabs: count })}${current ? ` · ${t("spaces.current")}` : ""}${space.driving ? ` · ${t("space.driving")}` : ""}`;
      const tile = h("button", { class: `space-tile${current ? " current" : ""}${tabs.length === 0 ? " no-tabs" : ""}`, type: "button", disabled: !chrome!.available, attrs: { "aria-label": label, "aria-current": current ? "true" : null, "data-kind": space.kind }, on: { click: () => post("bar", "select-space", { id: space.id }) } },
        top, foot);
      tile.style.setProperty("--space-hue", String(spaceHue(space.id)));
      if (current) top.append(h("span", { class: "tile-current", text: t("spaces.current") }));
      grid.append(h("div", { class: "spaces-cell", role: "listitem" }, tile));
    }
    // 방향키로 칸 사이를 오간다 — 줄 수는 폭에 따라 달라지므로 앞뒤로만 옮긴다.
    grid.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (step === 0) return;
      const tiles = Array.from(grid.querySelectorAll<HTMLButtonElement>(".space-tile:not(:disabled)"));
      const index = tiles.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0 || tiles.length === 0) return;
      event.preventDefault();
      tiles[(index + step + tiles.length) % tiles.length]!.focus();
    });
    return h("div", { class: "spaces-panel", role: "dialog", attrs: { "aria-label": t("spaces.title") } },
      h("div", { class: "spaces-head" }, h("h2", { text: t("spaces.title") })), grid);
  };
  const spacesKey = (state: ChromeUiState): string => JSON.stringify([state.spaceId, state.chrome?.available, state.chrome?.spaces.map((space) => [space.id, space.label, space.driving]), state.chrome?.tabs.map((tab) => [tab.id, tab.spaceId, tab.favicon?.length ?? 0])]);

  const buildSuggestions = (state: ChromeUiState, t: T): HTMLElement | null => {
    const settings = state.suggest;
    const list = suggestionsOf();
    if (list.length > 0) {
      const box = h("div", { class: "suggestions", role: "listbox", attrs: { "aria-label": t("suggestions.title") } });
      list.forEach((suggestion, index) => {
        const icon = h("span", { class: "tab-icon" });
        if (suggestion.favicon) icon.append(h("img", { src: suggestion.favicon, alt: "", draggable: false })); else icon.append(glyph(suggestion.history ? G.globe : G.search));
        const label = h("span", { class: "suggestion-label" }, suggestion.title, suggestion.history ? h("small", { text: suggestion.value }) : null);
        const button = h("button", { class: "suggestion result", type: "button", role: "option", tabindex: -1, attrs: { "aria-selected": String(selected === index) } }, icon, label);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => { if (!composing) submit(suggestion.value); });
        box.append(button);
      });
      return box;
    }
    if (editing && !composing && settings && settings.enabled === false && !settings.prompted && last?.overlay?.kind === "suggestions") {
      const box = h("div", { class: "suggestions prompt" }, h("span", { text: t("suggestions.disclosure") }));
      const actions = h("div", { class: "suggestion-actions" });
      for (const [enabled, key] of [[true, "suggestions.enable"], [false, "suggestions.dismiss"]] as const) {
        const button = h("button", { class: "suggestion", type: "button", text: t(key), disabled: settings.saving });
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => { input.focus(); post("bar", "suggest-settings", { enabled }); });
        actions.append(button);
      }
      box.append(actions);
      if (settings.failed) box.append(h("span", { role: "alert", text: t("suggestions.settingsFailed") }));
      return box;
    }
    return null;
  };

  const dialog = (t: T, title: string, body: string | null, content: Node[], actions: Node[], key: string): HTMLElement => {
    const card = h("div", { class: "dialog", role: "dialog", attrs: { "aria-modal": "true", "aria-label": title } },
      h("div", { class: "dialog-head" }, h("div", {}, h("h3", { text: title }), body ? h("p", { text: body }) : null)),
      ...content, h("div", { class: "dialog-actions" }, ...actions));
    card.dataset.key = key;
    return card;
  };
  const dialogItem = (glyphPaths: string, strong: string, help: string, target = false): HTMLElement =>
    h("div", { class: `dialog-item${target ? " is-target" : ""}` }, h("span", { class: "dialog-glyph" }, glyph(glyphPaths)), h("span", {}, h("strong", { text: strong }), h("span", { class: "help", text: help })));

  /** 표시 탭의 페이지가 띄워 답을 기다리는 alert·confirm. */
  const pageDialogOf = (state: ChromeUiState) => {
    const tab = state.chrome?.tabs.find((candidate) => candidate.id === state.chrome?.activeTabId) ?? null;
    return tab?.dialog ? { tab, dialog: tab.dialog } : null;
  };
  /** 크롬의 페이지 대화상자처럼 페이지 위에 띄운다 — 답은 Console 로 가고, 대화상자가 닫히면 다음 상태가 이 카드를 거둔다. */
  const buildPageDialog = (state: ChromeUiState, t: T, asked: NonNullable<ReturnType<typeof pageDialogOf>>): HTMLElement => {
    const answer = (accept: boolean): void => post("bar", "page-dialog", { id: asked.tab.id, dialogId: asked.dialog.id, accept });
    const ok = h("button", { class: "button primary", type: "button", text: t("jsDialog.ok"), disabled: state.busy, on: { click: () => answer(true) } });
    const actions = asked.dialog.type === "confirm" ? [h("button", { class: "button", type: "button", text: t("jsDialog.cancel"), disabled: state.busy, on: { click: () => answer(false) } }), ok] : [ok];
    // 대화상자를 띄운 프레임의 출처로 말한다 — 다른 출처의 iframe 이면 탭이 아니라 그 페이지임을 밝힌다. 출처를 싣지 않는 옛 Console 만 탭으로 말한다.
    const tabOrigin = ((): string => { try { return new URL(asked.tab.url).origin; } catch { return "null"; } })();
    const source = asked.dialog.origin ?? tabOrigin;
    const title = source === tabOrigin ? t("jsDialog.title", { host: hostOf(asked.tab.url) })
      : source === "null" ? t("jsDialog.embeddedOpaqueTitle") : t("jsDialog.embeddedTitle", { host: hostOf(source) });
    return dialog(t, title, null, [h("p", { class: "page-dialog-message", text: asked.dialog.message })], actions, "page-dialog");
  };

  let importProfile = "";
  const buildDialog = (state: ChromeUiState, t: T, overlayState: Extract<ChromeOverlay, { kind: "import" | "switch" | "clear" }>): HTMLElement => {
    const busy = state.busy;
    const cancel = h("button", { class: "button", type: "button", text: t("import.cancel"), disabled: busy, on: { click: () => post("bar", "dialog-close") } });
    if (overlayState.kind === "switch") {
      const next = overlayState.profile;
      const run = h("button", { class: "button primary", type: "button", text: t("profile.switchRun"), disabled: busy, on: { click: () => post("bar", "profile-confirm", { profile: next }) } });
      return dialog(t, t(next ? "profile.switchToProfile" : "profile.switchToEphemeral"), t("profile.switchBody", { count: String(state.chrome?.tabs.length ?? 0) }),
        [dialogItem(next ? G.profile : G.ephemeral, t(next ? "profile.persistent" : "profile.ephemeral"), t(next ? "profile.persistentHelp" : "profile.ephemeralHelp"))], [cancel, run], `switch:${next}`);
    }
    if (overlayState.kind === "clear") {
      const run = h("button", { class: "button danger", type: "button", text: t("profile.clearRun"), disabled: busy, on: { click: () => post("bar", "clear-run") } });
      return dialog(t, t("profile.clearTitle"), t("profile.clearBody"), [dialogItem(G.profile, t("profile.persistent"), t("profile.clearScope"))], [cancel, run], "clear");
    }
    const sources: ChromeImportSources = overlayState.sources;
    if (!sources.profiles.some((profile) => profile.id === importProfile)) importProfile = sources.profiles[0]?.id ?? "";
    const select = h("select", { class: "select", disabled: busy, attrs: { "aria-label": "Google Chrome" } });
    for (const profile of sources.profiles) select.append(h("option", { value: profile.id, text: `${profile.name}${profile.account ? ` (${profile.account})` : ""}` }));
    select.value = importProfile;
    select.addEventListener("change", () => { importProfile = select.value; });
    const persistent = Boolean(state.chrome?.profile);
    const run = h("button", { class: "button primary", type: "button", text: t(busy ? "import.busy" : "import.run"), disabled: busy || !importProfile, on: { click: () => post("bar", "import-run", { profileId: importProfile }) } });
    const close = h("button", { class: "icon", type: "button", text: "×", disabled: busy, attrs: { "aria-label": t("close") }, on: { click: () => post("bar", "dialog-close") } });
    const card = dialog(t, t("import.title"), t("import.body"), [
      h("label", { class: "dialog-row" }, h("span", { class: "dialog-key", text: t("import.source") }), select),
      dialogItem(G.globe, t("import.cookies"), t("import.cookiesHelp")),
      dialogItem(persistent ? G.profile : G.ephemeral, t(persistent ? "import.intoProfile" : "import.intoEphemeral"), t(persistent ? "import.intoProfileHelp" : "import.intoEphemeralHelp"), true),
    ], [cancel, run], "import");
    card.querySelector(".dialog-head")?.append(close);
    return card;
  };

  const placePage = (element: HTMLElement, state: ChromeUiState): void => {
    const page = state.page;
    element.style.left = `${page.x}px`; element.style.top = `${page.y}px`; element.style.width = `${page.width}px`; element.style.height = `${page.height}px`;
  };

  let overlayKey = "";
  function renderOverlay(state: ChromeUiState): void {
    const t = tr(state);
    const current = state.overlay;
    const modal = current !== null && current.kind !== "menu" && current.kind !== "suggestions" && current.kind !== "spaces";
    const showing = current !== null && state.overlayReady;
    // 다른 오버레이가 없을 때만 그린다 — 메뉴를 닫으면 다시 보인다.
    const asked = showing ? null : pageDialogOf(state);
    overlay.hidden = !showing && !asked && !state.info && !state.notice;
    if (current?.kind !== "annotate" && annotator) { annotator.dispose(); annotator = null; }
    // 스페이스 선택 화면이 닫히면 초점을 그 단추로 돌려준다 — 키보드로 연 사람이 화면 밖에서 길을 잃지 않게.
    const leavingSpaces = overlayKey.startsWith("spaces:") && !(showing && current!.kind === "spaces") && overlay.contains(document.activeElement);
    const key = showing ? `${current!.kind}:${current!.kind === "suggestions" ? list(state) : current!.kind === "menu" ? JSON.stringify([state.chrome?.profile, state.chrome?.defaultProfile, shownSpace(state)?.viewportPreset, state.chrome?.tabs.length, state.busy, state.captureAvailable]) : current!.kind === "spaces" ? spacesKey(state) : modal ? JSON.stringify([state.busy, (current as { sources?: unknown }).sources ?? null, (current as { profile?: unknown }).profile ?? null, state.chrome?.profile, state.chrome?.tabs.length]) : ""}:${selected}` : asked ? `page-dialog:${JSON.stringify([asked.tab.id, asked.tab.url, asked.dialog, state.busy, state.page])}` : "none";
    const toastKey = `${state.notice ?? ""}|${state.info?.text ?? ""}|${state.info?.action ?? ""}`;
    if (current?.kind === "annotate" && showing) {
      if (!annotator) { clear(overlay); annotator = mountAnnotate(overlay, state, t); overlayKey = "annotate"; }
      else annotator.update(state);
      placeToast(state, t, toastKey);
      return;
    }
    if (key === overlayKey && toastKey === infoKey) return;
    if (key !== overlayKey) {
      overlayKey = key;
      clear(overlay);
      if (leavingSpaces) spacesButton.focus({ preventScroll: true });
      if (showing) {
        const backdrop = h("div", { class: `backdrop${modal ? " modal" : ""}` });
        backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop && !modal) post("bar", "overlay", { kind: null }); });
        if (current!.kind === "menu") {
          const menu = buildMenu(state, t);
          backdrop.append(menu);
        } else if (current!.kind === "spaces") {
          // 주소줄 아래 표면 전체를 덮는 한 화면 — 레일과 페이지 위에 선다. 빈 곳을 누르면 닫힌다.
          const hadFocus = overlay.contains(document.activeElement);
          backdrop.classList.add("spaces-screen");
          backdrop.append(buildSpaces(state, t));
          // 열릴 때 보고 있는 스페이스의 칸에 초점을 둔다 — 키보드로 바로 옮길 수 있고, 다시 그려져도 초점이 화면 밖으로 새지 않는다.
          queueMicrotask(() => { if (overlayKey.startsWith("spaces:") && (hadFocus || !overlay.contains(document.activeElement))) (backdrop.querySelector<HTMLElement>(".space-tile.current:not(:disabled)") ?? backdrop.querySelector<HTMLElement>(".space-tile:not(:disabled)"))?.focus(); });
        } else if (current!.kind === "suggestions") {
          const box = buildSuggestions(state, t);
          if (box) { const rect = form.getBoundingClientRect(); box.style.left = `${rect.left}px`; box.style.width = `${rect.width}px`; box.style.top = `${rect.bottom + 4}px`; backdrop.append(box); }
        } else {
          placePage(backdrop, state);
          backdrop.classList.add("scrim");
          backdrop.append(buildDialog(state, t, current as Extract<ChromeOverlay, { kind: "import" | "switch" | "clear" }>));
        }
        overlay.append(backdrop);
      } else if (asked) {
        const backdrop = h("div", { class: "backdrop modal scrim" });
        placePage(backdrop, state);
        backdrop.append(buildPageDialog(state, t, asked));
        overlay.append(backdrop);
      }
    }
    placeToast(state, t, toastKey);
  }
  const list = (state: ChromeUiState): string => state.suggestions.map((entry) => `${entry.value}\u0000${entry.title}`).join("\u0001") + `|${state.suggest?.enabled}|${state.suggest?.prompted}|${state.suggest?.saving}|${state.suggest?.failed}`;

  function placeToast(state: ChromeUiState, t: T, key: string): void {
    overlay.querySelector(".toast")?.remove();
    if (infoTimer !== null && key !== infoKey) { clearTimeout(infoTimer); infoTimer = null; }
    infoKey = key;
    const text = state.notice ?? state.info?.text ?? null;
    if (!text) { overlay.hidden = (state.overlay === null || !state.overlayReady) && !pageDialogOf(state); return; }
    overlay.hidden = false;
    const toast = h("div", { class: `toast${state.notice ? " is-error" : ""}${state.info?.action ? " has-action" : ""}`, role: state.notice ? "alert" : "status", text });
    if (!state.notice && state.info?.action) {
      toast.append(h("button", { class: "toast-action", type: "button", text: state.info.action, on: { click: () => post("bar", "info-action") } }));
    }
    // 알림은 주소줄 바로 아래 한 줄이다 — main 이 이 동안만 뷰를 그만큼 키운다.
    toast.style.left = `${state.page.x}px`; toast.style.width = `${state.page.width}px`; toast.style.top = "58px";
    overlay.append(toast);
    void t;
  }

  const render = (state: ChromeUiState): void => {
    const previous = last;
    last = state;
    paintColors(state.colors);
    document.documentElement.lang = state.lang;
    document.documentElement.dataset.platform = state.platform;
    document.documentElement.dataset.mode = state.mode;
    const t = tr(state);
    const chrome = state.chrome;
    const tab = chrome?.tabs.find((candidate) => candidate.id === chrome.activeTabId) ?? null;
    const available = chrome?.available === true;
    leading.style.width = `${state.leading}px`; trailing.style.width = `${state.trailing}px`;
    // 조작 중 표시는 지금 보는 스페이스의 것이다 — 다른 스페이스의 에이전트가 일하는 동안 이 화면이 물들면 여기 탭이 조작되는 것처럼 읽힌다.
    // 다른 스페이스에서 일하는 중이면 스페이스 단추에 점 하나로 알린다.
    strip.classList.toggle("driving", shownSpace(state)?.driving === true);
    back.title = back.ariaLabel = t("back"); forward.title = forward.ariaLabel = t("forward"); reload.title = reload.ariaLabel = t("reload");
    back.disabled = !tab?.canGoBack || state.busy; forward.disabled = !tab?.canGoForward || state.busy; reload.disabled = !tab || state.busy;
    reload.classList.toggle("loading", tab?.loading === true);
    detach.textContent = state.mode === "window" ? "↙" : "↗";
    detach.title = detach.ariaLabel = t(state.mode === "window" ? "reattach" : "detach");
    const space = shownSpace(state);
    const spacesOpen = state.overlay?.kind === "spaces";
    const spacesTip = t("spaces.button", { name: spaceName(t, space) });
    spacesButton.title = spacesOpen ? "" : spacesTip; spacesButton.ariaLabel = spacesTip;
    spacesButton.setAttribute("aria-expanded", String(spacesOpen));
    spacesButton.classList.toggle("open", spacesOpen);
    spacesButton.classList.toggle("in-space", space?.kind === "commodore");
    const elsewhere = chrome?.spaces.some((other) => other.driving && other.id !== state.spaceId) === true;
    spacesButton.classList.toggle("elsewhere", elsewhere);
    if (!spacesOpen && elsewhere) spacesButton.title = `${spacesTip} · ${t("spaces.elsewhere")}`;
    spacesButton.ariaLabel = elsewhere ? `${spacesTip} · ${t("spaces.elsewhere")}` : spacesTip;
    spacesButton.style.setProperty("--space-hue", String(spaceHue(state.spaceId)));
    spacesButton.disabled = chrome === null;
    more.title = state.overlay?.kind === "menu" ? "" : t("moreTools"); more.ariaLabel = t("moreTools");
    more.setAttribute("aria-expanded", String(state.overlay?.kind === "menu"));
    more.classList.toggle("open", state.overlay?.kind === "menu");
    input.disabled = !available;
    input.placeholder = t("urlPlaceholder"); input.setAttribute("aria-label", t("pageUrl"));
    input.setAttribute("aria-expanded", String(suggestionsOf().length > 0));
    // 사람이 고치는 중이 아니면 입력은 활성 탭의 주소를 따른다. 고치던 글은 탭이 바뀌어도 남는다(draft).
    const url = tab?.url === "about:blank" ? "" : tab?.url ?? "";
    if (state.draft !== null && previous === null) { input.value = state.draft; dirty = true; editing = false; }
    else if (!editing && !dirty && input.value !== url) input.value = url;
    if (url !== lastUrl) { lastUrl = url; if (!editing) dirty = false; }
    const showDisplay = !editing && input.value.length > 0;
    form.classList.toggle("is-display", showDisplay);
    clear(display);
    if (showDisplay) {
      try {
        const parsed = new URL(input.value);
        const rest = `${parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
        display.append(h("span", { class: "url-host", text: parsed.host }));
        if (rest) display.append(h("span", { class: "url-rest", text: rest }));
      } catch { display.append(h("span", { class: "url-host", text: hostOf(input.value) })); }
    }
    // 새 탭을 열면 주소줄로 초점을 옮긴다(예전 「새 탭」 동작).
    if (previous && previous.chrome && chrome && chrome.tabs.length > previous.chrome.tabs.length && tab?.url === "about:blank" && !editing) { input.focus(); }
    renderOverlay(state);
    // 셸이 초점을 넘겨준 대화상자면 기본 단추(confirm 은 OK — 옛 OS 창의 기본값)로 옮긴다.
    const focusToken = state.pageDialogFocus ?? 0;
    if (focusToken > dialogFocusSeen) {
      const button = overlay.querySelector<HTMLButtonElement>(".dialog .button.primary");
      if (button) { dialogFocusSeen = focusToken; button.focus({ preventScroll: true }); }
    }
  };

  return {
    render,
    inspected(seq: number, element: unknown): void { annotator?.inspected(seq, element); },
    captured(seq: number, shot: unknown): void { annotator?.captured(seq, shot); },
  };
}
