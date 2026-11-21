import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect } from "react";

import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import { WorldIcon, type WorldIconName } from "./world-icons.js";

export type WorldAdmiralEmoteKind = "cheer" | "wave" | "clap" | "twirl" | "stardust" | "sit";

const PETAL_RADIUS_PX = 104;

const EMOTE_PETALS: readonly {
  readonly id: WorldAdmiralEmoteKind;
  readonly keyLabel: string;
  readonly code: string;
  readonly labelKey: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly angleDeg: number;
}[] = [
  { id: "cheer", keyLabel: "1", code: "Digit1", labelKey: "theWorld.emote.cheer", icon: "cheer", angleDeg: -90 },
  { id: "wave", keyLabel: "2", code: "Digit2", labelKey: "theWorld.emote.wave", icon: "greet", angleDeg: -30 },
  { id: "clap", keyLabel: "3", code: "Digit3", labelKey: "theWorld.emote.clap", icon: "highfive", angleDeg: 30 },
  { id: "twirl", keyLabel: "4", code: "Digit4", labelKey: "theWorld.emote.twirl", icon: "spin", angleDeg: 90 },
  { id: "stardust", keyLabel: "5", code: "Digit5", labelKey: "theWorld.emote.stardust", icon: "sparkle", angleDeg: 150 },
  { id: "sit", keyLabel: "6", code: "Digit6", labelKey: "theWorld.emote.sit", icon: "fire", angleDeg: 210 },
];

export interface WorldEmoteWheelProps {
  readonly open: boolean;
  readonly locale: ConsoleLocale | undefined;
  readonly onSelectEmote: (kind: WorldAdmiralEmoteKind) => void;
  readonly onClose: () => void;
}

/**
 * 별 제독 방사형 이모트 휠 (`B`).
 *
 * 화면 중앙에 6개 원형 별빛 꽃잎 버튼이 60° 간격으로 펼쳐지며,
 * 클릭 또는 숫자키 `1`–`6`으로 이모트를 실행하고 바깥 클릭·중앙 클릭·`Esc`로 닫힌다.
 */
export const WorldEmoteWheel = memo(function WorldEmoteWheel({
  open,
  locale,
  onSelectEmote,
  onClose,
}: WorldEmoteWheelProps) {
  const t = getWorldT(locale);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const match = EMOTE_PETALS.find((p) => p.code === event.code);
      if (match) {
        event.preventDefault();
        event.stopPropagation();
        onSelectEmote(match.id);
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, onSelectEmote, open]);

  if (!open) return null;

  return (
    <div
      className="the-world-emote-wheel"
      role="dialog"
      aria-label={t("theWorld.emote.wheelAria")}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="the-world-emote-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />

      <div className="the-world-emote-ring">
        <button
          type="button"
          className="the-world-emote-center"
          aria-label={t("theWorld.panel.closeAria")}
          onClick={onClose}
        >
          <WorldIcon name="sparkle" size={18} tone="amber" />
          <span>{t("theWorld.emote.title")}</span>
        </button>

        {EMOTE_PETALS.map((petal) => {
          const rad = (petal.angleDeg * Math.PI) / 180;
          const x = Math.round(Math.cos(rad) * PETAL_RADIUS_PX);
          const y = Math.round(Math.sin(rad) * PETAL_RADIUS_PX);
          return (
            <button
              key={petal.id}
              type="button"
              className="the-world-emote-petal"
              style={{
                ["--petal-x" as string]: `${x}px`,
                ["--petal-y" as string]: `${y}px`,
              }}
              onClick={() => {
                onSelectEmote(petal.id);
                onClose();
              }}
            >
              <span className="the-world-emote-petal-icon" aria-hidden="true">
                <WorldIcon name={petal.icon} size={18} tone="amber" />
              </span>
              <span className="the-world-emote-petal-label">{t(petal.labelKey)}</span>
              <span className="the-world-emote-petal-key">{petal.keyLabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
