import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { TheaterAvatar } from "../../../../../features/workspace/client/theater-avatar.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { featuredDestinationBinding, useMobileDestinationBindings, useMobileDestinationTrailing } from "./mobile-destinations.js";
import { setMobileDestination } from "./mobile-store.js";

/**
 * 홈의 대표 자리 — 머리·바로가기 칩과 확인 필요 묶음 사이. 지금 Theater의 상태를 말하는 목적지(`destination.trailing`을 선언하고 shown인 것, 사령관)가
 * 있으면 Theater의 사령관 아바타(`TheaterAvatar`, 얼굴은 플러그인이 머리 표식과 함께 준 것)와 그 목적지의 이름·상태 한 줄로 서고, 누르면 그
 * 목적지 화면이 열린다(‹와 뒤로는 홈으로). 없으면 같은 아바타와 Theater 이름·대화 수다.
 * 계약은 `RailEntryMobile.destination`의 order·shown·trailing 소비뿐이고, 어떤 플러그인이 설지는 읽지 않는다.
 */
export function MobileHomeFeatured({ state, conversationCount }: { readonly state: ConsoleState; readonly conversationCount: number }) {
  const t = useT();
  const locale = useConsoleLocale();
  const bindings = useRailEntries();
  const shown = useMobileDestinationBindings(bindings, state.activeTheaterId);
  const trailing = useMobileDestinationTrailing(bindings, state.activeTheaterId);
  const theater = state.theaters.find((item) => item.id === state.activeTheaterId) ?? null;
  if (theater === null) return null;
  const featured = featuredDestinationBinding(shown);
  if (featured === null) {
    return (
      <div className="mobile-conv-hero">
        <TheaterAvatar theaterId={theater.id} size={88} label="" decorative />
        <strong>{theater.label}</strong>
        <small>{t("mobile.list.heroSub", { count: conversationCount })}</small>
      </div>
    );
  }
  const status = trailing.get(featured.entry.id) ?? null;
  const name = resolveLocalizedText(featured.entry.mobile?.destination?.label ?? featured.entry.title, locale);
  return (
    <button type="button" data-press="r1" className="mobile-conv-hero is-featured" onClick={() => setMobileDestination({ kind: "plugin", entryId: featured.entry.id })}>
      <TheaterAvatar theaterId={theater.id} size={88} label={name} decorative />
      <strong>{name}</strong>
      <small className={status?.tone ? `is-${status.tone}` : undefined}>{status?.text ?? ""}</small>
    </button>
  );
}
