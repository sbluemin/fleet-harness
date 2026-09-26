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

// 플래그의 주인은 둘이다 — 카드의 실제 width 전환(관찰자)과, 전환 없이 인셋만 움직이는 추종(탐침 구동).
// 어느 한쪽이라도 붙들고 있으면 선다. 같은 호스트 번들 안의 두 경로라 모듈 상태로 합친다.
let transitionHoldsFlag = false;
let followHolds = 0;

function syncAnimatingFlag(): void {
  if (typeof document === "undefined") return;
  if (transitionHoldsFlag || followHolds > 0) document.body.setAttribute(ANIMATING_ATTRIBUTE, "true");
  else document.body.removeAttribute(ANIMATING_ATTRIBUTE);
}

/**
 * 다음 프레임에 부른다. transitionend·약속 콜백 안에서 건 rAF는 같은 프레임의 콜백 목록에 들어가 그 프레임
 * 스타일 계산 전에 돈다 — 억제 플래그를 걷는 일이 마지막 인셋 커밋과 한 프레임에 겹치면 그 몇 px이 패널
 * 글라이드를 탄다. 한 번 더 미뤄 마지막 커밋의 스타일 계산이 플래그 아래에서 끝나게 한다.
 */
function afterNextFrame(callback: () => void): () => void {
  let inner = 0;
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(callback);
  });
  return () => {
    cancelAnimationFrame(outer);
    cancelAnimationFrame(inner);
  };
}

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
  let deferredClear: (() => void) | null = null;

  const clear = () => {
    animating = null;
    if (detachWatch !== null) {
      cancelAnimationFrame(detachWatch);
      detachWatch = null;
    }
    if (deferredClear !== null) {
      deferredClear();
      deferredClear = null;
    }
    transitionHoldsFlag = false;
    syncAnimatingFlag();
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
      deferredClear();
      deferredClear = null;
    }
    animating = event.target as HTMLElement;
    transitionHoldsFlag = true;
    syncAnimatingFlag();
    if (detachWatch === null) watchForDetach();
  };
  // 해제는 다음 프레임으로 미룬다. 아레나 인셋 추종(useSideBarFollowedInset)의 마지막 커밋이 전환이 끝난 그 프레임에
  // 서는데, 그때 플래그가 이미 걷혀 있으면 마지막 몇 px이 되살아난 패널 글라이드를 탄다.
  const stop = (event: TransitionEvent) => {
    if (!isSideBarWidthTransition(event)) return;
    deferredClear?.();
    deferredClear = afterNextFrame(() => {
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
    const card = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`.${SIDE_BAR_CLASS}`);
    let driver = card ? followDriverFor(card) : null;
    if (!card || !driver) {
      setFollowed(null);
      return;
    }
    // 지금 구동의 출발 인셋과, 마지막으로 커밋한 인셋. 구동이 바뀌면(아래 인계) 보이는 자리에서 다시 출발한다.
    let fromInset = shownRef.current;
    let lastInset = fromInset;
    // 진행을 읽을 수 없으면(끊긴 전환) 지금 자리를 지킨다 — 목표는 finish만 세운다.
    const insetNow = (current: FollowDriver) => {
      const progress = current.progress();
      if (progress === null) return lastInset;
      return fromInset + Math.min(1, Math.max(0, progress)) * (targetInset - fromInset);
    };
    let active = true;
    let frame = 0;
    const commit = (inset: number | null) => {
      if (inset !== null) lastInset = inset;
      // rAF·약속 콜백의 갱신은 기본 우선순위로 미뤄져 페인트보다 늦을 수 있다 — 같은 프레임에 커밋한다.
      flushSync(() => setFollowed(inset));
    };
    let handover = 0;
    const tick = () => {
      frame = requestAnimationFrame(() => {
        if (!active || !driver) return;
        // 끝난 프레임에 바로 목표를 세운다 — finished 약속은 이 프레임보다 늦게 풀릴 수 있고, 그사이 억제
        // 플래그가 걷히면 마지막 몇 px이 패널 글라이드를 탄다.
        if (driver.done()) {
          finish();
          return;
        }
        commit(insetNow(driver));
        tick();
      });
    };
    const finish = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(handover);
      // 최종 인셋은 동기로 커밋한다 — 억제 플래그는 한 프레임 뒤에 걷히므로 그 전에 서야 마지막 몇 px이
      // 되살아난 패널 글라이드를 타지 않는다.
      commit(null);
      driver?.release(true);
    };
    // 타던 카드 전환이 끝나지 않고 끊기면 목표로 건너뛰지 않는다. 끊김은 두 갈래다.
    // - 되돌리기: 카드 클래스가 먼저 바뀌어 옛 전환이 끊기고, 새 목표 인셋은 같은 프레임 안에 뒤따라 커밋된다.
    //   그 사이 옛 목표로 한 걸음이라도 가면 패널이 닫힌 자리로 떨어졌다 돌아온다.
    // - 목표는 그대로인데 카드가 폭을 되돌림(⌘B로 접었는데 포인터가 엣지에 남아 픽이 폭을 붙듦 등): 카드에
    //   실을 전환이 없다.
    // 그래서 끊기면 그 자리를 지키고 다음 프레임에 판정한다. 그때까지 목표가 바뀌었으면 이 effect는 이미
    // 걷혔고 새 effect가 보이는 인셋에서 출발한다. 아니면 보이는 인셋에서 새 구동(되돌린 전환이나 탐침)으로
    // 넘긴다. 전환이 꺼진 경우에만 목표가 즉시 선다.
    const follow = (current: FollowDriver) => {
      current.finished.then(
        () => { if (driver === current) finish(); },
        () => {
          if (!active || driver !== current) return;
          cancelAnimationFrame(handover);
          handover = requestAnimationFrame(() => {
            if (!active || driver !== current) return;
            const next = followDriverFor(card);
            if (!next) {
              finish();
              return;
            }
            fromInset = lastInset;
            driver = next;
            current.release(false);
            follow(next);
          });
        },
      );
    };
    // 첫 커밋은 이 layout effect 안이라 동기 재렌더로 충분하다(flushSync는 커밋 중에 부를 수 없다).
    setFollowed(fromInset);
    tick();
    follow(driver);
    return () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(handover);
      driver?.release(false);
    };
  }, [targetInset]);
  const shown = followed ?? targetInset;
  // 다음 토글의 출발점은 지금 화면에 선 인셋이다 — 전환 도중 되돌려도 그 자리에서 이어진다.
  useLayoutEffect(() => {
    shownRef.current = shown;
  });
  return shown;
}

/** 이 값 이하의 진행이면 이 커밋이 막 연 전환으로 본다. */
const FRESH_TRANSITION_PROGRESS = 0.001;

interface FollowDriver {
  /** 이 추종이 시작된 뒤의 진행(0→1, 곡선 적용). 끝났으면 null. */
  readonly progress: () => number | null;
  readonly finished: Promise<unknown>;
  /** 구동이 끝까지 진행했는가(끊김은 아니다). */
  readonly done: () => boolean;
  /** 추종이 끝나거나 끊길 때 한 번. settled면 플래그를 한 프레임 뒤에 놓는다. */
  readonly release: (settled: boolean) => void;
}

/**
 * 인셋을 무엇에 실어 움직일지 고른다.
 *
 * - 이 커밋이 막 연 width 전환(진행 0)이면 그 전환을 탄다 — 인셋이 카드와 같은 곡선으로 함께 간다.
 * - 이미 진행 중이던 전환(엣지 호버 픽이 먼저 연 폭)을 잡았거나, 전환이 없는데 카드가 보이면(픽으로 다
 *   펼쳐진 카드를 고정) 카드의 남은 진행에 인셋을 실을 수 없다. 남은 짧은 구간에 인셋 전체를 몰면 첫
 *   프레임부터 큰 걸음이 된다. 그래서 카드의 width 전환과 같은 길이·곡선의 빈 애니메이션을 탐침으로 새로
 *   굴려 그 진행을 쓴다 — 캔버스가 카드보다 조금 늦게 끝나도 걸음은 일반 토글과 같다. 그동안 패널
 *   글라이드 억제 플래그를 직접 붙든다.
 * - 전환이 꺼진 경우(드래그 리사이즈·reduced motion)에만 목표 인셋이 즉시 선다.
 */
function followDriverFor(card: HTMLElement): FollowDriver | null {
  if (typeof card.getAnimations !== "function") return null;
  // getAnimations()가 스타일을 확정하므로 이 커밋이 연 width 전환이 여기서 잡힌다 — 첫 프레임부터 따라간다.
  const running = typeof CSSTransition === "undefined" ? undefined : card.getAnimations().find((animation) => animation instanceof CSSTransition
    && animation.transitionProperty === "width"
    && animation.playState !== "finished");
  if (running && (effectProgress(running) ?? 0) <= FRESH_TRANSITION_PROGRESS) {
    return { progress: () => effectProgress(running), finished: running.finished, done: () => running.playState === "finished", release: () => undefined };
  }
  if (typeof card.animate !== "function") return null;
  const timing = widthTransitionTiming(card);
  if (!timing) return null;
  let probe: Animation;
  try {
    probe = card.animate(null, timing);
  } catch {
    return null;
  }
  followHolds += 1;
  syncAnimatingFlag();
  let released = false;
  return {
    progress: () => effectProgress(probe),
    finished: probe.finished,
    done: () => probe.playState === "finished",
    release: (settled) => {
      if (released) return;
      released = true;
      probe.cancel();
      const drop = () => {
        followHolds = Math.max(0, followHolds - 1);
        syncAnimatingFlag();
      };
      if (settled) afterNextFrame(drop);
      else drop();
    },
  };
}

function effectProgress(animation: Animation): number | null {
  const progress = animation.effect?.getComputedTiming().progress;
  return typeof progress === "number" ? progress : null;
}

/** 카드의 width 전환 길이·곡선 — CSS가 소유한 값을 읽기만 한다. 전환이 꺼져 있으면 null. */
function widthTransitionTiming(card: HTMLElement): { readonly duration: number; readonly easing: string } | null {
  const computed = getComputedStyle(card);
  const properties = computed.transitionProperty.split(",").map((value) => value.trim());
  const index = properties.findIndex((property) => property === "width" || property === "all");
  if (index < 0) return null;
  const pick = (list: string) => {
    const values = splitTopLevel(list);
    return values[index % values.length] ?? "";
  };
  const duration = parseSeconds(pick(computed.transitionDuration));
  if (duration <= 0) return null;
  return { duration, easing: pick(computed.transitionTimingFunction) || "ease" };
}

/** cubic-bezier(…) 안의 쉼표를 가르지 않는 목록 분리. */
function splitTopLevel(list: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      values.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function parseSeconds(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim());
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]!);
  return match[2] === "s" ? amount * 1000 : amount;
}
