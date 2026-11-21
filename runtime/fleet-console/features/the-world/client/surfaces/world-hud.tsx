import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useState } from "react";

import { ApprovalCapsule } from "../../../execution/client/approval/panel.js";
import type { WorldCameraMode, WorldSnapshot, WorldTimeMode, WorldWeatherMode } from "../../shared/world-types.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  exitTheWorld,
  openAdmiralCustomizer,
  openQuestBoard,
  openWarRoom,
  requestWorldTeleport,
  setWeatherMode,
  setWorldCameraMode,
  setWorldTimeMode,
  toggleOverviewMode,
  togglePhotoMode,
  toggleSoundMuted,
  triggerWorldChoreography,
  useWorldStore,
} from "../world-store.js";
import {
  playDistrictHover,
  playDistrictSelect,
  playOverviewToggle,
  playPhotoShutter,
  setWorldAudioMuted,
} from "../engine/world-audio.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

const TIME_MODES: readonly {
  readonly id: WorldTimeMode;
  readonly label: string;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "day", label: "낮", icon: "sun", tone: "amber" },
  { id: "sunset", label: "노을", icon: "sunset", tone: "rose" },
  { id: "night", label: "밤", icon: "moon", tone: "indigo" },
  { id: "cycle", label: "순환", icon: "cycle", tone: "teal" },
  { id: "realtime", label: "현실", icon: "clock", tone: "cerulean" },
];

const CAMERA_MODES: readonly {
  readonly id: WorldCameraMode;
  readonly label: string;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "follow", label: "3인칭 추적", icon: "cameraFollow", tone: "teal" },
  { id: "orbit", label: "초원 조망", icon: "cameraOrbit", tone: "moss" },
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

/**
 * 미니멀 게임 HUD.
 *
 * 화면을 가리는 테스트·환경 버튼(시간대·날씨·카메라·협동 연출 테스트)을 우측 상단의
 * 단일 「디버그·도구」 크리스탈 팝오버 안으로 통합해, 평소 초원 시야를 최대한 넓게 비워 둔다.
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
}: {
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
}) {
  const store = useWorldStore();
  const [debugOpen, setDebugOpen] = useState(false);
  const [warpOpen, setWarpOpen] = useState(false);
  const t = getWorldT(locale);
  const effectiveUrgentCount = urgentQuestCount ?? snapshot.attentionCount;
  const attentionActor = snapshot.actors.find((a) => a.needsAttention) ?? null;

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
                  setDebugOpen(false);
                  setWarpOpen(false);
                  playDistrictSelect();
                  openQuestBoard();
                }}
              >
                <WorldIcon name="bell" size={14} tone="amber" />
                <span>
                  {attentionActor
                    ? `확인 필요 · ${attentionActor.name}`
                    : t("theWorld.noticeBoard.urgentBadge", { count: effectiveUrgentCount })}
                </span>
                <span className="the-world-hud-badge">{effectiveUrgentCount}</span>
              </button>
            </div>
          ) : null}

          <div className="the-world-bar">
            <button
              type="button"
              className={`the-world-btn${store.questBoardOpen ? " is-active" : ""}${effectiveUrgentCount > 0 ? " is-attention" : ""}`}
              aria-label={t("theWorld.hud.questBoardAria")}
              aria-pressed={store.questBoardOpen}
              title={t("theWorld.hud.questBoardTitle")}
              onClick={() => {
                setDebugOpen(false);
                setWarpOpen(false);
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

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className={`the-world-btn${store.warRoomOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.warRoomAria")}
              aria-pressed={store.warRoomOpen}
              title={t("theWorld.hud.warRoomTitle")}
              onClick={() => {
                setDebugOpen(false);
                setWarpOpen(false);
                playDistrictSelect();
                if (onOpenWarRoom) onOpenWarRoom();
                else openWarRoom();
              }}
            >
              <WorldIcon name="warRoom" size={14} tone={store.warRoomOpen ? "amber" : "teal"} />
              <span>{t("theWorld.hud.warRoomLabel")}</span>
            </button>

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className="the-world-btn"
              title={t("theWorld.hud.createCommodoreTitle")}
              onClick={onCreateCommodore}
            >
              <WorldIcon name="recruit" size={14} tone="amber" />
              <span>새 사령관</span>
            </button>

            <span className="the-world-bar-sep" aria-hidden="true" />

            <ApprovalCapsule />

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className={`the-world-btn${store.overviewMode ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.overviewAria")}
              aria-pressed={store.overviewMode}
              title={t("theWorld.hud.overviewTitle")}
              onClick={() => {
                playOverviewToggle(!store.overviewMode);
                toggleOverviewMode();
              }}
            >
              <WorldIcon name="mapOverview" size={14} tone={store.overviewMode ? "amber" : "moss"} />
              <span>{t("theWorld.hud.overviewLabel")}</span>
            </button>

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className={`the-world-btn${store.photoMode ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.photoModeAria")}
              aria-pressed={store.photoMode}
              title={t("theWorld.hud.photoModeTitle")}
              onClick={() => {
                setDebugOpen(false);
                setWarpOpen(false);
                playPhotoShutter();
                togglePhotoMode();
              }}
            >
              <WorldIcon name="camera" size={14} tone={store.photoMode ? "amber" : "cerulean"} />
              <span>{t("theWorld.hud.photoModeLabel")}</span>
            </button>

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className={`the-world-btn${!store.soundMuted ? " is-active" : ""}`}
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

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className={`the-world-btn${debugOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.debugAria")}
              aria-expanded={debugOpen}
              title={t("theWorld.hud.debugTitle")}
              onClick={() => {
                setWarpOpen(false);
                setDebugOpen((prev) => !prev);
              }}
            >
              <WorldIcon name="tool" size={14} tone={debugOpen ? "amber" : "cerulean"} />
              <span>디버그</span>
            </button>

            <span className="the-world-bar-sep" aria-hidden="true" />

            <button
              type="button"
              className="the-world-btn"
              onClick={() => exitTheWorld({ reducedMotion })}
            >
              <WorldIcon name="portalExit" size={14} tone="cerulean" />
              <span>콘솔</span>
            </button>
          </div>
        </div>

        {/* 통합 디버그 · 환경 도구 크리스탈 팝오버 */}
        {debugOpen ? (
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
                <span>월드 디버그 · 도구</span>
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
                <span className="the-world-debug-label">시간대</span>
                <div className="the-world-debug-pills" role="group" aria-label={t("theWorld.hud.timeGroupAria")}>
                  {TIME_MODES.map((item) => {
                    const active = store.timeMode === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`the-world-debug-pill${active ? " is-active" : ""}`}
                        onClick={() => setWorldTimeMode(item.id)}
                      >
                        <WorldIcon name={item.icon} size={13} tone={active ? "amber" : item.tone} />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="the-world-debug-section">
                <span className="the-world-debug-label">{t("theWorld.weather.label")}</span>
                <div className="the-world-debug-pills" role="group" aria-label={t("theWorld.weather.groupAria")}>
                  {WEATHER_MODES.map((item) => {
                    const active = store.weatherMode === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`the-world-debug-pill${active ? " is-active" : ""}`}
                        aria-pressed={active}
                        onClick={() => {
                          playDistrictHover();
                          setWeatherMode(item.id);
                        }}
                      >
                        <WorldIcon name={item.icon} size={13} tone={active ? "amber" : item.tone} />
                        <span>{t(item.key)}</span>
                      </button>
                    );
                  })}
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

              <div className="the-world-debug-section">
                <span className="the-world-debug-label">카메라 시점</span>
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
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="the-world-debug-section">
                <span className="the-world-debug-label">협동 연출 테스트</span>
                <div className="the-world-debug-grid" role="group" aria-label={t("theWorld.hud.simGroupAria")}>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("delegate");
                      onStatusBanner("사령관이 청사진을 발송하고 지휘관이 구성원을 소집합니다.");
                    }}
                  >
                    <WorldIcon name="scroll" size={13} tone="amber" />
                    <span>목표 하달</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("report");
                      onStatusBanner("구성원이 결과물을 들고 지휘관에게 보고합니다.");
                    }}
                  >
                    <WorldIcon name="crate" size={13} tone="rose" />
                    <span>보고·하이파이브</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("handoff");
                      onStatusBanner("선행·후속 구성원이 커밋 바통을 인수인계합니다.");
                    }}
                  >
                    <WorldIcon name="baton" size={13} tone="cerulean" />
                    <span>바통 터치</span>
                  </button>
                  <button
                    type="button"
                    className="the-world-debug-pill"
                    onClick={() => {
                      triggerWorldChoreography("celebrate");
                      onStatusBanner("초원 전 구역이 목표 완수 축포를 터뜨립니다.");
                    }}
                  >
                    <WorldIcon name="confetti" size={13} tone="amber" />
                    <span>완수 축포</span>
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
                    aria-label={t("theWorld.hud.admiralStyleAria")}
                    onClick={() => {
                      playDistrictSelect();
                      setDebugOpen(false);
                      if (onOpenAdmiralCustomizer) onOpenAdmiralCustomizer();
                      else openAdmiralCustomizer();
                    }}
                  >
                    <WorldIcon name="hat" size={13} tone="amber" />
                    <span>{t("theWorld.hud.admiralStyleBtn")}</span>
                  </button>
                </div>
              </div>

              <div className="the-world-debug-footnote">
                WASD 이동 · Shift 질주 · Space 점프 · 1·2·3 감정표현 · M 하늘 조망 · P 포토 · E 상호작용
              </div>
            </div>
          </section>
        ) : null}
      </div>

      {!hideBottom && snapshot.zones.length > 0 ? (
        <div className="the-world-hud-bottom">
          <div className="the-world-warp-wrap">
            {warpOpen ? (
              <div
                className="the-world-warp-menu"
                role="menu"
                aria-label={t("theWorld.hud.teleportGroupAria")}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="the-world-crest" aria-hidden="true" />
                <div className="the-world-warp-list">
                  {snapshot.zones.map((zone) => (
                    <button
                      key={zone.id}
                      type="button"
                      role="menuitem"
                      className="the-world-warp-item"
                      onClick={() => {
                        requestWorldTeleport(zone.x, zone.z);
                        setWarpOpen(false);
                        onStatusBanner(`${zone.label} 구역으로 이동했습니다.`);
                      }}
                    >
                      <WorldIcon name="compass" size={13} tone="amber" />
                      <span>{zone.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="the-world-bar">
              <button
                type="button"
                className={`the-world-btn${warpOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.warpAria")}
                aria-expanded={warpOpen}
                onClick={() => {
                  setDebugOpen(false);
                  setWarpOpen((prev) => !prev);
                }}
              >
                <WorldIcon name="compass" size={14} tone="amber" />
                <span>구역 이동</span>
                <span aria-hidden="true">{warpOpen ? "▾" : "▴"}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
});
