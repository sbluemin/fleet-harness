import { theaterAvatarKey, type MongleState } from "@fleet-console/sdk/avatars";
import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { RailEntryDestinationTrailingValue } from "@fleet-console/sdk/rail";

import { KeyedAvatar } from "../../../../../features/workspace/client/avatars.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { featuredDestinationBinding, useMobileDestinationBindings, useMobileDestinationTrailing } from "./mobile-destinations.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { setMobileDestination } from "./mobile-store.js";

/**
 * 홈의 대표 자리 — 머리·바로가기 칩과 확인 필요 묶음 사이. 지금 Theater의 상태를 말하는 목적지(`destination.trailing`을 선언하고 shown인 것, 사령관)가
 * 있으면 그 목적지의 몽글 아바타와 상태 한 줄로 서고, 누르면 그 목적지 화면이 열린다(‹와 뒤로는 홈으로). 없으면 Theater의 정체(모노그램·이름·대화 수)다.
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
        <MobileMonogram label={theater.label} toneKey={theater.id} size={64} />
        <strong>{theater.label}</strong>
        <small>{t("mobile.list.heroSub", { count: conversationCount })}</small>
      </div>
    );
  }
  const status = trailing.get(featured.entry.id) ?? null;
  const name = resolveLocalizedText(featured.entry.mobile?.destination?.label ?? featured.entry.title, locale);
  return (
    <button type="button" data-press="r1" className="mobile-conv-hero is-featured" onClick={() => setMobileDestination({ kind: "plugin", entryId: featured.entry.id })}>
      <FeaturedAvatar theaterId={theater.id} label={name} status={status} />
      <strong>{name}</strong>
      <small>
        {status?.glyph ? <span className={statusGlyphClassName(status.glyph)} aria-hidden="true" /> : null}
        {status?.text ?? ""}
      </small>
    </button>
  );
}

/** 대표 아바타 — Theater를 대표하는 사령관의 몽글 얼굴. 상태 칸의 글리프와 톤을 얼굴로 옮긴다(꺼짐은 잠든 얼굴, 오류는 오류). */
function FeaturedAvatar({ theaterId, label, status }: { readonly theaterId: string; readonly label: string; readonly status: RailEntryDestinationTrailingValue | null }) {
  // 모습이 아직 없는 Theater 키는 목록이 마운트한 `useAvatarClaims`가 뽑아 저장한다.
  return <KeyedAvatar avatarKey={theaterAvatarKey(theaterId)} role="commodore" state={featuredFace(status)} size={88} label={label} decorative />;
}

function featuredFace(status: RailEntryDestinationTrailingValue | null): MongleState {
  if (status === null) return "idle";
  if (status.tone === "danger") return "error";
  if (status.tone === "faint") return "ended";
  if (status.glyph === "running" || status.glyph === "background") return "running";
  return "idle";
}
