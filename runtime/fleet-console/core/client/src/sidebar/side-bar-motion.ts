/**
 * 사이드바 접기/펼치기가 진행 중인 동안 `body[data-side-bar-animating="true"]`를 세운다.
 *
 * 사이드바의 200ms width 전환은 그리드 중앙 트랙을 매 프레임 리플로우시키고, 그 폭을 받은
 * `.canvas-operation`은 자기 몫의 360ms geometry 글라이드를 탄다. 타깃이 매 프레임 새로 잡히므로
 * 프레임 상자는 사이드바가 멈춘 뒤에도 360ms 더 움직이고, 터미널의 refit 디바운스는 그 끝에서야
 * 풀린다 — 실측 664ms 동안 xterm이 옛 cols/rows로 남아 잘리거나 빈 띠를 남겼다.
 * 이 플래그가 그 구간에서만 프레임 글라이드를 끊어 상자가 스테이지를 즉시 따라가게 한다.
 *
 * 시작/종료 판정을 타이머가 아니라 전환 이벤트에 맡기는 이유: CSS의 200ms를 JS에 복제하면 둘이
 * 조용히 어긋나고, prefers-reduced-motion에서는 전환 자체가 없어 타이머만 헛돈다. transitionrun이
 * 오지 않으면 플래그도 서지 않으므로 모션이 꺼진 환경은 자동으로 무해하다.
 *
 * 드래그 리사이즈는 이 경로를 타지 않는다 — `[data-resizing="true"]`가 전환을 아예 끄므로
 * width 전환 이벤트가 발생하지 않는다.
 */
const ANIMATING_ATTRIBUTE = "data-side-bar-animating";
const SIDE_BAR_CLASS = "operations-side-bar";

function isSideBarWidthTransition(event: TransitionEvent): boolean {
  if (event.propertyName !== "width") return false;
  const target = event.target;
  return target instanceof HTMLElement && target.classList.contains(SIDE_BAR_CLASS);
}

export function observeSideBarCollapseMotion(): () => void {
  if (typeof document === "undefined") return () => undefined;

  // 두 사이드바(Map·War Room)가 같은 클래스를 달고 교대로 마운트되므로, 개별 ref 대신 문서 단에서
  // 버블링된 전환 이벤트를 받는다. 동시에 두 개가 살아 있지 않아 참조 계수는 필요하지 않다.
  let animating: HTMLElement | null = null;
  let detachWatch: number | null = null;

  const clear = () => {
    animating = null;
    if (detachWatch !== null) {
      cancelAnimationFrame(detachWatch);
      detachWatch = null;
    }
    document.body.removeAttribute(ANIMATING_ATTRIBUTE);
  };

  /**
   * 전환 중이던 사이드바가 트리에서 빠지면 종료 이벤트가 document까지 오지 않는다 — 이벤트는
   * 분리된 노드에서 발생하므로 버블링 경로에 document가 없다. Map↔War Room 전환은 사이드바
   * 컴포넌트를 통째로 교체하므로(pages/operations.tsx의 triageActive 분기) 접기 200ms 안에
   * 모드를 바꾸면 이 경로를 밟고, 플래그가 남아 패널 모션이 다음 토글까지 죽는다.
   * 관찰자는 App에 계속 살아 있어 스스로 회복하지도 못한다. 그래서 분리 여부를 직접 지켜본다.
   */
  const watchForDetach = () => {
    detachWatch = requestAnimationFrame(() => {
      detachWatch = null;
      if (!animating) return;
      if (!animating.isConnected) {
        clear();
        return;
      }
      watchForDetach();
    });
  };

  const start = (event: TransitionEvent) => {
    if (!isSideBarWidthTransition(event)) return;
    animating = event.target as HTMLElement;
    document.body.setAttribute(ANIMATING_ATTRIBUTE, "true");
    if (detachWatch === null) watchForDetach();
  };
  const stop = (event: TransitionEvent) => {
    if (!isSideBarWidthTransition(event)) return;
    clear();
  };

  document.addEventListener("transitionrun", start);
  document.addEventListener("transitionend", stop);
  document.addEventListener("transitioncancel", stop);

  return () => {
    document.removeEventListener("transitionrun", start);
    document.removeEventListener("transitionend", stop);
    document.removeEventListener("transitioncancel", stop);
    clear();
  };
}
