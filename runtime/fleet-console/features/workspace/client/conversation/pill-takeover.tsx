import { createContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import type { ConversationPillOwner, ConversationPillPort, ConversationPillTakeover } from "../../shared/conversation-pill.js";
import "./pill-takeover.css";

/** 머리를 실제로 세운 호스트만 자기 본문에 이 포트를 준다. 머리 없는 대화는 본문 칩으로 폴백한다. */
export const ConversationPillContext = createContext<ConversationPillPort | null>(null);

export function useConversationPillHost(owner: ConversationPillOwner | null, active = true): { readonly takeover: ConversationPillTakeover | null; readonly port: ConversationPillPort | null } {
  const ownerKey = owner ? `${owner.kind}:${owner.id}` : null;
  const [published, setPublished] = useState<{ readonly ownerKey: string | null; readonly token: symbol; readonly takeover: ConversationPillTakeover } | null>(null);
  const kind = owner?.kind;
  const id = owner?.id;
  const port = useMemo<ConversationPillPort | null>(() => {
    if (!active || !kind || !id) return null;
    return {
      owner: { kind, id },
      publish(takeover) {
        const token = Symbol("pill-takeover");
        setPublished({ ownerKey, token, takeover });
        return () => setPublished((current) => current?.token === token ? null : current);
      },
    };
  }, [active, kind, id, ownerKey]);
  return { port, takeover: active && published?.ownerKey === ownerKey ? published.takeover : null };
}

const OPEN_MS = 200;
const CLOSE_MS = 160;
/** 머리 줄의 도구 접기는 폭이 옮겨지는 동안 측정을 보류하고, 끝나면 다시 잰다. */
export const PILL_MORPHING_CLASS = "is-morphing";
const reducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type PillTakeoverPhase = "idle" | "in" | "out";

/** 닫는 동안 상대만 잠깐 붙들어, 주인은 그대로 두고 좁아지는 테두리 뒤로 상대가 사라지게 한다. */
function usePillTakeoverPhase(takeover: ConversationPillTakeover | null) {
  const [previous, setPrevious] = useState(takeover);
  const [leaving, setLeaving] = useState<ConversationPillTakeover | null>(null);
  if (previous !== takeover) {
    setPrevious(takeover);
    setLeaving(takeover === null && previous !== null && !reducedMotion() ? previous : null);
  }
  useLayoutEffect(() => {
    if (leaving === null) return;
    const timer = window.setTimeout(() => setLeaving(null), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const phase: PillTakeoverPhase = takeover ? "in" : leaving ? "out" : "idle";
  return { shown: takeover ?? leaving, phase };
}

/** 자동 폭의 이전 값에서 새 값으로 옮긴다. 중간에 방향이 바뀌어도 현재 실측 폭에서 이어 간다. */
function usePillMorphWidth(ref: RefObject<HTMLDivElement | null>, key: string | null, phase: PillTakeoverPhase, mobile: boolean): void {
  const width = useRef(0);
  const previous = useRef(key);
  const flipping = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const sync = (element: HTMLElement) => element.classList.toggle(PILL_MORPHING_CLASS, flipping.current || phaseRef.current === "out");
  useLayoutEffect(() => {
    if (ref.current && !mobile) sync(ref.current);
  }, [phase, ref, mobile]); // eslint-disable-line react-hooks/exhaustive-deps -- sync 는 ref 만 읽는다.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || mobile) return;
    width.current = element.getBoundingClientRect().width;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!element.style.width) width.current = element.getBoundingClientRect().width;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, mobile]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || mobile || previous.current === key) return;
    previous.current = key;
    const from = element.style.width ? element.getBoundingClientRect().width : width.current;
    element.style.transition = "none";
    element.style.width = "";
    const to = element.getBoundingClientRect().width;
    if (reducedMotion() || Math.abs(to - from) < 0.5) {
      element.style.transition = "";
      flipping.current = false;
      sync(element);
      width.current = to;
      return;
    }
    flipping.current = true;
    sync(element);
    element.style.width = `${from}px`;
    void element.offsetWidth;
    element.style.transition = `width ${phase === "in" ? 120 : CLOSE_MS}ms cubic-bezier(.2, 0, 0, 1)`;
    element.style.width = `${to}px`;
    const timer = window.setTimeout(() => {
      element.style.width = "";
      element.style.transition = "";
      flipping.current = false;
      sync(element);
      width.current = element.getBoundingClientRect().width;
    }, phase === "in" ? OPEN_MS : CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [key, ref, mobile]); // eslint-disable-line react-hooks/exhaustive-deps -- phase 는 같은 전환의 out → idle 때 폭 전환을 재시작하지 않는다.
}

/** 주인의 아바타·이름 DOM 은 바꾸지 않는다. 상대와 부가 제어만 같은 pill 안에서 접고 편다. */
export function ConversationPill({ takeover, label, onPress, children, controls, mobile = false }: {
  readonly takeover: ConversationPillTakeover | null;
  readonly label: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
  readonly controls?: ReactNode;
  readonly mobile?: boolean;
}) {
  const { shown, phase } = usePillTakeoverPhase(takeover);
  const taken = phase === "in";
  const ref = useRef<HTMLDivElement | null>(null);
  usePillMorphWidth(ref, taken ? shown?.key ?? null : null, phase, mobile);
  useLayoutEffect(() => {
    const element = ref.current;
    const peer = element?.querySelector<HTMLElement>(".conversation-pill-takeover");
    if (taken && element && peer) element.style.setProperty("--pill-peer-left", `${peer.offsetLeft}px`);
  }, [taken, shown?.key]);
  return (
    <div ref={ref} className={`${mobile ? "mobile-conv-pill" : "conversation-pill"} conversation-pill-host`} data-takeover={taken || undefined} data-phase={phase} id={shown?.id} role={shown ? "group" : undefined} aria-label={shown?.label} onKeyDown={taken ? shown?.onKeyDown : undefined}>
      <button type="button" className="conversation-pill-details" aria-label={taken ? shown?.ownerLabel : label} onClick={taken ? shown?.onOwnerPress : onPress} inert={(taken && !shown?.onOwnerPress) || undefined}>
        {children}
      </button>
      {controls ? <span className="conversation-pill-controls" inert={taken || undefined}>{controls}</span> : null}
      {shown ? <span className={`conversation-pill-takeover is-${phase}`} inert={phase === "out" || undefined}><span key={shown.key} className="conversation-pill-peer">{shown.content}</span></span> : null}
    </div>
  );
}
