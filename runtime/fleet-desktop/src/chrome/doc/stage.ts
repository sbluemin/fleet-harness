import type { ChromeUiState } from "../contract.js";
import { clear, G, glyph, h } from "./dom.js";
import { paintColors, tr } from "./shared.js";

/** 스테이지 문서 — 표시 탭의 페이지가 없는 동안 페이지 자리를 채운다. 페이지 뷰가 서면 그 아래에 가려진다. */
export function mountStage(): (state: ChromeUiState) => void {
  const root = h("div", { class: "empty" });
  document.body.append(root);
  return (state) => {
    paintColors(state.colors);
    document.documentElement.lang = state.lang;
    const t = tr(state);
    clear(root);
    const chrome = state.chrome;
    if (!chrome) return;
    // 방금 열려 탭이 아직 없는 동안과 못 여는 까닭을 같은 자리에서 말한다.
    const unavailable = !chrome.available;
    const title = unavailable ? t(chrome.reason === "shared" ? "unavailable.shared" : "unavailable.desktop_required") : t("emptyTitle");
    const body = unavailable ? (chrome.reason === "shared" ? t("unavailable.sharedBody") : null) : t("emptyBody");
    root.append(h("span", { class: "empty-glyph" }, glyph(G.globe, 28)), h("p", { class: "empty-title", text: title }));
    if (body) root.append(h("p", { class: "empty-body", text: body }));
  };
}
