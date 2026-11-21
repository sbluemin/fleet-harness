import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect } from "react";

import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import type { WorldAdmiralHat, WorldAdmiralStyle } from "../../shared/world-types.js";
import { playDistrictHover, playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export interface WorldAdmiralCustomizerProps {
  readonly style: WorldAdmiralStyle;
  readonly locale: ConsoleLocale | undefined;
  readonly onChangeStyle: (patch: Partial<WorldAdmiralStyle>) => void;
  readonly onPreviewChange?: (() => void) | undefined;
  readonly onClose: () => void;
}

const ADMIRAL_TONES: readonly IdentityTone[] = [
  "crimson",
  "amber",
  "moss",
  "teal",
  "cerulean",
  "indigo",
  "plum",
  "rose",
];

const ADMIRAL_HATS: readonly {
  readonly id: WorldAdmiralHat;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "admiral", key: "theWorld.admiral.hat.admiral", icon: "hat", tone: "cerulean" },
  { id: "crown", key: "theWorld.admiral.hat.crown", icon: "crown", tone: "amber" },
  { id: "explorer", key: "theWorld.admiral.hat.explorer", icon: "compass", tone: "moss" },
  { id: "none", key: "theWorld.admiral.hat.none", icon: "close", tone: "inherit" },
];

/**
 * 우측 플로팅 글래스 「제독 몽글이 3D 드레스업」 시트.
 *
 * 암막 백드롭 없이 좌측 열린 3D 초원의 실시간 제독 클로즈업을 직접 보며
 * 8색 아이덴티티 톤과 모자 4종을 즉시 바꿔보고 드래그로 360° 회전 감상한다.
 */
export const WorldAdmiralCustomizer = memo(function WorldAdmiralCustomizer({
  style,
  locale,
  onChangeStyle,
  onPreviewChange,
  onClose,
}: WorldAdmiralCustomizerProps) {
  const t = getWorldT(locale);
  const activeHatMeta = ADMIRAL_HATS.find((h) => h.id === style.hat) ?? ADMIRAL_HATS[0]!;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  return (
    <aside
      className="the-world-customizer-sheet"
      data-tone={style.tone}
      role="dialog"
      aria-label={t("theWorld.admiral.aria")}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="the-world-drawer-crest" aria-hidden="true" />

      <header className="the-world-drawer-head">
        <div className="the-world-dialogue-speaker">
          <span className="the-world-qb-emblem" aria-hidden="true">
            <WorldIcon name="hat" size={17} tone="amber" />
          </span>
          <div>
            <h2 className="the-world-dialogue-name">{t("theWorld.admiral.title")}</h2>
            <p className="the-world-dialogue-role">{t("theWorld.admiral.subtitle")}</p>
          </div>
        </div>

        <button
          type="button"
          className="the-world-btn is-icon-only"
          aria-label={t("theWorld.admiral.closeAria")}
          onClick={onClose}
        >
          <WorldIcon name="close" size={14} />
        </button>
      </header>

      <div className="the-world-customizer-body">
        {/* 실시간 3D 제독 회전 안내 칩 */}
        <div className="the-world-customizer-hint">
          <WorldIcon name="cameraOrbit" size={13} tone="amber" />
          <span className="the-world-customizer-hint-text">{t("theWorld.admiral.dragHint")}</span>
          <span className="the-world-customizer-hat-chip">
            <WorldIcon name={activeHatMeta.icon} size={11} tone="amber" />
            <span>{t(activeHatMeta.key)}</span>
          </span>
        </div>

        {/* 8색 톤 스와치 */}
        <div className="the-world-admiral-section">
          <span className="the-world-district-section-label">{t("theWorld.admiral.toneLabel")}</span>
          <div
            className="the-world-admiral-swatches"
            role="group"
            aria-label={t("theWorld.admiral.toneGroupAria")}
          >
            {ADMIRAL_TONES.map((tone) => {
              const active = style.tone === tone;
              return (
                <button
                  key={tone}
                  type="button"
                  className={`the-world-admiral-swatch${active ? " is-active" : ""}`}
                  data-tone={tone}
                  aria-label={t("theWorld.admiral.toneGroupAria")}
                  aria-pressed={active}
                  onClick={() => {
                    playDistrictHover();
                    onChangeStyle({ tone });
                    onPreviewChange?.();
                  }}
                >
                  <span className="the-world-admiral-swatch-dot" data-tone={tone} />
                </button>
              );
            })}
          </div>
        </div>

        {/* 모자 4종 선택 */}
        <div className="the-world-admiral-section">
          <span className="the-world-district-section-label">{t("theWorld.admiral.hatLabel")}</span>
          <div
            className="the-world-admiral-hats"
            role="group"
            aria-label={t("theWorld.admiral.hatGroupAria")}
          >
            {ADMIRAL_HATS.map((hat) => {
              const active = style.hat === hat.id;
              return (
                <button
                  key={hat.id}
                  type="button"
                  className={`the-world-admiral-hat-pill${active ? " is-active" : ""}`}
                  aria-pressed={active}
                  onClick={() => {
                    playDistrictSelect();
                    onChangeStyle({ hat: hat.id });
                    onPreviewChange?.();
                  }}
                >
                  <WorldIcon name={hat.icon} size={14} tone={active ? "amber" : hat.tone} />
                  <span>{t(hat.key)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
});
