import type { ChromeImportSources, ChromeOverlay, ChromeSuggestion, ChromeUiState } from "../contract.js";
import { mountAnnotate, type Annotator } from "./annotate.js";
import { clear, G, glyph, h, hostOf, moreGlyph } from "./dom.js";
import { paintColors, post, tr, type T } from "./shared.js";

const SUGGEST_DELAY_MS = 200;
const PERSISTENT = "default";

/** 주소줄 문서. 메뉴·주소 제안·대화상자·주석은 이 문서가 같은 몸으로 그린다 — 오버레이가 열리면 main 이 이 뷰를 표면 높이로 키운다. */
export function mountBar(): { render(state: ChromeUiState): void; inspected(seq: number, element: unknown): void } {
  const strip = h("div", { class: "strip" });
  const overlay = h("div", { class: "overlay", hidden: true as unknown as boolean });
  document.body.append(strip, overlay);

  const back = h("button", { class: "icon", type: "button", on: { click: () => post("bar", "navigate", { url: "back" }) } }, "←");
  const forward = h("button", { class: "icon", type: "button", on: { click: () => post("bar", "navigate", { url: "forward" }) } }, "→");
  const reload = h("button", { class: "icon reload", type: "button", on: { click: () => post("bar", "navigate", { url: "reload" }) } }, glyph(G.reload));
  const display = h("span", { class: "url-display", attrs: { "aria-hidden": "true" } });
  const input = h("input", { class: "url-input", type: "text", autocomplete: "off", spellcheck: false, attrs: { inputmode: "url", role: "combobox", "aria-autocomplete": "list" } });
  const external = h("button", { class: "url-external", type: "button", on: { click: () => post("bar", "open-external") } }, glyph(G.external));
  const form = h("form", { class: "url" }, display, input, external);
  const detach = h("button", { class: "icon detach", type: "button", on: { mousedown: (event) => event.preventDefault(), click: () => post("bar", "toggle-mode") } }, "↗");
  const more = h("button", { class: "icon more-button", type: "button", attrs: { "aria-haspopup": "menu" }, on: { click: () => post("bar", "overlay", { kind: last?.overlay?.kind === "menu" ? null : "menu" }) } }, moreGlyph());
  const leading = h("span", { class: "pad" });
  const trailing = h("span", { class: "pad" });
  strip.append(leading, back, forward, reload, form, detach, more, trailing);

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
    const ready = chrome !== null && chrome.available && !state.busy;
    const tab = chrome?.tabs.find((candidate) => candidate.id === chrome.activeTabId) ?? null;
    const hasCapture = tab !== null && tab.url !== "about:blank";
    const menu = h("div", { class: "menu", role: "menu", attrs: { "aria-label": t("moreTools") } });
    if (hasCapture) menu.append(item(t, G.camera, t("attachScreenshot"), () => post("bar", "attach-screenshot"), { disabled: !state.captureAvailable || state.busy }));
    menu.append(item(t, G.comment, t("annotate"), () => post("bar", "annotate"), { disabled: !state.captureAvailable || tab === null }));
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
      menu.append(h("button", { class: "menu-item", type: "button", role: "menuitemradio", disabled: !ready, attrs: { "aria-checked": String(chrome?.viewport.preset === preset) }, on: { click: () => post("bar", "viewport", { preset }) } },
        h("span", { class: "menu-glyph" }, glyph(preset === "mobile" ? G.phone : preset === "tablet" ? G.tablet : G.monitor)),
        h("span", { class: "menu-body" }, h("strong", { text: t(`preset.${preset}`) }))));
    }
    return menu;
  };

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
    const modal = current !== null && current.kind !== "menu" && current.kind !== "suggestions";
    const showing = current !== null && state.overlayReady;
    overlay.hidden = !showing && !state.info && !state.notice;
    if (current?.kind !== "annotate" && annotator) { annotator.dispose(); annotator = null; }
    const key = showing ? `${current!.kind}:${current!.kind === "suggestions" ? list(state) : current!.kind === "menu" ? JSON.stringify([state.chrome?.profile, state.chrome?.defaultProfile, state.chrome?.viewport.preset, state.chrome?.tabs.length, state.busy, state.captureAvailable]) : modal ? JSON.stringify([state.busy, (current as { sources?: unknown }).sources ?? null, (current as { profile?: unknown }).profile ?? null, state.chrome?.profile, state.chrome?.tabs.length]) : ""}:${selected}` : "none";
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
      if (showing) {
        const backdrop = h("div", { class: `backdrop${modal ? " modal" : ""}` });
        backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop && !modal) post("bar", "overlay", { kind: null }); });
        if (current!.kind === "menu") {
          const menu = buildMenu(state, t);
          backdrop.append(menu);
        } else if (current!.kind === "suggestions") {
          const box = buildSuggestions(state, t);
          if (box) { const rect = form.getBoundingClientRect(); box.style.left = `${rect.left}px`; box.style.width = `${rect.width}px`; box.style.top = `${rect.bottom + 4}px`; backdrop.append(box); }
        } else {
          placePage(backdrop, state);
          backdrop.classList.add("scrim");
          backdrop.append(buildDialog(state, t, current as Extract<ChromeOverlay, { kind: "import" | "switch" | "clear" }>));
        }
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
    if (!text) { overlay.hidden = state.overlay === null || !state.overlayReady; return; }
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
    strip.classList.toggle("driving", chrome?.driving === true);
    back.title = back.ariaLabel = t("back"); forward.title = forward.ariaLabel = t("forward"); reload.title = reload.ariaLabel = t("reload");
    back.disabled = !tab?.canGoBack || state.busy; forward.disabled = !tab?.canGoForward || state.busy; reload.disabled = !tab || state.busy;
    reload.classList.toggle("loading", tab?.loading === true);
    detach.textContent = state.mode === "window" ? "↙" : "↗";
    detach.title = detach.ariaLabel = t(state.mode === "window" ? "reattach" : "detach");
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
    external.hidden = !(tab && tab.url !== "about:blank");
    external.title = external.ariaLabel = t("openExternal");
    form.classList.toggle("has-external", !external.hidden);
    // 새 탭을 열면 주소줄로 초점을 옮긴다(예전 「새 탭」 동작).
    if (previous && previous.chrome && chrome && chrome.tabs.length > previous.chrome.tabs.length && tab?.url === "about:blank" && !editing) { input.focus(); }
    renderOverlay(state);
  };

  return {
    render,
    inspected(seq, element): void { annotator?.inspected(seq, element); },
  };
}
