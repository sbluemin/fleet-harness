import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleTheaterSummary, TheaterContribution, TheaterFace } from "@fleet-console/sdk/plugin";
import type { TheaterInboxAddress } from "@fleet-console/sdk/theater-inbox";
import type { MongleState } from "@fleet-console/sdk/avatars";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";
import { scopedTheaterInbox } from "./theater-inbox/scoped.js";

interface TheaterContributionProps {
  readonly theater: ConsoleTheaterSummary;

}

/**
 * 플러그인이 Theater 머리 바로 아래에 세우는 줄. 한 기여의 실패가 Theater 목록을 비우지 않도록 각각 경계로 감싸고,
 * 아무도 그리지 않으면 자리도 없다.
 */
export function TheaterContributionRows({ theater }: TheaterContributionProps) {
  const { theaterContributions } = usePluginRegistry();
  const language = useConsoleLocale();
  const rows = theaterContributions.filter((contribution) => contribution.row);
  if (rows.length === 0) return null;
  const base = { theater: { id: theater.id, label: theater.label }, active: true, language };
  return (
    <div className="side-bar-theater-contributions" data-theater-id={theater.id}>
      {rows.map((contribution) => (
        <PluginErrorBoundary key={contribution.id} fallback={<></>}>
          {contribution.row?.({ ...base, theaterInbox: scopedTheaterInbox(contribution.id) })}
        </PluginErrorBoundary>
      ))}
    </div>
  );
}

/** Theater 동작(우클릭·Shift+F10) 메뉴의 플러그인 항목 — 호스트의 시스템 프롬프트 항목 다음, 호스트의 구분선 앞에 선다. */
export function TheaterContributionMenuItems({ theater, onClose }: TheaterContributionProps & { readonly onClose: () => void }) {
  const { theaterContributions } = usePluginRegistry();
  const language = useConsoleLocale();
  const menus = theaterContributions.filter((contribution) => contribution.menu);
  if (menus.length === 0) return null;
  const base = { theater: { id: theater.id, label: theater.label }, active: true, language, onClose };
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

const NOTHING = () => () => undefined;

/** 머리 기여들의 구독을 하나로 묶는다 — 어느 기여든 깨우면 머리가 다시 읽는다. */
function useHeaderSubscription(contributions: readonly TheaterContribution[]): (listener: () => void) => () => void {
  return useMemo(() => {
    const headers = contributions.flatMap((contribution) => (contribution.header ? [contribution.header] : []));
    if (headers.length === 0) return NOTHING;
    return (listener: () => void) => {
      const offs = headers.map((header) => { try { return header.subscribe(listener); } catch { return () => undefined; } });
      return () => { for (const off of offs) off(); };
    };
  }, [contributions]);
}

/**
 * 머리 표식 — 이니셜 칩 자리에 서는 플러그인 표식(예: 자율 운영의 사령관 글리프). 처음으로 표식을 돌려준 기여가 이긴다.
 * 아무도 돌려주지 않으면 null 이고, 머리는 이니셜 칩을 그대로 세운다.
 */
export function useTheaterContributionMark(theater: ConsoleTheaterSummary): ReactNode | null {
  const { theaterContributions } = usePluginRegistry();
  const language = useConsoleLocale();
  const marks = useMemo(() => theaterContributions.filter((contribution) => contribution.mark), [theaterContributions]);
  const subscribe = useHeaderSubscription(marks);
  // 표식을 고르는 일은 구독이 깨울 때마다 다시 한다. 스냅숏은 「어느 기여가 그리는가」라는 id 하나다(같은 값이면 다시 그리지 않는다).
  const pick = useCallback(() => {
    for (const contribution of marks) {
      try {
        if (contribution.mark?.({ theater, active: true, language, theaterInbox: scopedTheaterInbox(contribution.id) }) != null) return contribution.id;
      } catch {
        // 한 기여의 실패는 다음 기여에게 자리를 넘긴다.
      }
    }
    return null;
  }, [marks, theater, language]);
  const ownerId = useSyncExternalStore(subscribe, pick, pick);
  const owner = ownerId === null ? null : marks.find((contribution) => contribution.id === ownerId) ?? null;
  if (!owner?.mark) return null;
  return (
    <PluginErrorBoundary fallback={<></>}>
      {owner.mark({ theater, active: true, language, theaterInbox: scopedTheaterInbox(owner.id) })}
    </PluginErrorBoundary>
  );
}

/**
 * 그 Theater 사령관 아바타의 지금 얼굴 — 머리 표식과 같은 사실(상태 얼굴과 꺼짐)을 기여가 값으로 준다(`header.face`). 처음으로
 * 얼굴을 돌려준 기여가 이기고, 아무도 돌려주지 않으면 null 이다(호스트의 쉼 얼굴). 표식과 같은 구독으로 다시 읽는다.
 */
export function useTheaterContributionFace(theaterId: string): TheaterFace | null {
  const { theaterContributions } = usePluginRegistry();
  const faces = useMemo(() => theaterContributions.filter((contribution) => contribution.header?.face), [theaterContributions]);
  const subscribe = useHeaderSubscription(faces);
  // 기여는 읽을 때마다 새 객체를 줄 수 있다 — 스냅숏은 값을 이은 문자열이라 같은 얼굴이면 다시 그리지 않는다.
  const read = useCallback(() => {
    for (const contribution of faces) {
      try {
        const face = contribution.header?.face?.(theaterId);
        if (face != null) return `${face.state}${face.off ? ":off" : ""}`;
      } catch {
        // 한 기여의 실패는 다음 기여에게 자리를 넘긴다.
      }
    }
    return null;
  }, [faces, theaterId]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    if (snapshot === null) return null;
    const [state, off] = snapshot.split(":");
    return { state: state as MongleState, off: off === "off" };
  }, [snapshot]);
}

/** 이 Theater 의 운영자가 일하는 중인가 — 머리는 Theater 이름에 라이브 물결을 흘린다. */
export function useTheaterHeaderLive(theaterId: string): boolean {
  const { theaterContributions } = usePluginRegistry();
  const lives = useMemo(() => theaterContributions.filter((contribution) => contribution.header?.live), [theaterContributions]);
  const subscribe = useHeaderSubscription(lives);
  const read = useCallback(() => lives.some((contribution) => {
    try { return contribution.header?.live?.(theaterId) === true; } catch { return false; }
  }), [lives, theaterId]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * 머리가 여는 Theater Inbox 칸 — 기여가 정한 칸(정준 id)이 먼저이고, 아무도 정하지 않으면 null(호스트의 시스템 프롬프트 칸).
 * 누르는 순간에 한 번 읽는다.
 */
export function resolveTheaterInboxLanding(contributions: readonly TheaterContribution[], theaterId: string): TheaterInboxAddress | null {
  for (const contribution of contributions) {
    const landing = contribution.header?.landing;
    if (!landing) continue;
    let address: TheaterInboxAddress | null = null;
    try { address = landing(theaterId); } catch { address = null; }
    if (!address) continue;
    // 기여 id 는 `<pluginId>:<id>` 다 — 그 플러그인의 섹션 id 에 같은 접두를 붙인다(scopedTheaterInbox 와 같은 규칙).
    const separator = contribution.id.indexOf(":");
    const prefix = separator > 0 ? contribution.id.slice(0, separator + 1) : "";
    return { sectionId: `${prefix}${address.sectionId}`, pageId: address.pageId };
  }
  return null;
}
