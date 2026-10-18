import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { ConversationPillTakeover } from "./conversation-slots.js";
import "./pill-takeover.css";

/**
 * 머리 pill 의 잠깐 바뀐 내용(`publishConversationPillTakeover`)을 pill 안에서 갈아 끼우는 문법 — 데스크톱 맨 위 줄 pill 과 모바일
 * 상단 막대 pill 이 함께 쓴다. 바뀔 때 원래 내용과 바뀐 내용이 크로스페이드하고(데스크톱은 pill 폭도 함께 따라간다), 박자는 본문
 * 대화 화면의 밀기 전환(340ms)과 같다. 움직임 줄이기면 바로 바뀐다.
 *
 * pill 은 바뀐 동안 원래 내용을 단추째 inert 로 두고 바뀐 내용을 제목 단추 밖의 형제로 세운다 — 단추 안에 단추를 겹치지 않는다.
 */
export const PILL_MORPH_MS = 340;
const PILL_MORPH_EASE = "cubic-bezier(.22, .8, .24, 1)";

const reducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** `in` — 바뀐 내용이 섰다. `out` — 원래 내용으로 돌아가는 중(바뀐 내용이 흐려지며 남는다). `idle` — 원래 내용뿐이다. */
export type PillTakeoverPhase = "idle" | "in" | "out";

/** 바뀐 내용과 그 단계 — 되돌아갈 때는 사라진 내용을 전환 길이만큼 붙들어 흐려지게 한다. */
export function usePillTakeoverPhase(takeover: ConversationPillTakeover | null): { readonly shown: ConversationPillTakeover | null; readonly phase: PillTakeoverPhase } {
  const [previous, setPrevious] = useState(takeover);
  const [leaving, setLeaving] = useState<ConversationPillTakeover | null>(null);
  // 렌더 중에 고친다 — 한 번이라도 「없음」으로 커밋하면 바뀐 내용이 내려갔다 다시 서서 흐려지는 전환을 잃는다.
  if (previous !== takeover) {
    setPrevious(takeover);
    setLeaving(takeover === null && previous !== null && !reducedMotion() ? previous : null);
  }
  useEffect(() => {
    if (leaving === null) return;
    const timer = window.setTimeout(() => setLeaving(null), PILL_MORPH_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  if (takeover) return { shown: takeover, phase: "in" };
  if (leaving) return { shown: leaving, phase: "out" };
  return { shown: null, phase: "idle" };
}

/** pill 안의 바뀐 내용 칸 — 흐려지며 나가는 동안은 inert 다. 내용이 바뀌면(`key`) 새로 선다. */
export function PillTakeoverLayer({ shown, phase }: { readonly shown: ConversationPillTakeover | null; readonly phase: PillTakeoverPhase }) {
  if (!shown) return null;
  return (
    <span key={shown.key} className={`conversation-pill-takeover is-${phase}`} role="group" aria-label={shown.label} inert={phase === "out" || undefined}>
      {shown.content}
    </span>
  );
}

/**
 * pill 폭을 바뀐 내용에 맞춰 부드럽게 옮긴다(FLIP) — 바뀌기 전 폭에서 새 내용의 제 폭으로, 끝나면 폭 고정을 걷는다. 전환 중에 다시
 * 바뀌면 지금 폭에서 이어 간다. `key` 는 바뀐 내용이 선 동안의 정체이고 원래 내용이면 null 이다.
 */
export function usePillMorphWidth(ref: RefObject<HTMLElement | null>, key: string | null): void {
  const width = useRef(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    width.current = element.getBoundingClientRect().width;
    if (typeof ResizeObserver === "undefined") return;
    // 폭을 붙든 동안(전환 중)의 크기 변화는 기준 폭이 아니다.
    const observer = new ResizeObserver(() => { if (!element.style.width) width.current = element.getBoundingClientRect().width; });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!mounted.current) { mounted.current = true; return; }
    if (!element) return;
    const from = element.style.width ? element.getBoundingClientRect().width : width.current;
    element.style.transition = "none";
    element.style.width = "";
    const to = element.getBoundingClientRect().width;
    if (reducedMotion() || Math.abs(to - from) < 0.5) { element.style.transition = ""; width.current = to; return; }
    element.style.width = `${from}px`;
    void element.offsetWidth;
    element.style.transition = `width ${PILL_MORPH_MS}ms ${PILL_MORPH_EASE}`;
    element.style.width = `${to}px`;
    const timer = window.setTimeout(() => {
      element.style.width = "";
      element.style.transition = "";
      width.current = element.getBoundingClientRect().width;
    }, PILL_MORPH_MS + 40);
    return () => window.clearTimeout(timer);
  }, [key, ref]);
}
