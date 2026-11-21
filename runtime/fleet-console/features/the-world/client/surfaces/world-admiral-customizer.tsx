import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import type { WorldAdmiralHat, WorldAdmiralStyle } from "../../shared/world-types.js";
import { playDistrictHover, playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export interface WorldAdmiralCustomizerProps {
  readonly style: WorldAdmiralStyle;
  readonly locale: ConsoleLocale | undefined;
  readonly onChangeStyle: (patch: Partial<WorldAdmiralStyle>) => void;
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
 * 다크 크리스탈 「제독 몽글이 꾸미기」 모달.
 *
 * 8색 아이덴티티 톤 스와치와 모자 4종을 선택하면 실시간 프리뷰 및 3D 제독 리그에 즉시 반영된다.
 */
export const WorldAdmiralCustomizer = memo(function WorldAdmiralCustomizer({
  style,
  locale,
  onChangeStyle,
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
    <div
      className="the-world-panel-backdrop"
      role="presentation"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="the-world-panel the-world-admiral-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("theWorld.admiral.aria")}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />

        <header className="the-world-panel-head">
          <div className="the-world-dialogue-speaker">
            <span className="the-world-qb-emblem" aria-hidden="true">
              <WorldIcon name="hat" size={18} tone="amber" />
            </span>
            <div>
              <h2 className="the-world-dialogue-name">{t("theWorld.admiral.title")}</h2>
              <p className="the-world-dialogue-role">{t("theWorld.admiral.subtitle")}</p>
            </div>
          </div>

          <button
            type="button"
            className="the-world-chat-icon-btn"
            aria-label={t("theWorld.admiral.closeAria")}
            onClick={onClose}
          >
            <WorldIcon name="close" size={15} />
          </button>
        </header>

        <div className="the-world-panel-body the-world-admiral-body">
          {/* 실시간 MongleAvatar 프리뷰 */}
          <div className="the-world-admiral-preview" data-tone={style.tone}>
            <div className="the-world-admiral-avatar-stage">
              <MongleAvatar
                base={0}
                tone={style.tone}
                role="commodore"
                state="idle"
                size={68}
                label={t("theWorld.admiral.title")}
                decorative
              />
            </div>
            <div className="the-world-admiral-preview-badge">
              <WorldIcon name={activeHatMeta.icon} size={13} tone="amber" />
              <span>{t(activeHatMeta.key)}</span>
            </div>
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
      </section>
    </div>
  );
});
