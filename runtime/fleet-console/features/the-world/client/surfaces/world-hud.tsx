import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useState } from "react";

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
  playPhotoShutter,
  setWorldAudioMuted,
} from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  exitTheWorld,
  openAdmiralCustomizer,
  openQuestBoard,
  openWarRoom,
  requestPlayerEmote,
  setWeatherMode,
  setWorldCameraMode,
  setWorldTimeMode,
  toggleBgm,
  toggleCinemaMode,
  toggleEmoteWheel,
  toggleGazette,
  toggleOverviewMode,
  togglePhotoMode,
  toggleSoundMuted,
  triggerWorldChoreography,
  useWorldStore,
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
  readonly debugPanelVisible?: boolean | undefined;
}

/**
 * 다이어트된 미니멀 게임 HUD.
 *
 * - 우상단: 핵심 액션(`상황실` · `퀘스트` · `하늘 조망`) + 환경 퀵 팝오버(날씨·시간대) + `포토` · `사운드` · `?` · `콘솔`
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
  debugPanelVisible = false,
}: WorldHudProps) {
  const store = useWorldStore();
  const [envOpen, setEnvOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const t = getWorldT(locale);
  const effectiveUrgentCount = urgentQuestCount ?? snapshot.attentionCount;
  const attentionActor = snapshot.actors.find((a) => a.needsAttention) ?? null;

  const activeWeather = weatherModeProp ?? store.weatherMode;
  const activeTime = timeModeProp ?? store.timeMode;
  const activeWeatherMeta = WEATHER_MODES.find((w) => w.id === activeWeather) ?? WEATHER_MODES[0]!;

  useEffect(() => {
    if (!debugPanelVisible && debugOpen) {
      setDebugOpen(false);
    }
  }, [debugOpen, debugPanelVisible]);

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
    setEnvOpen(false);
    setDebugOpen(false);
    if (onOpenCustomizer) onOpenCustomizer();
    else if (onOpenAdmiralCustomizer) onOpenAdmiralCustomizer();
    else openAdmiralCustomizer();
  };

  const handleTriggerEmote = (emote: WorldPlayerEmote) => {
    if (onTriggerEmote) onTriggerEmote(emote);
    else requestPlayerEmote(emote);
  };

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

      <div className="the-world-hud-top">
        <div className="the-world-hud-cluster">
          {effectiveUrgentCount > 0 ? (
            <div className="the-world-bar is-attention-bar">
              <button
                type="button"
                className="the-world-btn is-attention"
                aria-label={t("theWorld.hud.questBoardAria")}
                onClick={() => {
                  setEnvOpen(false);
                  setDebugOpen(false);
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
            {/* 핵심 액션 3종: 상황실 · 퀘스트 · 하늘 조망 */}
            <button
              type="button"
              className={`the-world-btn${store.warRoomOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.warRoomAria")}
              aria-pressed={store.warRoomOpen}
              title={t("theWorld.hud.warRoomTitle")}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
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
                setEnvOpen(false);
                setDebugOpen(false);
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
                setEnvOpen(false);
                setDebugOpen(false);
                playOverviewToggle(!store.overviewMode);
                toggleOverviewMode();
              }}
            >
              <WorldIcon name={store.overviewMode ? "sparkle" : "mapOverview"} size={14} tone={store.overviewMode ? "amber" : "moss"} />
              <span>{t("theWorld.hud.overviewLabel")}</span>
            </button>

            <button
              type="button"
              className={`the-world-btn is-icon-only${store.gazetteOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.gazetteAria")}
              aria-pressed={store.gazetteOpen}
              title={t("theWorld.hud.gazetteTitle")}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
                playDistrictSelect();
                if (onOpenGazette) onOpenGazette();
                else toggleGazette();
              }}
            >
              <WorldIcon name="gazette" size={14} tone={store.gazetteOpen ? "amber" : "amber"} />
            </button>

            <button
              type="button"
              className={`the-world-btn is-icon-only${store.cinemaMode ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.cinemaAria")}
              aria-pressed={store.cinemaMode}
              title={t("theWorld.hud.cinemaTitle")}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
                playDistrictSelect();
                if (onToggleCinemaMode) onToggleCinemaMode();
                else toggleCinemaMode();
              }}
            >
              <WorldIcon name="cinema" size={14} tone={store.cinemaMode ? "amber" : "teal"} />
            </button>

            <button
              type="button"
              className="the-world-btn is-icon-only"
              aria-label={t("theWorld.hud.createCommodoreAria")}
              title={t("theWorld.hud.createCommodoreTitle")}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
                onCreateCommodore();
              }}
            >
              <WorldIcon name="recruit" size={14} tone="amber" />
            </button>

            <ApprovalCapsule />

            <span className="the-world-bar-sep" aria-hidden="true" />

            {/* 환경 퀵 팝오버 · 포토 · 사운드 · 조작 가이드(?) · (옵션) 디버그 · 콘솔 */}
            <button
              type="button"
              className={`the-world-btn${envOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.envAria")}
              aria-expanded={envOpen}
              title={t("theWorld.hud.envTitle")}
              onClick={() => {
                setDebugOpen(false);
                setEnvOpen((prev) => !prev);
              }}
            >
              <WorldIcon
                name={activeWeather === "clear" ? "weather" : activeWeatherMeta.icon}
                size={14}
                tone={envOpen ? "amber" : activeWeatherMeta.tone}
              />
              <span>{t("theWorld.hud.envLabel")}</span>
            </button>

            <button
              type="button"
              className={`the-world-btn is-icon-only${store.emoteWheelOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.emoteBtn")}
              aria-pressed={store.emoteWheelOpen}
              title={t("theWorld.hud.emoteBtn")}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
                playDistrictSelect();
                toggleEmoteWheel();
              }}
            >
              <WorldIcon name="cheer" size={14} tone={store.emoteWheelOpen ? "amber" : "rose"} />
            </button>

            <button
              type="button"
              className={`the-world-btn is-icon-only${store.photoMode ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.photoModeAria")}
              aria-pressed={store.photoMode}
              title={t("theWorld.hud.photoModeTitle")}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
                playPhotoShutter();
                togglePhotoMode();
              }}
            >
              <WorldIcon name="camera" size={14} tone={store.photoMode ? "amber" : "cerulean"} />
            </button>

            <button
              type="button"
              className={`the-world-btn is-icon-only${!store.soundMuted ? " is-active" : ""}`}
              aria-label={store.soundMuted ? t("theWorld.hud.soundOffAria") : t("theWorld.hud.soundOnAria")}
              aria-pressed={!store.soundMuted}
              title={store.soundMuted ? t("theWorld.hud.soundOffTitle") : t("theWorld.hud.soundOnTitle")}
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
            </button>

            <button
              type="button"
              className="the-world-btn is-icon-only"
              aria-label={t("theWorld.hud.guideAria")}
              title={t("theWorld.hud.guideTitle")}
              onClick={() => {
                setEnvOpen(false);
                setDebugOpen(false);
                playDistrictSelect();
                onToggleControlsGuide?.();
              }}
            >
              <WorldIcon name="question" size={14} tone="amber" />
            </button>

            {debugPanelVisible ? (
              <button
                type="button"
                className={`the-world-btn is-icon-only${debugOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.debugAria")}
                aria-expanded={debugOpen}
                title={t("theWorld.hud.debugTitle")}
                onClick={() => {
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
                  <span className="the-world-bgm-hint">{t("theWorld.hud.bgmHint")}</span>
                </div>
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
