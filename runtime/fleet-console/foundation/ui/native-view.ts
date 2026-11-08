/**
 * 네이티브 뷰를 물러서게 하는 표면의 계약.
 *
 * 플릿 브라우저 본문은 Electron 네이티브 뷰라 DOM 보다 위에 그려진다. `aria-modal="true"` 대화상자는 스스로 그 사실을 말하지만,
 * 비모달 팝오버(승인 목록 등)는 모달이 아니라 `aria-modal` 을 거짓으로 줄 수 없다. 그런 표면은 이 속성을 달아 「내 아래 영역이
 * 네이티브 뷰에 가려지면 안 된다」고 알린다 — 표면 쪽은 속성만 달고, 가림을 읽는 쪽(브라우저 패널)은 클래스명을 알 필요가 없다.
 */
export const NATIVE_VIEW_COVER_ATTRIBUTE = "data-covers-native-view";

/** 지금 문서에 네이티브 뷰를 가려야 하는 표면이 있는가를 묻는 선택자(모달 대화상자 포함). */
export const NATIVE_VIEW_COVER_SELECTOR = `[aria-modal="true"], [${NATIVE_VIEW_COVER_ATTRIBUTE}]`;

export function nativeViewCovered(documentFor: Document = document): boolean {
  return documentFor.querySelector(NATIVE_VIEW_COVER_SELECTOR) !== null;
}

/**
 * 그런 표면이 붙거나 떨어지거나 속성이 바뀔 때 알린다 — 폴링의 지연(몇 백 ms) 없이 열리는 순간 뷰가 물러서고 닫히는 순간 돌아오게.
 * 관련 없는 변경 레코드는 걸러서 일반 렌더가 콜백을 깨우지 않는다.
 */
export function observeNativeViewCover(onChange: () => void, documentFor: Document = document): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  // 포털로 다른 문서에 옮긴 요소와 그 문서에서 만든 요소는 생성자 realm이 다를 수 있다.
  const relevant = (node: Node): boolean =>
    node.nodeType === 1 && ((node as Element).matches(NATIVE_VIEW_COVER_SELECTOR) || (node as Element).querySelector(NATIVE_VIEW_COVER_SELECTOR) !== null);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some(relevant)) { onChange(); return; }
    }
  });
  observer.observe(documentFor.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-modal", NATIVE_VIEW_COVER_ATTRIBUTE] });
  return () => observer.disconnect();
}
