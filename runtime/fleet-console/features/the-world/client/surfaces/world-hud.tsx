import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useRef, useState } from "react";

import { ApprovalCapsule } from "../../../execution/client/approval/panel.js";
import type {
  WorldCameraMode,
  WorldPlayerEmote,
  WorldSnapshot,
  WorldTimeMode,
  WorldWeatherMode,
} from "../../shared/world-types.js";
import {
  playDistrictHover,
  playDistrictSelect,
  playOverviewToggle,
  playParadeBell,
  playPhotoShutter,
  setWorldAudioMuted,
} from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  exitTheWorld,
  openAdmiralCustomizer,
  openMailbox,
  openQuestBoard,
  openWarRoom,
  requestPlayerEmote,
  requestRallyAll,
  setWeatherMode,
  setWorldCameraMode,
  setWorldTimeMode,
  toggleAuroraEnabled,
  toggleBgm,
  toggleCinemaMode,
  toggleEmoteWheel,
  toggleGazette,
  toggleOverviewMode,
  togglePhotoMode,
  toggleSoundMuted,
  toggleStampBook,
  triggerWorldChoreography,
  useWorldStore,
  WORLD_STAMP_IDS,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

const TIME_MODES: readonly {
  readonly id: WorldTimeMode;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "realtime", key: "theWorld.hud.timeAuto", icon: "clock", tone: "cerulean" },
  { id: "cycle", key: "theWorld.hud.timeCycle", icon: "cycle", tone: "teal" },
  { id: "day", key: "theWorld.hud.timeDay", icon: "sun", tone: "amber" },
  { id: "sunset", key: "theWorld.hud.timeSunset", icon: "sunset", tone: "rose" },
  { id: "night", key: "theWorld.hud.timeNight", icon: "moon", tone: "indigo" },
];

const CAMERA_MODES: readonly {
  readonly id: WorldCameraMode;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "follow", key: "theWorld.hud.cameraFollow", icon: "cameraFollow", tone: "teal" },
  { id: "orbit", key: "theWorld.hud.cameraOrbit", icon: "cameraOrbit", tone: "moss" },
];

const WEATHER_MODES: readonly {
  readonly id: WorldWeatherMode;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "clear", key: "theWorld.weather.clear", icon: "sun", tone: "amber" },
  { id: "sakura", key: "theWorld.weather.sakura", icon: "sakura", tone: "rose" },
  { id: "rain", key: "theWorld.weather.rain", icon: "rain", tone: "cerulean" },
  { id: "snow", key: "theWorld.weather.snow", icon: "snow", tone: "teal" },
];

export interface WorldHudProps {
  readonly snapshot: WorldSnapshot;
  readonly locale: ConsoleLocale | undefined;
  readonly reducedMotion: boolean;
  readonly toastMessage: string | null;
  readonly toastKind?: "info" | "celebration" | undefined;
  readonly hideBottom: boolean;
  readonly urgentQuestCount?: number | undefined;
  readonly onCreateCommodore: () => void;
  readonly onStatusBanner: (msg: string) => void;
  readonly onTestLevelUp?: (() => void) | undefined;
  readonly onTestRainbow?: (() => void) | undefined;
  readonly onOpenWarRoom?: (() => void) | undefined;
  readonly onOpenAdmiralCustomizer?: (() => void) | undefined;
  readonly weatherMode?: WorldWeatherMode | undefined;
  readonly onSelectWeather?: ((mode: WorldWeatherMode) => void) | undefined;
  readonly timeMode?: WorldTimeMode | undefined;
  readonly onSelectTimeMode?: ((mode: WorldTimeMode) => void) | undefined;
  readonly onOpenCustomizer?: (() => void) | undefined;
  readonly onTriggerEmote?: ((emote: WorldPlayerEmote) => void) | undefined;
  readonly onToggleControlsGuide?: (() => void) | undefined;
  readonly onOpenGazette?: (() => void) | undefined;
  readonly onToggleCinemaMode?: (() => void) | undefined;
  readonly onToggleBgm?: (() => void) | undefined;
  readonly unreadMailCount?: number | undefined;
  readonly onOpenMailbox?: (() => void) | undefined;
  readonly onRingParadeBell?: (() => void) | undefined;
  readonly debugPanelVisible?: boolean | undefined;
}

/**
 * 다이어트된 미니멀 게임 HUD.
 *
 * - 우상단: 핵심 액션(`상황실` · `퀘스트` · `별빛 비행`) + 미확인 우편 배지(있을 때만) + `도구` 통합 드롭다운 + `콘솔`
 * - 부가 도구(우체통·환경·항해 수첩·제독 외형·포토·함대 일지·소집 종·음향·시네마·감정 표현·영입·가이드)는 `도구` 팝오버에 수납한다.
 * - `디버그` 버튼은 평소 숨겨 두고 `debugPanelVisible` (`Shift+D`)이 켜질 때만 노출한다.
 * - 하단 좌측: 누구나 바로 클릭하거나 `1/2/3` 키로 실행할 수 있는 컴팩트 이모트·외형 미니 필.
 */
export const WorldHud = memo(function WorldHud({
  snapshot,
  locale,
  reducedMotion,
  toastMessage,
  toastKind = "info",
  hideBottom,
  urgentQuestCount,
  onCreateCommodore,
  onStatusBanner,
  onTestLevelUp,
  onTestRainbow,
  onOpenWarRoom,
  onOpenAdmiralCustomizer,
  weatherMode: weatherModeProp,
  onSelectWeather,
  timeMode: timeModeProp,
  onSelectTimeMode,
  onOpenCustomizer,
  onTriggerEmote,
  onToggleControlsGuide,
  onOpenGazette,
  onToggleCinemaMode,
  onToggleBgm,
  unreadMailCount = 0,
  onOpenMailbox,
  onRingParadeBell,
  debugPanelVisible = false,
}: WorldHudProps) {
  const store = useWorldStore();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const hudTopRef = useRef<HTMLDivElement | null>(null);
  const t = getWorldT(locale);
  const isEn = locale === "en";
  const bi = (ko: string, en: string) => (isEn ? en : ko);
  const effectiveUrgentCount = urgentQuestCount ?? snapshot.attentionCount;
  const effectiveUnreadMail = Math.max(0, unreadMailCount);
  const attentionActor = snapshot.actors.find((a) => a.needsAttention) ?? null;

  const activeWeather = weatherModeProp ?? store.weatherMode;
  const activeTime = timeModeProp ?? store.timeMode;
  const activeWeatherMeta = WEATHER_MODES.find((w) => w.id === activeWeather) ?? WEATHER_MODES[0]!;

  useEffect(() => {
    if (!debugPanelVisible && debugOpen) {
      setDebugOpen(false);
    }
  }, [debugOpen, debugPanelVisible]);

  useEffect(() => {
    if (!toolsOpen && !envOpen && !debugOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        hudTopRef.current
        && event.target instanceof Node
        && hudTopRef.current.contains(event.target)
      ) {
        return;
      }
      setToolsOpen(false);
      setEnvOpen(false);
      setDebugOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolsOpen(false);
        setEnvOpen(false);
        setDebugOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [toolsOpen, envOpen, debugOpen]);

  const closeAllPopovers = () => {
    setToolsOpen(false);
    setEnvOpen(false);
    setDebugOpen(false);
  };

  const handleOpenMailbox = () => {
    closeAllPopovers();
    playDistrictSelect();
    if (onOpenMailbox) onOpenMailbox();
    else openMailbox();
  };

  const handleRingParadeBell = () => {
    closeAllPopovers();
    playParadeBell();
    if (onRingParadeBell) {
      onRingParadeBell();
    } else {
      requestRallyAll();
      onStatusBanner(bi("중앙 광장 소집 종을 울렸습니다!", "Rang the plaza rally bell!"));
    }
  };

  const handleSelectWeather = (mode: WorldWeatherMode) => {
    playDistrictHover();
    if (onSelectWeather) onSelectWeather(mode);
    else setWeatherMode(mode);
  };

  const handleSelectTime = (mode: WorldTimeMode) => {
    playDistrictHover();
    if (onSelectTimeMode) onSelectTimeMode(mode);
    else setWorldTimeMode(mode);
  };

  const handleOpenCustomizer = () => {
    playDistrictSelect();
    closeAllPopovers();
    if (onOpenCustomizer) onOpenCustomizer();
    else if (onOpenAdmiralCustomizer) onOpenAdmiralCustomizer();
    else openAdmiralCustomizer();
  };

  const handleTriggerEmote = (emote: WorldPlayerEmote) => {
    if (onTriggerEmote) onTriggerEmote(emote);
    else requestPlayerEmote(emote);
  };

  const toolsMenuLabel = bi("도구", "Tools");
  const toolsMenuAria = bi("함대 도구 메뉴 열기", "Open fleet tools menu");
  const mailboxLabel = bi("함대 우체통", "Fleet Mailbox");
  const mailboxAria = bi("함대 우체통 열기", "Open Fleet Mailbox");
  const rallyBellLabel = bi("소집 종 울리기", "Ring Rally Bell");
  const soundLabel = store.soundMuted ? bi("음향 꺼짐", "Sound Off") : bi("음향 켜짐", "Sound On");
  const guideShortLabel = bi("조작 가이드", "Controls");
  const recruitShortLabel = bi("사령관 영입", "Recruit");

  return (
    <>
      {toastMessage ? (
        <div
          className={`the-world-toast${toastKind === "celebration" ? " is-celebration" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="the-world-crest" aria-hidden="true" />
          <div className="the-world-toast-inner">
            <WorldIcon name={toastKind === "celebration" ? "sparkle" : "systemInfo"} size={13} tone="amber" />
            <span>{toastMessage}</span>
          </div>
        </div>
      ) : null}

      <div ref={hudTopRef} className="the-world-hud-top">
        <div className="the-world-hud-cluster">
          {effectiveUrgentCount > 0 ? (
            <div className="the-world-bar is-attention-bar">
              <button
                type="button"
                className="the-world-btn is-attention"
                aria-label={t("theWorld.hud.questBoardAria")}
                onClick={() => {
                  closeAllPopovers();
                  playDistrictSelect();
                  openQuestBoard();
                }}
              >
                <WorldIcon name="bell" size={14} tone="amber" />
                <span>
                  {attentionActor
                    ? t("theWorld.hud.attentionActor", { name: attentionActor.name })
                    : t("theWorld.noticeBoard.urgentBadge", { count: effectiveUrgentCount })}
                </span>
                <span className="the-world-hud-badge">{effectiveUrgentCount}</span>
              </button>
            </div>
          ) : null}

          <div className="the-world-bar">
            {/* 핵심 상시 액션: 상황실 · 퀘스트 · 별빛 비행 */}
            <button
              type="button"
              className={`the-world-btn${store.warRoomOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.warRoomAria")}
              aria-pressed={store.warRoomOpen}
              title={t("theWorld.hud.warRoomTitle")}
              onClick={() => {
                closeAllPopovers();
                playDistrictSelect();
                if (onOpenWarRoom) onOpenWarRoom();
                else openWarRoom();
              }}
            >
              <WorldIcon name="warRoom" size={14} tone={store.warRoomOpen ? "amber" : "teal"} />
              <span>{t("theWorld.hud.warRoomLabel")}</span>
            </button>

            <button
              type="button"
              className={`the-world-btn${store.questBoardOpen ? " is-active" : ""}${effectiveUrgentCount > 0 ? " is-attention" : ""}`}
              aria-label={t("theWorld.hud.questBoardAria")}
              aria-pressed={store.questBoardOpen}
              title={t("theWorld.hud.questBoardTitle")}
              onClick={() => {
                closeAllPopovers();
                playDistrictSelect();
                openQuestBoard();
              }}
            >
              <WorldIcon
                name={effectiveUrgentCount > 0 ? "bell" : "questBoard"}
                size={14}
                tone={effectiveUrgentCount > 0 || store.questBoardOpen ? "amber" : "cerulean"}
              />
              <span>{t("theWorld.hud.questBoardLabel")}</span>
              {effectiveUrgentCount > 0 ? (
                <span className="the-world-hud-badge">{effectiveUrgentCount}</span>
              ) : null}
            </button>

            <button
              type="button"
              className={`the-world-btn${store.overviewMode ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.overviewAria")}
              aria-pressed={store.overviewMode}
              title={t("theWorld.hud.overviewTitle")}
              onClick={() => {
                closeAllPopovers();
                playOverviewToggle(!store.overviewMode);
                toggleOverviewMode();
              }}
            >
              <WorldIcon name={store.overviewMode ? "sparkle" : "mapOverview"} size={14} tone={store.overviewMode ? "amber" : "moss"} />
              <span>{t("theWorld.hud.overviewLabel")}</span>
            </button>

            <ApprovalCapsule />

            {/* 미확인 우편이 있을 때만 상시 노출되는 컴팩트 우체통 배지 */}
            {effectiveUnreadMail > 0 ? (
              <button
                type="button"
                className={`the-world-btn is-attention${store.mailboxOpen ? " is-active" : ""}`}
                aria-label={mailboxAria}
                aria-pressed={store.mailboxOpen}
                title={mailboxLabel}
                onClick={handleOpenMailbox}
              >
                <WorldIcon name="mail" size={14} tone="amber" />
                <span className="the-world-hud-badge">{effectiveUnreadMail}</span>
              </button>
            ) : null}

            {/* 통합 도구 드롭다운 버튼 */}
            <button
              type="button"
              className={`the-world-btn${toolsOpen || envOpen ? " is-active" : ""}`}
              aria-label={toolsMenuAria}
              aria-expanded={toolsOpen}
              title={toolsMenuLabel}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
                playDistrictHover();
                setToolsOpen((prev) => !prev);
              }}
            >
              <WorldIcon name="settings" size={14} tone={toolsOpen || envOpen ? "amber" : "cerulean"} />
              <span>{toolsMenuLabel}</span>
              <span className="the-world-tools-caret" aria-hidden="true">{toolsOpen ? "▴" : "▾"}</span>
            </button>

            {debugPanelVisible ? (
              <button
                type="button"
                className={`the-world-btn is-icon-only${debugOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.debugAria")}
                aria-expanded={debugOpen}
                title={t("theWorld.hud.debugTitle")}
                onClick={() => {
                  setToolsOpen(false);
                  setEnvOpen(false);
                  setDebugOpen((prev) => !prev);
                }}
              >
                <WorldIcon name="tool" size={14} tone={debugOpen ? "amber" : "cerulean"} />
              </button>
            ) : null}

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className="the-world-btn"
              onClick={() => exitTheWorld({ reducedMotion })}
            >
              <WorldIcon name="portalExit" size={14} tone="cerulean" />
              <span>{t("theWorld.hud.consoleLabel")}</span>
            </button>
          </div>
        </div>

        {/* 통합 도구 2열 콤팩트 드롭다운 팝오버 (Starlight Glass) */}
        {toolsOpen ? (
          <section
            className="the-world-debug-popover the-world-tools-popover"
            role="dialog"
            aria-label={toolsMenuAria}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="the-world-crest" aria-hidden="true" />
            <header className="the-world-debug-head">
              <span className="the-world-debug-title">
                <WorldIcon name="settings" size={13} tone="amber" />
                <span>{toolsMenuLabel}</span>
              </span>
              <button
                type="button"
                className="the-world-chat-icon-btn"
                aria-label={t("theWorld.panel.closeAria")}
                onClick={() => setToolsOpen(false)}
              >
                <WorldIcon name="close" size={14} />
              </button>
            </header>

            <div className="the-world-tools-grid">
              <button
                type="button"
                className={`the-world-tools-item${store.mailboxOpen ? " is-active" : ""}${effectiveUnreadMail > 0 ? " is-attention" : ""}`}
                aria-label={mailboxAria}
                onClick={handleOpenMailbox}
              >
                <WorldIcon name="mail" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{mailboxLabel}</span>
                {effectiveUnreadMail > 0 ? (
                  <span className="the-world-hud-badge">{effectiveUnreadMail}</span>
                ) : null}
              </button>

              <button
                type="button"
                className={`the-world-tools-item${envOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.envAria")}
                onClick={() => {
                  setToolsOpen(false);
                  setDebugOpen(false);
                  playDistrictHover();
                  setEnvOpen(true);
                }}
              >
                <WorldIcon
                  name={activeWeather === "clear" ? "weather" : activeWeatherMeta.icon}
                  size={14}
                  tone={activeWeatherMeta.tone}
                />
                <span className="the-world-tools-item-label">{t("theWorld.hud.envTitle")}</span>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${store.stampBookOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.stamps.hudAria")}
                onClick={() => {
                  closeAllPopovers();
                  playDistrictSelect();
                  toggleStampBook();
                }}
              >
                <WorldIcon name="trophy" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{t("theWorld.stamps.hudLabel")}</span>
                <span className="the-world-tools-meta">
                  {store.unlockedStamps.length}/{WORLD_STAMP_IDS.length}
                </span>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${store.admiralCustomizerOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.admiralStyleAria")}
                onClick={handleOpenCustomizer}
              >
                <WorldIcon name="hat" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.admiralStyleBtn")}</span>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${store.photoMode ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.photoModeAria")}
                onClick={() => {
                  closeAllPopovers();
                  playPhotoShutter();
                  togglePhotoMode();
                }}
              >
                <WorldIcon name="camera" size={14} tone="cerulean" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.photoModeLabel")}</span>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${store.gazetteOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.gazetteAria")}
                onClick={() => {
                  closeAllPopovers();
                  playDistrictSelect();
                  if (onOpenGazette) onOpenGazette();
                  else toggleGazette();
                }}
              >
                <WorldIcon name="gazette" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.gazetteLabel")}</span>
              </button>

              <button
                type="button"
                className="the-world-tools-item"
                aria-label={rallyBellLabel}
                onClick={handleRingParadeBell}
              >
                <WorldIcon name="bell" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{rallyBellLabel}</span>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${!store.soundMuted ? " is-active" : ""}`}
                aria-label={store.soundMuted ? t("theWorld.hud.soundOffAria") : t("theWorld.hud.soundOnAria")}
                aria-pressed={!store.soundMuted}
                onClick={() => {
                  const nextMuted = !store.soundMuted;
                  setWorldAudioMuted(nextMuted);
                  toggleSoundMuted();
                  if (!nextMuted) playDistrictHover();
                }}
              >
                <WorldIcon
                  name={store.soundMuted ? "soundOff" : "soundOn"}
                  size={14}
                  tone={store.soundMuted ? "inherit" : "teal"}
                />
                <span className="the-world-tools-item-label">{soundLabel}</span>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${store.cinemaMode ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.cinemaAria")}
                onClick={() => {
                  closeAllPopovers();
                  playDistrictSelect();
                  if (onToggleCinemaMode) onToggleCinemaMode();
                  else toggleCinemaMode();
                }}
              >
                <WorldIcon name="cinema" size={14} tone="teal" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.cinemaLabel")}</span>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${store.emoteWheelOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.emoteBtn")}
                onClick={() => {
                  closeAllPopovers();
                  playDistrictSelect();
                  toggleEmoteWheel();
                }}
              >
                <WorldIcon name="cheer" size={14} tone="rose" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.emoteBtn")}</span>
              </button>

              <button
                type="button"
                className="the-world-tools-item"
                aria-label={t("theWorld.hud.createCommodoreAria")}
                onClick={() => {
                  closeAllPopovers();
                  onCreateCommodore();
                }}
              >
                <WorldIcon name="recruit" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{recruitShortLabel}</span>
              </button>

              <button
                type="button"
                className="the-world-tools-item"
                aria-label={t("theWorld.hud.guideAria")}
                onClick={() => {
                  closeAllPopovers();
                  playDistrictSelect();
                  onToggleControlsGuide?.();
                }}
              >
                <WorldIcon name="question" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{guideShortLabel}</span>
                <kbd className="the-world-keycap">?</kbd>
              </button>
            </div>
          </section>
        ) : null}

        {/* 환경 퀵 팝오버 (날씨 4종 + 시간대 원클릭 전환) */}
        {envOpen ? (
          <section
            className="the-world-debug-popover the-world-env-popover"
            role="dialog"
            aria-label={t("theWorld.hud.envAria")}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="the-world-crest" aria-hidden="true" />
            <header className="the-world-debug-head">
              <span className="the-world-debug-title">
                <WorldIcon name="weather" size={13} tone="amber" />
                <span>{t("theWorld.hud.envTitle")}</span>
              </span>
              <button
                type="button"
                className="the-world-chat-icon-btn"
                aria-label={t("theWorld.hud.envCloseAria")}
                onClick={() => setEnvOpen(false)}
              >
                <WorldIcon name="close" size={14} />
              </button>
            </header>

            <div className="the-world-debug-body">
              <div className="the-world-debug-section">
                <span className="the-world-debug-label">{t("theWorld.weather.label")}</span>
                <div className="the-world-debug-pills" role="group" aria-label={t("theWorld.weather.groupAria")}>
                  {WEATHER_MODES.map((item) => {
                    const active = activeWeather === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`the-world-debug-pill${active ? " is-active" : ""}`}
                        aria-pressed={active}
                        onClick={() => handleSelectWeather(item.id)}
                      >
                        <WorldIcon name={item.icon} size={13} tone={active ? "amber" : item.tone} />
                        <span>{t(item.key)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="the-world-debug-section">
                <span className="the-world-debug-label">{t("theWorld.hud.timeLabel")}</span>
                <div className="the-world-debug-pills" role="group" aria-label={t("theWorld.hud.timeGroupAria")}>
                  {TIME_MODES.map((item) => {
                    const active = activeTime === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`the-world-debug-pill${active ? " is-active" : ""}`}
                        aria-pressed={active}
                        onClick={() => handleSelectTime(item.id)}
                      >
                        <WorldIcon name={item.icon} size={13} tone={active ? "amber" : item.tone} />
                        <span>{t(item.key)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="the-world-debug-section">
                <span className="the-world-debug-label">{t("theWorld.hud.bgmLabel")}</span>
                <div className="the-world-bgm-row">
                  <button
                    type="button"
                    className={`the-world-debug-pill the-world-bgm-toggle${store.bgmEnabled ? " is-active" : ""}`}
                    aria-label={t("theWorld.hud.bgmAria")}
                    aria-pressed={store.bgmEnabled}
                    onClick={() => {
                      playDistrictHover();
                      if (onToggleBgm) onToggleBgm();
                      else toggleBgm();
                    }}
                  >
                    <WorldIcon name="music" size={13} tone={store.bgmEnabled ? "amber" : "teal"} />
                    <span>{store.bgmEnabled ? t("theWorld.hud.bgmToggleOn") : t("theWorld.hud.bgmToggleOff")}</span>
                  </button>
                  <button
                    type="button"
                    className={`the-world-debug-pill${store.auroraEnabled ? " is-active" : ""}`}
                    aria-label={t("theWorld.hud.auroraAria")}
                    aria-pressed={store.auroraEnabled}
                    onClick={() => {
                      playDistrictHover();
                      toggleAuroraEnabled();
                    }}
                  >
                    <WorldIcon name="rainbow" size={13} tone={store.auroraEnabled ? "amber" : "teal"} />
                    <span>{t("theWorld.hud.auroraToggle")}</span>
                  </button>
                </div>
                <span className="the-world-bgm-hint">{t("theWorld.hud.bgmHint")}</span>
              </div>
            </div>
          </section>
        ) : null}

        {/* 개발자 디버그 · 연출 테스트 팝오버 (Shift+D 활성 시에만 노출) */}
        {debugPanelVisible && debugOpen ? (
          <section
            className="the-world-debug-popover"
            role="dialog"
            aria-label={t("theWorld.hud.debugAria")}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="the-world-crest" aria-hidden="true" />
            <header className="the-world-debug-head">
              <span className="the-world-debug-title">
                <WorldIcon name="tool" size={13} tone="cerulean" />
                <span>{t("theWorld.hud.debugPanelTitle")}</span>
              </span>
              <button
                type="button"
                className="the-world-chat-icon-btn"
                aria-label={t("theWorld.hud.debugAria")}
                onClick={() => setDebugOpen(false)}
              >
                <WorldIcon name="close" size={14} />
              </button>
            </header>

            <div className="the-world-debug-body">
              <div className="the-world-debug-section">
                <span className="the-world-debug-label">{t("theWorld.hud.cameraLabel")}</span>
                <div className="the-world-debug-pills" role="group" aria-label={t("theWorld.hud.cameraGroupAria")}>
                  {CAMERA_MODES.map((item) => {
                    const active = store.cameraMode === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`the-world-debug-pill${active ? " is-active" : ""}`}
                        onClick={() => setWorldCameraMode(item.id)}
                      >
                        <WorldIcon name={item.icon} size={13} tone={active ? "amber" : item.tone} />
                        <span>{t(item.key)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="the-world-debug-section">
                <span className="the-world-debug-label">{t("theWorld.hud.simLabel")}</span>
                <div className="the-world-debug-grid" role="group" aria-label={t("theWorld.hud.simGroupAria")}>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("delegate");
                      onStatusBanner(t("theWorld.hud.simDelegateToast"));
                    }}
                  >
                    <WorldIcon name="scroll" size={13} tone="amber" />
                    <span>{t("theWorld.hud.simDelegate")}</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("report");
                      onStatusBanner(t("theWorld.hud.simReportToast"));
                    }}
                  >
                    <WorldIcon name="crate" size={13} tone="rose" />
                    <span>{t("theWorld.hud.simReport")}</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("handoff");
                      onStatusBanner(t("theWorld.hud.simHandoffToast"));
                    }}
                  >
                    <WorldIcon name="baton" size={13} tone="cerulean" />
                    <span>{t("theWorld.hud.simHandoff")}</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("celebrate");
                      onStatusBanner(t("theWorld.hud.simCelebrateToast"));
                    }}
                  >
                    <WorldIcon name="confetti" size={13} tone="amber" />
                    <span>{t("theWorld.hud.simCelebrate")}</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    aria-label={t("theWorld.debug.levelUpTestAria")}
                    onClick={() => {
                      if (onTestLevelUp) {
                        onTestLevelUp();
                      } else {
                        triggerWorldChoreography("celebrate");
                        onStatusBanner(t("theWorld.debug.levelUpTest"));
                      }
                    }}
                  >
                    <WorldIcon name="sparkle" size={13} tone="amber" />
                    <span>{t("theWorld.debug.levelUpTest")}</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    aria-label={t("theWorld.debug.rainbowTestAria")}
                    onClick={() => {
                      playDistrictSelect();
                      onTestRainbow?.();
                      onStatusBanner(t("theWorld.rainbow.toast"));
                    }}
                  >
                    <WorldIcon name="rainbow" size={13} tone="rose" />
                    <span>{t("theWorld.debug.rainbowTest")}</span>
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : null}
      </div>

      {/* 관전 / 작업 동반자 모드 하단 중앙 미니 종료 필 */}
      {store.cinemaMode ? (
        <div
          className="the-world-cinema-pill"
          role="status"
          aria-live="polite"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="the-world-cinema-badge">
            <span className="the-world-cinema-dot" aria-hidden="true" />
            <WorldIcon name="cinema" size={13} tone="amber" />
            <span>{t("theWorld.cinema.badge")}</span>
          </span>
          <span className="the-world-cinema-spotlight">
            {store.cinemaSpotlight || t("theWorld.cinema.defaultSpotlight")}
          </span>
          <button
            type="button"
            className="the-world-cinema-exit-btn"
            aria-label={t("theWorld.cinema.exitAria")}
            onClick={() => {
              playDistrictSelect();
              if (onToggleCinemaMode) onToggleCinemaMode();
              else toggleCinemaMode();
            }}
          >
            <span>{t("theWorld.cinema.exit")}</span>
            <kbd className="the-world-keycap">C</kbd>
          </button>
        </div>
      ) : null}

      {/* 하단 좌측 미니 액션 필: 이모트(1·2·3) + 제독 외형 꾸미기 */}
      {!hideBottom && !store.photoMode && !store.cinemaMode && !store.chatActive ? (
        <div
          className="the-world-quick-bar"
          role="toolbar"
          aria-label={t("theWorld.hud.quickBarAria")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="the-world-bar">
            <button
              type="button"
              className="the-world-btn the-world-quick-btn"
              aria-label={t("theWorld.emote.wave")}
              title={t("theWorld.emote.wave")}
              onClick={() => handleTriggerEmote("wave")}
            >
              <span className="the-world-keycap">1</span>
              <WorldIcon name="greet" size={13} tone="amber" />
              <span>{t("theWorld.hud.emoteWave")}</span>
            </button>

            <button
              type="button"
              className="the-world-btn the-world-quick-btn"
              aria-label={t("theWorld.emote.cheer")}
              title={t("theWorld.emote.cheer")}
              onClick={() => handleTriggerEmote("cheer")}
            >
              <span className="the-world-keycap">2</span>
              <WorldIcon name="cheer" size={13} tone="rose" />
              <span>{t("theWorld.hud.emoteCheer")}</span>
            </button>

            <button
              type="button"
              className="the-world-btn the-world-quick-btn"
              aria-label={t("theWorld.emote.jump")}
              title={t("theWorld.emote.jump")}
              onClick={() => handleTriggerEmote("jump")}
            >
              <span className="the-world-keycap">3</span>
              <WorldIcon name="spin" size={13} tone="cerulean" />
              <span>{t("theWorld.hud.emoteSpin")}</span>
            </button>

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className={`the-world-btn the-world-quick-btn${store.admiralCustomizerOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.lookAria")}
              aria-pressed={store.admiralCustomizerOpen}
              title={t("theWorld.hud.admiralStyleAria")}
              onClick={handleOpenCustomizer}
            >
              <WorldIcon name="hat" size={13} tone="amber" />
              <span>{t("theWorld.hud.lookLabel")}</span>
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
});
