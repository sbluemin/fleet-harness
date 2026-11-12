import type { ChromeUiState } from "../contract.js";
import { clear, G, glyph, h } from "./dom.js";
import { paintColors, shownSpace, spaceName, tr } from "./shared.js";

/**
 * 스테이지 문서 — 표시 탭의 페이지가 없는 동안 페이지 자리를 채운다. 페이지 뷰가 서면 그 아래에 가려진다.
 * 보기 전용 셸에서는 페이지 뷰가 없다 — 이 문서가 main 이 밀어 넣는 최신 프레임 한 장을 그 자리에 그린다.
 */
export function mountStage(): { render(state: ChromeUiState): void; frame(tabId: string | null, src: string | null): void } {
  const root = h("div", { class: "empty" });
  const image = h("img", { class: "frame", alt: "", draggable: false, hidden: true as unknown as boolean });
  document.body.append(image, root);
  let last: ChromeUiState | null = null;
  /** 지금 그림이 어느 탭의 것인가 — 보는 탭이 바뀌면 옛 탭의 그림을 남기지 않는다. */
  let shownTab: string | null = null;

  const renderViewer = (state: ChromeUiState): void => {
    const t = tr(state);
    const chrome = state.chrome;
    const view = state.viewOnly!;
    const tab = chrome?.tabs.find((candidate) => candidate.id === chrome.activeTabId) ?? null;
    if (tab === null || tab.id !== shownTab || view.status !== "connected") { shownTab = null; image.hidden = true; image.removeAttribute("src"); }
    document.documentElement.dataset.viewOnly = "true";
    image.alt = tab ? tab.title || t("viewOnly") : "";
    clear(root);
    root.hidden = !image.hidden;
    if (!image.hidden) return;
    const space = shownSpace(state);
    const title = view.status === "unmanaged" ? t("viewOnly.unmanaged") : view.status === "manager_disconnected" ? t("viewOnly.disconnected")
      : tab ? t("viewOnly.waiting") : space?.kind === "commodore" ? t("spaces.emptyTitle", { name: spaceName(t, space) }) : t("viewOnly.noTabs");
    root.append(h("span", { class: "empty-glyph" }, glyph(G.globe, 28)), h("p", { class: "empty-title", text: title }));
  };

  return {
    render(state) {
      last = state;
      paintColors(state.colors);
      document.documentElement.lang = state.lang;
      if (state.viewOnly) { renderViewer(state); return; }
      delete document.documentElement.dataset.viewOnly;
      shownTab = null; image.hidden = true; image.removeAttribute("src"); root.hidden = false;
      const t = tr(state);
      clear(root);
      const chrome = state.chrome;
      // 표시 탭이 있으면 페이지 뷰가 이 자리를 채운다 — 에뮬레이션으로 뷰보다 작게 그려질 때 빈 상태 문구가 비치지 않게 비운다.
      if (!chrome || (chrome.available && chrome.activeTabId !== null)) return;
      // 방금 열려 탭이 아직 없는 동안과 못 여는 까닭을 같은 자리에서 말한다.
      const unavailable = !chrome.available;
      // 사령관 스페이스의 빈 화면은 어느 스페이스가 비어 있는지만 한 줄로 말한다.
      const space = shownSpace(state);
      const inCommodore = !unavailable && space?.kind === "commodore";
      const title = unavailable ? t(chrome.reason === "shared" ? "unavailable.shared" : "unavailable.desktop_required") : inCommodore ? t("spaces.emptyTitle", { name: spaceName(t, space) }) : t("emptyTitle");
      const body = unavailable ? (chrome.reason === "shared" ? t("unavailable.sharedBody") : null) : inCommodore ? null : t("emptyBody");
      root.append(h("span", { class: "empty-glyph" }, glyph(G.globe, 28)), h("p", { class: "empty-title", text: title }));
      if (body) root.append(h("p", { class: "empty-body", text: body }));
    },
    /** main 이 보는 탭의 최신 프레임(`data:image/jpeg` URL)을 준다. 보는 탭이 아닌 프레임과 그 밖의 주소는 버린다. */
    frame(tabId, src) {
      if (!last?.viewOnly || tabId === null || src === null || !src.startsWith("data:image/jpeg;base64,") || last.chrome?.activeTabId !== tabId) return;
      shownTab = tabId;
      image.src = src;
      image.hidden = false;
      renderViewer(last);
    },
  };
}
