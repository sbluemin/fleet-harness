import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

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
  let deferredClear: number | null = null;

  const clear = () => {
    animating = null;
    if (detachWatch !== null) {
      cancelAnimationFrame(detachWatch);
      detachWatch = null;
    }
    if (deferredClear !== null) {
      cancelAnimationFrame(deferredClear);
      deferredClear = null;
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
    // 되돌리기(cancel 직후 새 run)는 이전 종료가 예약한 해제를 무른다 — 새 전환 도중 플래그가 걷히면 안 된다.
    if (deferredClear !== null) {
      cancelAnimationFrame(deferredClear);
      deferredClear = null;
    }
    animating = event.target as HTMLElement;
    document.body.setAttribute(ANIMATING_ATTRIBUTE, "true");
    if (detachWatch === null) watchForDetach();
  };
  // 해제는 한 프레임 미룬다. 아레나 인셋 추종(useSideBarFollowedInset)의 마지막 커밋이 전환이 끝난 그 프레임에
  // 서는데, 그때 플래그가 이미 걷혀 있으면 마지막 몇 px이 되살아난 패널 글라이드를 탄다.
  const stop = (event: TransitionEvent) => {
    if (!isSideBarWidthTransition(event)) return;
    if (deferredClear !== null) cancelAnimationFrame(deferredClear);
    deferredClear = requestAnimationFrame(() => {
      deferredClear = null;
      clear();
    });
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

/**
 * 사이드바가 width 전환으로 여닫히는 동안 캔버스 아레나의 왼쪽 인셋이 사이드바를 매 프레임 따라가게 한다.
 *
 * 전면 캔버스에서 사이드바는 캔버스 위의 부유 카드라, 스토어의 접힘 상태로 계산한 인셋은 토글 즉시
 * 최종값이 된다. 그러면 월드 원점·companion 배치·스냅 칸이 첫 프레임에 최종 자리로 순간 이동하고,
 * 카드만 200ms 동안 제 폭을 줄이거나 늘린다. 도킹 시절에는 중앙 트랙의 리플로우가 이 추종을 공짜로
 * 해 주었다 — 여기서는 카드의 실제 진행을 읽어 같은 추종을 되살린다.
 *
 * 인셋은 카드 폭 자체가 아니라 카드 width 전환의 진행률로 옛 인셋에서 새 인셋까지 보간한다. 열린 인셋은
 * 폭 + 여백이고 닫힌 인셋은 0이라, 폭을 그대로 쓰면 끝에서 여백만큼 계단이 생긴다. 전환 길이·곡선은
 * CSS가 소유하고 여기서는 읽기만 한다(`body[data-side-bar-animating]`와 같은 원칙). 전환이 없으면
 * (드래그 리사이즈·reduced motion) 목표 인셋이 그대로 선다. 프레임 글라이드 억제 규칙은 그대로라
 * 패널 상자는 인셋을 즉시 따라가고, 터미널 refit은 사이드바가 멈춘 뒤에 걸린다.
 */
export function useSideBarFollowedInset(targetInset: number): number {
  const [followed, setFollowed] = useState<number | null>(null);
  const settledTargetRef = useRef(targetInset);
  const shownRef = useRef(targetInset);
  useLayoutEffect(() => {
    if (settledTargetRef.current === targetInset) return;
    settledTargetRef.current = targetInset;
    const fromInset = shownRef.current;
    const card = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`.${SIDE_BAR_CLASS}`);
    // getAnimations()가 스타일을 확정하므로 이 커밋이 연 width 전환이 여기서 잡힌다 — 첫 프레임부터 따라간다.
    const transition = card ? runningWidthTransition(card) : null;
    if (!card || !transition) {
      setFollowed(null);
      return;
    }
    // 진행률은 전환 자신의 곡선 적용 진행(0→1)을 읽는다 — 카드 폭은 닫힌 뒤에도 테두리만큼 남아 끝이 어긋난다.
    const insetNow = () => {
      const progress = transition.effect?.getComputedTiming().progress;
      if (typeof progress !== "number") return targetInset;
      return fromInset + Math.min(1, Math.max(0, progress)) * (targetInset - fromInset);
    };
    let active = true;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(() => {
        if (!active) return;
        // rAF 안의 갱신은 기본 우선순위로 미뤄져 페인트보다 늦을 수 있다 — 같은 프레임에 커밋한다.
        flushSync(() => setFollowed(insetNow()));
        tick();
      });
    };
    const finish = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      // 최종 인셋은 동기로 커밋한다 — 억제 플래그는 전환 종료 다음 프레임에 걷히므로(아래 관찰자) 그 전에 서야
      // 마지막 몇 px이 되살아난 패널 글라이드를 타지 않는다.
      flushSync(() => setFollowed(null));
    };
    setFollowed(fromInset);
    tick();
    transition.finished.then(finish, finish);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [targetInset]);
  const shown = followed ?? targetInset;
  // 다음 토글의 출발점은 지금 화면에 선 인셋이다 — 전환 도중 되돌려도 그 자리에서 이어진다.
  useLayoutEffect(() => {
    shownRef.current = shown;
  });
  return shown;
}

function runningWidthTransition(card: HTMLElement): Animation | null {
  if (typeof card.getAnimations !== "function" || typeof CSSTransition === "undefined") return null;
  return card.getAnimations().find((animation) => animation instanceof CSSTransition
    && animation.transitionProperty === "width"
    && animation.playState !== "finished") ?? null;
}
