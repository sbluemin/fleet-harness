const MODAL_SELECTOR = '[aria-modal="true"]:not([hidden])';
const MODAL_OPEN_ATTRIBUTE = "data-modal-open";

/**
 * 차단형 오버레이가 떠 있는지를 `<html data-modal-open>` 한 속성으로 알린다. CSS는 이 속성을 읽는다.
 *
 * 같은 판정을 `body:has([aria-modal="true"]:not([hidden])) …`로 적으면 Chrome은 문서 어디서든 노드나
 * 글자가 바뀔 때마다 그 :has() 앵커(body)의 서브트리를 통째로 무효화한다. 채팅 스트리밍 델타와 입력창의
 * 글자 하나가 문서 전체 스타일 재계산이 되어, DOM이 커질수록 입력과 드래그가 끊겼다. 판정은 모달의 표기
 * (`aria-modal`·`hidden`)가 바뀌거나 그런 노드가 붙고 떨어질 때만 다시 한다 — 일반 변경 레코드는 걸러진다.
 */
export function installModalOpenMarker(documentFor: Document = document): () => void {
  const root = documentFor.documentElement;
  const sync = () => root.toggleAttribute(MODAL_OPEN_ATTRIBUTE, documentFor.querySelector(MODAL_SELECTOR) !== null);
  const mayCarryModal = (node: Node) =>
    node instanceof Element && (node.hasAttribute("aria-modal") || node.querySelector("[aria-modal]") !== null);
  const observer = new MutationObserver((records) => {
    const open = root.hasAttribute(MODAL_OPEN_ATTRIBUTE);
    const relevant = records.some((record) => {
      if (record.type === "attributes") return true;
      // 열린 모달이 떨어져 나가면 닫힘이다. 닫힌 동안의 제거는 모달을 열 수 없다.
      if (open && [...record.removedNodes].some(mayCarryModal)) return true;
      return [...record.addedNodes].some(mayCarryModal);
    });
    if (relevant) sync();
  });
  observer.observe(documentFor.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-modal", "hidden"] });
  sync();
  return () => {
    observer.disconnect();
    root.removeAttribute(MODAL_OPEN_ATTRIBUTE);
  };
}
