import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect } from "react";

import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export interface WorldControlsGuideProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly locale?: ConsoleLocale | undefined;
}

interface GuideEntry {
  readonly keys?: string | undefined;
  readonly keysKey?: TheWorldMessageKey | undefined;
  readonly descKey: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}

const GUIDE_GROUPS: readonly {
  readonly id: string;
  readonly titleKey: TheWorldMessageKey;
  readonly items: readonly GuideEntry[];
}[] = [
  {
    id: "move",
    titleKey: "theWorld.guide.groupMove",
    items: [
      { keysKey: "theWorld.guide.moveKeys", descKey: "theWorld.guide.moveDesc", icon: "compass", tone: "cerulean" },
      { keysKey: "theWorld.guide.cameraOrbitKeys", descKey: "theWorld.guide.cameraOrbitDesc", icon: "stage", tone: "moss" },
      { keys: "Shift", descKey: "theWorld.guide.sprintDesc", icon: "approach", tone: "teal" },
      { keys: "Space", descKey: "theWorld.guide.jumpDesc", icon: "sparkle", tone: "amber" },
      { keysKey: "theWorld.controls.barrelRollKeys", descKey: "theWorld.controls.barrelRollDesc", icon: "spin", tone: "amber" },
      { keysKey: "theWorld.controls.flightCamKeys", descKey: "theWorld.controls.flightCamDesc", icon: "cameraFollow", tone: "cerulean" },
      { keysKey: "theWorld.controls.skyDiveKeys", descKey: "theWorld.controls.skyDiveDesc", icon: "sparkle", tone: "cerulean" },
    ],
  },
  {
    id: "interact",
    titleKey: "theWorld.guide.groupInteract",
    items: [
      { keys: "E", descKey: "theWorld.guide.interactDesc", icon: "greet", tone: "amber" },
      { keysKey: "theWorld.controls.companionKeys", descKey: "theWorld.controls.companionDesc", icon: "crew", tone: "teal" },
      { keysKey: "theWorld.controls.paradeBellKeys", descKey: "theWorld.controls.paradeBellDesc", icon: "bell", tone: "amber" },
      { keys: "Tab", descKey: "theWorld.guide.urgentDesc", icon: "bell", tone: "amber" },
      { keys: "F", descKey: "theWorld.guide.campfireDesc", icon: "fire", tone: "rose" },
      { keysKey: "theWorld.controls.fishingKeys", descKey: "theWorld.controls.fishingDesc", icon: "sparkle", tone: "teal" },
      { keys: "B", descKey: "theWorld.controls.emoteWheelDesc", icon: "cheer", tone: "rose" },
      { keys: "1 · 2 · 3", descKey: "theWorld.guide.emoteDesc", icon: "cheer", tone: "amber" },
      { keysKey: "theWorld.guide.quickMenuKeys", descKey: "theWorld.guide.quickMenuDesc", icon: "flag", tone: "moss" },
      { keysKey: "theWorld.controls.skyQuickKeys", descKey: "theWorld.controls.skyQuickDesc", icon: "mapOverview", tone: "amber" },
    ],
  },
  {
    id: "view",
    titleKey: "theWorld.guide.groupView",
    items: [
      { keys: "M", descKey: "theWorld.guide.overviewDesc", icon: "mapOverview", tone: "moss" },
      { keys: "P", descKey: "theWorld.controls.photoStudioDesc", icon: "camera", tone: "cerulean" },
      { keys: "C", descKey: "theWorld.guide.cinemaDesc", icon: "cinema", tone: "teal" },
      { keys: "G", descKey: "theWorld.guide.gazetteDesc", icon: "gazette", tone: "amber" },
      { keysKey: "theWorld.controls.stampBookKeys", descKey: "theWorld.controls.stampBookDesc", icon: "trophy", tone: "amber" },
      { keys: "Enter", descKey: "theWorld.guide.chatDesc", icon: "chat", tone: "teal" },
      { keys: "? / H", descKey: "theWorld.guide.guideDesc", icon: "question", tone: "amber" },
      { keys: "Shift+D", descKey: "theWorld.guide.debugDesc", icon: "tool", tone: "indigo" },
    ],
  },
];

/**
 * `?` / `H` 1장짜리 다크 크리스탈 조작 가이드 모달.
 *
 * 이동·질주·점프·상호작용·불멍·감정표현·하늘 조망·포토 모드·우클릭 퀵메뉴·채팅 단축키를
 * 키캡 카드로 한눈에 정리해 처음 진입한 사용자도 모든 기능을 쉽게 발견할 수 있게 한다.
 */
export const WorldControlsGuide = memo(function WorldControlsGuide({
  open,
  onClose,
  locale,
}: WorldControlsGuideProps) {
  const t = getWorldT(locale);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

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
        className="the-world-panel the-world-guide-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("theWorld.guide.aria")}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />

        <header className="the-world-panel-head">
          <div className="the-world-dialogue-speaker">
            <span className="the-world-qb-emblem" aria-hidden="true">
              <WorldIcon name="question" size={18} tone="amber" />
            </span>
            <div>
              <h2 className="the-world-dialogue-name">{t("theWorld.guide.title")}</h2>
              <p className="the-world-dialogue-role">{t("theWorld.guide.subtitle")}</p>
            </div>
          </div>

          <button
            type="button"
            className="the-world-chat-icon-btn"
            aria-label={t("theWorld.guide.closeAria")}
            onClick={onClose}
          >
            <WorldIcon name="close" size={15} />
          </button>
        </header>

        <div className="the-world-panel-body the-world-guide-body">
          {GUIDE_GROUPS.map((group) => (
            <section key={group.id} className="the-world-guide-group">
              <h3 className="the-world-qb-section-title">{t(group.titleKey)}</h3>
              <div className="the-world-guide-grid">
                {group.items.map((item) => {
                  const keyLabel = item.keysKey ? t(item.keysKey) : (item.keys ?? "");
                  return (
                    <div key={item.descKey} className="the-world-guide-row">
                      <span className="the-world-guide-row-icon" aria-hidden="true">
                        <WorldIcon name={item.icon} size={13} tone={item.tone} />
                      </span>
                      <span className="the-world-guide-desc">{t(item.descKey)}</span>
                      <kbd className="the-world-guide-kbd">{keyLabel}</kbd>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
});
