import { useEffect, useRef, useState, type ReactNode } from "react";

import { useT } from "../../i18n/index.js";

/**
 * 모바일은 짧은 끊김을 말하지 않는다. 폰의 원격 연결은 잠금·망 전환·콘솔 재기동으로 자주 끊겼다가
 * 자동 재연결이 몇 초 안에 메운다 — 그 사이마다 상단에 「연결하지 못했어요」나 「목표 활동 상태를
 * 확인할 수 없어요」가 섰다 사라지면 화면이 고장처럼 보이고, 사람이 할 수 있는 일도 없다.
 * 그래서 이 시간을 넘겨 이어진 끊김만 띠로 말한다. 그때는 자동 회복이 늦어지고 있어 사람이
 * 「다시 연결」을 누를 이유가 생긴다. 백오프(1·2·4·8초…)의 처음 세 번 시도가 이 안에 든다.
 * 그 전이라도 사람이 화면을 탭하면 바로 말한다(`useTappedSince`).
 */
export const MOBILE_QUIET_MS = 10_000;

/** `since`부터 `holdMs`가 지났는가 — 지나는 순간에 다시 그린다. `since`가 null이면 false다. */
export function useHeldFor(since: number | null, holdMs: number): boolean {
  const [, wake] = useState(0);
  const held = since !== null && Date.now() - since >= holdMs;
  useEffect(() => {
    if (since === null || held) return;
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, since + holdMs - Date.now()));
    return () => clearTimeout(timer);
  }, [since, held, holdMs]);
  return held;
}

/**
 * `since`부터 사람이 화면을 탭했는가(끌어 스크롤한 것은 세지 않는다). 끊긴 동안의 입력칸·버튼은 잠겨
 * 있어 누르면 아무 일도 일어나지 않는다 — 조용히 기다리는 것은 읽는 동안뿐이고, 무언가 하려는 순간에는
 * 기다리지 않고 이유를 말해야 한다. 잠긴 컨트롤에는 click이 오지 않으므로 포인터를 직접 듣는다.
 */
export function useTappedSince(since: number | null): boolean {
  const [tappedFor, setTappedFor] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    let start: { readonly x: number; readonly y: number } | null = null;
    const down = (event: PointerEvent) => { start = { x: event.clientX, y: event.clientY }; };
    const up = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10) setTappedFor(since);
      start = null;
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
    };
  }, [since]);
  return since !== null && tappedFor === since;
}

/** `active`가 마지막으로 참이 된 시각. 거짓이 되면 null로 돌아간다. */
export function useActiveSince(active: boolean): number | null {
  const since = useRef<number | null>(null);
  if (!active) since.current = null;
  else if (since.current === null) since.current = Date.now();
  return since.current;
}

/**
 * 연결 띠(S-34, 모바일): 한 줄. 재연결 중에는 「연결이 끊겼습니다 · 다시 연결하는 중…」이고 동작이 없다.
 * 실패했을 때만 「연결하지 못했습니다」와 오른쪽 「다시 연결」(`children`)이 선다. 주체(Objective·Theater)가 없는 상태라 아바타를 세우지 않고 글이 말한다.
 * 띠를 세울지는 부르는 쪽이 `MOBILE_QUIET_MS`로 정한다 — 한 번 선 띠는 연결이 돌아올 때까지 남아 「다시 연결」의 피드백을 보인다.
 */
export function MobileConnectionBand({ failed, children }: { readonly failed: boolean; readonly children: ReactNode }) {
  const t = useT();
  return (
    <div className="console-link-banner mobile-connection-band" role="status" aria-live="polite">
      <span>{t(failed ? "mobile.band.failed" : "mobile.band.reconnecting")}</span>
      {failed ? children : null}
    </div>
  );
}
