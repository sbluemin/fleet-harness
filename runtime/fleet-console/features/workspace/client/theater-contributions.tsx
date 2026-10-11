import { useLayoutEffect, useRef } from "react";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleTheaterSummary } from "@fleet-console/sdk/plugin";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";
import { registerTheaterInboxReturnTarget } from "./theater-inbox/store.js";
import { scopedTheaterInbox } from "./theater-inbox/scoped.js";

interface TheaterContributionProps {
  readonly theater: ConsoleTheaterSummary;
  readonly active: boolean;
}

/**
 * 플러그인이 Theater 머리 바로 아래에 세우는 줄. 한 기여의 실패가 Theater 목록을 비우지 않도록 각각 경계로 감싸고,
 * 아무도 그리지 않으면 자리도 없다.
 */
export function TheaterContributionRows({ theater, active }: TheaterContributionProps) {
  const { theaterContributions } = usePluginRegistry();
  const language = useConsoleLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rows = theaterContributions.filter((contribution) => contribution.row);
  // Theater Inbox 를 닫을 때 입구가 사라졌으면(우클릭 메뉴의 항목 등) 이 Theater 의 머리로 포커스를 돌린다 — 시트가 사이드바를
  // 뒤지지 않게 머리를 여기서 넘긴다. 머리는 이 줄들과 같은 Theater 구역 안에 있다.
  useLayoutEffect(() => {
    const section = containerRef.current?.parentElement?.closest<HTMLElement>("[data-theater-id]") ?? null;
    if (!section) return;
    registerTheaterInboxReturnTarget(theater.id, () => section.querySelector<HTMLElement>(".side-bar-theater-activate"));
  }, [theater.id, rows.length]);
  if (rows.length === 0) return null;
  const base = { theater: { id: theater.id, label: theater.label }, active, language };
  return (
    <div ref={containerRef} className="side-bar-theater-contributions" data-theater-id={theater.id}>
      {rows.map((contribution) => (
        <PluginErrorBoundary key={contribution.id} fallback={<></>}>
          {contribution.row?.({ ...base, theaterInbox: scopedTheaterInbox(contribution.id) })}
        </PluginErrorBoundary>
      ))}
    </div>
  );
}

/** Theater 「…」 메뉴의 플러그인 항목 — 호스트의 시스템 프롬프트 항목 다음, 호스트의 구분선 앞에 선다. */
export function TheaterContributionMenuItems({ theater, active, onClose }: TheaterContributionProps & { readonly onClose: () => void }) {
  const { theaterContributions } = usePluginRegistry();
  const language = useConsoleLocale();
  const menus = theaterContributions.filter((contribution) => contribution.menu);
  if (menus.length === 0) return null;
  const base = { theater: { id: theater.id, label: theater.label }, active, language, onClose };
  return (
    <>
      {menus.map((contribution) => (
        <PluginErrorBoundary key={contribution.id} fallback={<></>}>
          {contribution.menu?.({ ...base, theaterInbox: scopedTheaterInbox(contribution.id) })}
        </PluginErrorBoundary>
      ))}
    </>
  );
}
