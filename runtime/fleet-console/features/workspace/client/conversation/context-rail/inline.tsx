import * as React from "react";

import { useT } from "../../../../../core/client/src/i18n/index.js";
import type { ContextRailScope, ContextRailSession } from "../../../shared/context-rail.js";
import { ContextArc, ContextCard, chipLabel, percentOf, ratioOf, toneOf } from "./rail.js";
import { useContextRailProviders } from "./registry.js";
import { useContextRailState } from "./store.js";

/**
 * 대화 칸의 레일이 서지 않는 화면(Inbox 시트)을 위한 원호 칩. 레일의 머리 칩과 같은 표현이고, 누르면 같은 컨텍스트 카드가 위로 뜬다.
 * 입력창 안의 원호를 되살리는 것이 아니라 입력창 위 줄에 따로 선다. 레일을 끈 사람의 선택은 여기서도 따른다.
 */
export function ContextRailInlineChip({ scope }: { readonly scope: ContextRailScope }): React.ReactNode {
  const providers = useContextRailProviders();
  const { enabled } = useContextRailState();
  if (!enabled) return null;
  return <>{providers.map((Provider, index) => (
    <Provider key={index} scope={scope}>
      {(sessions) => sessions.length > 0 ? <InlineChip sessions={sessions} /> : null}
    </Provider>
  ))}</>;
}

function InlineChip({ sessions }: { readonly sessions: readonly ContextRailSession[] }) {
  const t = useT();
  const state = useContextRailState();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onKeyDown, true); };
  }, [open]);
  const lead = sessions.find((session) => session.focus) ?? sessions[0]!;
  const label = chipLabel(lead, t);
  return (
    <div className="context-rail-inline" ref={wrapRef}>
      <button
        type="button"
        className={`context-rail-hchip${lead.measure?.stale ? " is-stale" : ""}${toneOf(lead.measure)}`}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((was) => !was)}
      >
        <ContextArc ratio={ratioOf(lead.measure)} size={14} />
        <span>{lead.measure ? `${percentOf(lead.measure)}%` : "—"}</span>
      </button>
      {open ? (
        <div className="context-rail-fly is-inline">
          {sessions.map((session) => <ContextCard key={session.id} session={session} open forced state={state} t={t} />)}
        </div>
      ) : null}
    </div>
  );
}
