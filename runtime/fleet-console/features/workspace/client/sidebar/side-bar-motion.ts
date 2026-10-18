import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

const SIDE_BAR_CLASS = "operations-side-bar";

/**
 * 사이드바가 width 전환으로 폭을 바꾸는 동안(좁은 창의 아바타 열 전환) 대화 칸의 왼쪽 인셋이 사이드바를 매 프레임 따라가게 한다.
 *
 * 사이드바는 가운데 칸 위의 부유 카드라, 스토어의 폭 상태로 계산한 인셋은 바뀌는 즉시
 * 최종값이 된다. 그러면 대화 칸이 첫 프레임에 최종 자리로 순간 이동하고,
 * 카드만 --duration-base 동안 제 폭을 줄이거나 늘린다. 도킹 시절에는 중앙 트랙의 리플로우가 이 추종을 공짜로
 * 해 주었다 — 여기서는 카드의 실제 진행을 읽어 같은 추종을 되살린다.
 *
 * 인셋은 카드 폭 자체가 아니라 카드 width 전환의 진행률로 옛 인셋에서 새 인셋까지 보간한다. 인셋은
 * 폭 + 여백이라, 폭을 그대로 쓰면 여백만큼 어긋난다. 전환 길이·곡선은
 * CSS가 소유하고 여기서는 읽기만 한다. 전환이 없으면
 * (드래그 리사이즈·reduced motion) 목표 인셋이 그대로 선다. 대화 칸은 인셋을 따라가고,
 * 터미널 refit은 사이드바가 멈춘 뒤에 걸린다.
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
    // - 목표는 그대로인데 카드가 폭을 되돌림: 카드에 실을 전환이 없다.
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
  /** 추종이 끝나거나 끊길 때 탐침 자원을 회수한다. */
  readonly release: (settled: boolean) => void;
}

/**
 * 인셋을 무엇에 실어 움직일지 고른다.
 *
 * 카드가 움직이는 축은 width다 — 접기·펼치기·픽. 같은 요소에 translate·transform 전환이 열려 있으면
 * width를 먼저 따른다. 인셋은 지금 카드를 실제로 옮기는 쪽을 따라야 카드와 틈·겹침이 없다.
 *
 * - 이 커밋이 막 연 width·translate·transform 전환(진행 0)이면 그 전환을 탄다 — 인셋이 카드와 같은 길이·
 *   곡선으로 함께 간다.
 * - 이미 진행 중이던 전환(엣지 호버 픽이 먼저 연 폭)을 잡았거나, 전환이 없는데 카드가 보이면(픽으로 다
 *   펼쳐진 카드를 고정) 카드의 남은 진행에 인셋을 실을 수 없다. 남은 짧은 구간에 인셋 전체를 몰면 첫
 *   프레임부터 큰 걸음이 된다. 그래서 빈 애니메이션을 탐침으로 새로 굴려 그 진행을 쓴다 — 대화 칸이 카드보다
 *   조금 늦게 끝나도 걸음은 일반 토글과 같다. 탐침의 길이·곡선은 잡힌 전환 축의 것을, 없으면 width 전환의
 *   것을 쓴다.
 * - 전환이 꺼진 경우(드래그 리사이즈·reduced motion)에만 목표 인셋이 즉시 선다.
 */
function followDriverFor(card: HTMLElement): FollowDriver | null {
  // 드래그 리사이즈는 전환이 꺼져 있어 탈 것이 없다 — 매 픽셀 getAnimations()로 스타일을 확정하면 끌기 프레임마다
  // 문서 스타일 계산을 한 번 더 강제한다.
  if (card.dataset.resizing === "true" || typeof card.getAnimations !== "function") return null;
  // getAnimations()가 스타일을 확정하므로 이 커밋이 연 전환이 여기서 잡힌다 — 첫 프레임부터 따라간다.
  const moving = typeof CSSTransition === "undefined" ? [] : card.getAnimations().filter((animation): animation is CSSTransition => animation instanceof CSSTransition
    && CARD_MOTION_PROPERTIES.includes(animation.transitionProperty)
    && animation.playState !== "finished");
  // 같은 커밋에 여러 축이 움직이면 width를 먼저 본다 — 일반 경로의 기존 동작 그대로다.
  const running = CARD_MOTION_PROPERTIES.map((property) => moving.find((animation) => animation.transitionProperty === property))
    .find((animation) => animation !== undefined);
  if (running && (effectProgress(running) ?? 0) <= FRESH_TRANSITION_PROGRESS) {
    return { progress: () => effectProgress(running), finished: running.finished, done: () => running.playState === "finished", release: () => undefined };
  }
  if (typeof card.animate !== "function") return null;
  const timing = cardTransitionTiming(card, running?.transitionProperty ?? "width");
  if (!timing) return null;
  let probe: Animation;
  try {
    probe = card.animate(null, timing);
  } catch {
    return null;
  }
  return {
    progress: () => effectProgress(probe),
    finished: probe.finished,
    done: () => probe.playState === "finished",
    release: () => probe.cancel(),
  };
}

/** 카드를 옮기는 전환 축 — 앞쪽이 우선이다. */
const CARD_MOTION_PROPERTIES: readonly string[] = ["width", "translate", "transform"];

function effectProgress(animation: Animation): number | null {
  const progress = animation.effect?.getComputedTiming().progress;
  return typeof progress === "number" ? progress : null;
}

/** 카드의 한 축(width·translate 등) 전환 길이·곡선·지연 — CSS가 소유한 값을 읽기만 한다. 전환이 꺼져 있으면 null. */
function cardTransitionTiming(card: HTMLElement, property: string): { readonly duration: number; readonly easing: string; readonly delay: number } | null {
  const computed = getComputedStyle(card);
  const properties = computed.transitionProperty.split(",").map((value) => value.trim());
  const index = properties.findIndex((candidate) => candidate === property || candidate === "all");
  if (index < 0) return null;
  const pick = (list: string) => {
    const values = splitTopLevel(list);
    return values[index % values.length] ?? "";
  };
  const duration = parseSeconds(pick(computed.transitionDuration));
  if (duration <= 0) return null;
  return { duration, easing: pick(computed.transitionTimingFunction) || "ease", delay: parseSeconds(pick(computed.transitionDelay)) };
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
