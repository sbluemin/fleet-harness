import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import type { AdmiralId } from "./chat-session.js";
import { activateDock, readDockSnapshot, registerDockGlyph, subscribeDock, writeDock } from "./dock-store.js";
import { QUAKER_HEAD_VIEW_BOX, QuakerFigure } from "./quaker-figure.js";
import { getT } from "./scuttlebutt-catalog.js";
import { getScuttlebuttSettings, subscribeScuttlebuttSettings } from "./settings-store.js";

const MORPHS: readonly AdmiralId[] = ["tori", "bori", "dori"];

/**
 * 커맨드 밴드 우측에 서는 부관 글리프.
 *
 * 「상단 바에 두기」를 켠 부관만 선다 — 새가 캔버스에서 사라지고 이 24px 머리가 그 부관의 자리다.
 * 누르면 묻는 시트가 글리프 아래로 열린다. 답이 닫힌 시트에 도착하면 점이 서고, 답하는 동안은
 * 밴드의 다른 토글과 같은 워시로 숨을 쉰다.
 *
 * 밴드 버튼 문법(24×24, hover 림·워시)은 호스트 클래스에 기대지 않고 플러그인 CSS가 토큰으로
 * 다시 그린다 — 호스트 클래스명은 플러그인 계약이 아니다.
 */
export function DockGlyphs() {
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const dock = useStoreSnapshot(subscribeDock, readDockSnapshot);
  const t = getT(dock.locale);
  // 이 컴포넌트가 서 있다는 것이 곧 슬롯이 있다는 뜻이다 — 아무것도 그리지 않는 동안에도.
  React.useEffect(() => {
    writeDock({ host: true });
    return () => writeDock({ host: false });
  }, []);
  const docked = MORPHS.filter((morph) => settings[morph] && settings.docked[morph]);
  if (docked.length === 0 && !dock.dropArmed) return null;
  return (
    <span className="scuttlebutt-dock" role="group" aria-label={t("dock.groupAria")}>
      {docked.map((admiral) => {
        const unread = dock.unread.includes(admiral);
        const busy = dock.busy.includes(admiral);
        const name = t(`chat.label.${admiral}` as "chat.label.tori");
        return (
          <button
            key={admiral}
            ref={(element) => registerDockGlyph(admiral, element)}
            type="button"
            className={`scuttlebutt-dock-glyph${busy ? " is-busy" : ""}${unread ? " is-unread" : ""}`}
            aria-label={unread ? t("dock.unreadAria", { name }) : name}
            aria-expanded={dock.open === admiral}
            aria-pressed={dock.open === admiral}
            title={name}
            onClick={() => activateDock(admiral)}
          >
            <QuakerFigure morph={admiral} viewBox={QUAKER_HEAD_VIEW_BOX} />
            {unread ? <span className="scuttlebutt-dock-dot" aria-hidden="true" /> : null}
          </button>
        );
      })}
      {dock.dropArmed ? (
        <span className="scuttlebutt-dock-drop" aria-hidden="true">
          {t("dock.dropHere")}
        </span>
      ) : null}
    </span>
  );
}
