import * as React from "react";
import { createPortal } from "react-dom";

import { MobileSheet } from "../../../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { pushBackLayer } from "../../../../../core/client/src/chrome/mobile/mobile-back.js";
import { useT } from "../../../../../core/client/src/i18n/index.js";
import type { ContextRailScope, ContextRailSession } from "../../../shared/context-rail.js";
import { ContextArc, ContextCard, RailGlyph, chipLabel, percentOf, ratioOf, toneOf } from "./rail.js";
import { useContextRailProviders } from "./registry.js";
import { setContextRailEnabled, useContextRailState } from "./store.js";

/**
 * 모바일 화면의 컨텍스트 레일. 대화 머리에 지금 세션의 원호 칩 하나와 ▥ 단추가 서고, 칩을 누르면 아래 시트에 세션별 카드가 올라온다
 * (데스크톱과 같은 카드). 어느 대화를 보는지는 화면이 `useMobileContextRailScope`로 알린다 — 모바일 셸은 데스크톱의 대화 칸이 아니다.
 */
let scope: ContextRailScope | null = null;
let scopeKey = "";
const listeners = new Set<() => void>();

function publishScope(next: ContextRailScope | null): void {
  const key = next === null ? "" : JSON.stringify(next);
  if (key === scopeKey) return;
  scope = next;
  scopeKey = key;
  for (const listener of listeners) listener();
}

/** 이 화면이 보이는 동안 레일이 읽을 대화를 알린다. `null`이면 이 화면은 레일이 없다. 화면이 내려가면 거둔다. */
export function useMobileContextRailScope(next: ContextRailScope | null): void {
  const key = next === null ? "" : JSON.stringify(next);
  React.useEffect(() => {
    publishScope(next);
    return () => { if (scopeKey === key) publishScope(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key 가 next 의 값 동일성이다.
  }, [key]);
}

function useScope(): ContextRailScope | null {
  return React.useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => scope,
    () => null,
  );
}

/** 모바일 상단 막대(또는 자기 머리를 그리는 화면)에 놓는다. 이 화면에 레일이 없으면 아무것도 그리지 않는다. */
export function MobileContextRail({ scope: given }: { readonly scope?: ContextRailScope } = {}): React.ReactNode {
  const stored = useScope();
  // 앱 틀의 막대 밖에서 자기 머리를 그리는 화면은 범위를 직접 건넨다.
  const current = given ?? stored;
  const providers = useContextRailProviders();
  if (current === null) return null;
  return <>{providers.map((Provider, index) => (
    <Provider key={index} scope={current}>
      {(sessions) => sessions.length > 0 ? <MobileChip sessions={sessions} /> : null}
    </Provider>
  ))}</>;
}

function MobileChip({ sessions }: { readonly sessions: readonly ContextRailSession[] }) {
  const t = useT();
  const state = useContextRailState();
  const [open, setOpen] = React.useState(false);
  const anchor = React.useRef<HTMLButtonElement | null>(null);
  // 열린 시트는 뒤로가 가장 먼저 닫는 겹침이다.
  React.useEffect(() => (open ? pushBackLayer(() => setOpen(false)) : undefined), [open]);
  const ordered = React.useMemo(() => [...sessions.filter((session) => session.focus), ...sessions.filter((session) => !session.focus)], [sessions]);
  const lead = ordered[0]!;
  const label = chipLabel(lead, t);
  const toggleLabel = t(state.enabled ? "conversation.rail.hide" : "conversation.rail.show");
  return (
    <>
      {state.enabled ? (
        <button
          ref={anchor}
          type="button"
          className={`context-rail-hchip is-mobile${lead.measure?.stale ? " is-stale" : ""}${toneOf(lead.measure)}`}
          aria-expanded={open}
          aria-label={label}
          title={label}
          onClick={() => setOpen(true)}
        >
          <ContextArc ratio={ratioOf(lead.measure)} size={14} />
          <span>{lead.measure ? `${percentOf(lead.measure)}%` : "—"}</span>
        </button>
      ) : null}
      <button
        type="button"
        className="context-rail-toggle is-mobile"
        aria-pressed={state.enabled}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => { setOpen(false); setContextRailEnabled(!state.enabled); }}
      >
        <RailGlyph />
      </button>
      {open && state.enabled ? createPortal(
        <MobileSheet title={t("conversation.rail.title")} onClose={() => setOpen(false)}>
          <div className="context-rail-sheet">
            {ordered.map((session) => <ContextCard key={session.id} session={session} open forced state={state} t={t} />)}
          </div>
        </MobileSheet>,
        // 시트는 가장 가까운 위치 기준 조상에 붙는다 — 막대 안이 아니라 화면 틀(또는 자기 머리를 그리는 TaskForce 화면)이어야 한다.
        anchor.current?.closest<HTMLElement>(".taskforce-mobile-screen, .mobile-frame") ?? document.body,
      ) : null}
    </>
  );
}
