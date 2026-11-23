import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { ApprovalCapsule } from "../../../execution/client/approval/panel.js";
import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import type {
  WorldCameraMode,
  WorldDistrictSpec,
  WorldPlayerEmote,
  WorldSnapshot,
  WorldTimeMode,
  WorldVillageSpec,
  WorldWeatherMode,
} from "../../shared/world-types.js";
import {
  playDistrictHover,
  playDistrictSelect,
  playOverviewToggle,
  playPhotoShutter,
  playWarp,
  setWorldAudioMuted,
} from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  closeAllHudPopovers,
  exitTheWorld,
  openAdmiralCustomizer,
  openMailbox,
  openQuestBoard,
  openWarRoom,
  requestPlayerEmote,
  requestWorldTeleport,
  resetWorldProgressData,
  selectDistrict,
  setDebugPopoverOpen,
  setQuickJumpOpen,
  setToolsMenuOpen,
  setWeatherMode,
  setWeatherPopoverOpen,
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
  useCurrentZone,
  useWorldStore,
  WORLD_STAMP_IDS,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

const ONBOARDING_HINT_DISMISSED_KEY = "fleet.theWorld.onboardingHintDismissed.v1";

function readOnboardingHintDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function persistOnboardingHintDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONBOARDING_HINT_DISMISSED_KEY, "1");
  } catch {
    // 저장소 접근 불가 환경에서는 메모리 상태만 유지한다.
  }
}

const TIME_MODES: readonly {
  readonly id: WorldTimeMode;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "realtime", key: "theWorld.hud.timeAuto", icon: "clock", tone: "cerulean" },
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

export interface WorldFlightRingGuideProps {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly chevronRef: RefObject<HTMLSpanElement | null>;
  readonly distRef: RefObject<HTMLSpanElement | null>;
  readonly altRef?: RefObject<HTMLSpanElement | null> | undefined;
  readonly locale: ConsoleLocale | undefined;
}

/**
 * 별빛 비행 중 화면 가장자리에 표시되는 다음 황금 별빛 링 방향·거리 가이드.
 * Wave 2 `world-stage.tsx`에서 `ringGuideElRef` / `ringGuideChevronRef` / `ringGuideDistRef` / `ringGuideAltRef`를 연결해 사용한다.
 */
export const WorldFlightRingGuide = memo(function WorldFlightRingGuide({
  containerRef,
  chevronRef,
  distRef,
  altRef,
  locale,
}: WorldFlightRingGuideProps) {
  const t = getWorldT(locale);
  return (
    <div
      ref={containerRef}
      className="the-world-ring-guide-arrow"
      style={{ opacity: 0 }}
      aria-hidden="true"
    >
      <span ref={chevronRef} className="the-world-ring-guide-chevron">➤</span>
      <WorldIcon name="sparkle" size={12} tone="amber" />
      <span className="the-world-ring-guide-label">{t("theWorld.flight.ringGuideLabel")}</span>
      <span ref={distRef} className="the-world-ring-guide-dist">0m</span>
      {altRef ? <span ref={altRef} className="the-world-ring-guide-alt" style={{ display: "none" }} /> : null}
    </div>
  );
});

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
  readonly controlsGuideOpen?: boolean | undefined;
  readonly onOpenGazette?: (() => void) | undefined;
  readonly onToggleCinemaMode?: (() => void) | undefined;
  readonly onToggleBgm?: (() => void) | undefined;
  readonly unreadMailCount?: number | undefined;
  readonly onOpenMailbox?: (() => void) | undefined;
  readonly onRingParadeBell?: (() => void) | undefined;
  readonly villages?: readonly WorldVillageSpec[] | undefined;
  readonly onWarpTo?: ((x: number, z: number, label: string) => void) | undefined;
  readonly onWarpToDistrict?: ((district: WorldDistrictSpec, village: WorldVillageSpec) => void) | undefined;
  readonly fastTravelOpen?: boolean | undefined;
  readonly onToggleFastTravel?: (() => void) | undefined;
  readonly onResetWorldLocalData?: (() => void) | undefined;
  readonly debugPanelVisible?: boolean | undefined;
  readonly currentZoneLabel?: string | null | undefined;
  readonly currentZoneTone?: IdentityTone | null | undefined;
}

/**
 * 고대비 Starlight Glass 미니멀 게임 HUD.
 *
 * - 좌상단: 현재 체류 구역명 배지(클릭 시 빠른 이동 `G`)
 * - 우상단: 핵심 액션(`상황실` · `퀘스트` · `별빛 비행`) + 미확인 우편 배지 + `빠른 이동 [G]` + `도구 ▾` + `?` 가이드 + `콘솔`
 * - 모든 HUD 팝오버(`quickJump` · `tools` · `weather` · `debug`)는 `world-store.ts` 상태로 통합 관리되어
 *   `Esc` 입력 시 최상위 1겹만 닫고 더 월드 전체를 종료하지 않는다.
 * - 최초 진입 1회성 경량 조작 힌트(`localStorage` 닫기 기억)와 하단 좌측 이모트(1·2·3)·외형 퀵 바 제공.
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
  controlsGuideOpen = false,
  onOpenGazette,
  onToggleCinemaMode,
  onToggleBgm,
  unreadMailCount = 0,
  onOpenMailbox,
  villages: villagesProp,
  onWarpTo,
  onWarpToDistrict,
  fastTravelOpen: fastTravelOpenProp,
  onToggleFastTravel,
  onResetWorldLocalData,
  debugPanelVisible = false,
  currentZoneLabel: currentZoneLabelProp,
  currentZoneTone: currentZoneToneProp,
}: WorldHudProps) {
  const store = useWorldStore();
  const currentZone = useCurrentZone();
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [fastTravelQuery, setFastTravelQuery] = useState("");
  const [expandedVillageIds, setExpandedVillageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [listHasMoreBelow, setListHasMoreBelow] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(readOnboardingHintDismissed);
  const hudTopRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const fastTravelListRef = useRef<HTMLDivElement | null>(null);
  const t = getWorldT(locale);

  const toolsOpen = store.toolsMenuOpen;
  const envOpen = store.weatherPopoverOpen;
  const debugOpen = store.debugPopoverOpen;
  const isFastTravelOpen = fastTravelOpenProp !== undefined
    ? (fastTravelOpenProp || store.quickJumpOpen)
    : store.quickJumpOpen;

  const effectiveUrgentCount = urgentQuestCount ?? snapshot.attentionCount;
  const effectiveUnreadMail = Math.max(0, unreadMailCount);
  const effectiveVillages = villagesProp ?? snapshot.villages;
  const attentionActor = snapshot.actors.find((a) => a.needsAttention) ?? null;

  const activeWeather = weatherModeProp ?? store.weatherMode;
  const activeTime = timeModeProp ?? store.timeMode;
  const activeWeatherMeta = WEATHER_MODES.find((w) => w.id === activeWeather) ?? WEATHER_MODES[0]!;
  const plazaLabel = t("theWorld.projection.plazaLabel");

  const resolvedZoneLabel = currentZoneLabelProp ?? currentZone?.label ?? plazaLabel;
  const resolvedZoneTone = currentZoneToneProp ?? currentZone?.tone ?? "amber";

  const totalDistrictCount = useMemo(
    () => effectiveVillages.reduce((acc, v) => acc + v.districts.length, 0),
    [effectiveVillages],
  );

  // Prop-driven fastTravelOpen과 스토어 quickJumpOpen 동기화
  useEffect(() => {
    if (fastTravelOpenProp === undefined) return;
    if (fastTravelOpenProp && !store.quickJumpOpen) {
      setQuickJumpOpen(true);
    } else if (!fastTravelOpenProp && store.quickJumpOpen) {
      setQuickJumpOpen(false);
    }
  }, [fastTravelOpenProp, store.quickJumpOpen]);

  useEffect(() => {
    if (!debugPanelVisible && debugOpen) {
      setDebugPopoverOpen(false);
    }
  }, [debugOpen, debugPanelVisible]);

  useEffect(() => {
    if (!toolsOpen && resetConfirmOpen) {
      setResetConfirmOpen(false);
    }
  }, [resetConfirmOpen, toolsOpen]);

  useEffect(() => {
    if (isFastTravelOpen) {
      const id = window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    setFastTravelQuery("");
    return undefined;
  }, [isFastTravelOpen]);

  const closeAllPopovers = useCallback(() => {
    const hadFastTravelProp = fastTravelOpenProp === true;
    closeAllHudPopovers();
    if (hadFastTravelProp && onToggleFastTravel) {
      onToggleFastTravel();
    }
  }, [fastTravelOpenProp, onToggleFastTravel]);

  const handleToggleFastTravel = useCallback(() => {
    playDistrictHover();
    if (isFastTravelOpen) {
      setQuickJumpOpen(false);
      if (fastTravelOpenProp === true && onToggleFastTravel) {
        onToggleFastTravel();
      }
    } else {
      setQuickJumpOpen(true);
      if (fastTravelOpenProp === false && onToggleFastTravel) {
        onToggleFastTravel();
      }
    }
  }, [fastTravelOpenProp, isFastTravelOpen, onToggleFastTravel]);

  useEffect(() => {
    if (!toolsOpen && !envOpen && !debugOpen && !isFastTravelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        hudTopRef.current
        && event.target instanceof Node
        && hudTopRef.current.contains(event.target)
      ) {
        return;
      }
      closeAllPopovers();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 최상위 HUD 팝오버만 닫고 이벤트 전파를 차단해 더 월드 전체가 닫히지 않도록 보장한다.
      event.preventDefault();
      event.stopPropagation();
      if (isFastTravelOpen && fastTravelQuery.trim().length > 0) {
        setFastTravelQuery("");
        return;
      }
      closeAllPopovers();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeAllPopovers, debugOpen, envOpen, fastTravelQuery, isFastTravelOpen, toolsOpen]);

  // 빠른 이동 검색 필터링 (광장 + 사령관 + 개별 구역 통합 검색)
  const normalizedQuery = fastTravelQuery.trim().toLowerCase();
  const showPlazaResult = normalizedQuery.length === 0
    || plazaLabel.toLowerCase().includes(normalizedQuery)
    || "hq".includes(normalizedQuery)
    || "plaza".includes(normalizedQuery);

  const filteredVillages = useMemo(() => {
    if (!normalizedQuery) {
      return effectiveVillages.map((village) => ({
        village,
        matchedDistricts: village.districts,
        villageMatched: true,
      }));
    }
    const results: {
      readonly village: WorldVillageSpec;
      readonly matchedDistricts: readonly WorldDistrictSpec[];
      readonly villageMatched: boolean;
    }[] = [];
    for (const village of effectiveVillages) {
      const villageMatched = village.label.toLowerCase().includes(normalizedQuery);
      const matchedDistricts = village.districts.filter((d) =>
        d.label.toLowerCase().includes(normalizedQuery)
        || d.theaterId.toLowerCase().includes(normalizedQuery),
      );
      if (villageMatched || matchedDistricts.length > 0) {
        results.push({
          village,
          matchedDistricts: villageMatched && matchedDistricts.length === 0 ? village.districts : matchedDistricts,
          villageMatched,
        });
      }
    }
    return results;
  }, [effectiveVillages, normalizedQuery]);

  const updateListScrollHint = useCallback(() => {
    const el = fastTravelListRef.current;
    if (!el) {
      setListHasMoreBelow(false);
      return;
    }
    setListHasMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 6);
  }, []);

  useEffect(() => {
    if (!isFastTravelOpen) {
      setListHasMoreBelow(false);
      return;
    }
    const id = window.requestAnimationFrame(updateListScrollHint);
    return () => window.cancelAnimationFrame(id);
  }, [expandedVillageIds, filteredVillages, isFastTravelOpen, updateListScrollHint]);

  const handleWarpDestination = (x: number, z: number, label: string, toastText?: string) => {
    closeAllPopovers();
    playWarp();
    if (onWarpTo) {
      onWarpTo(x, z, label);
    } else {
      requestWorldTeleport(x, z);
      onStatusBanner(toastText ?? t("theWorld.stage.warpVillageToast", { name: label }));
    }
  };

  const handleWarpDistrict = (district: WorldDistrictSpec, village: WorldVillageSpec) => {
    closeAllPopovers();
    playWarp();
    if (onWarpToDistrict) {
      onWarpToDistrict(district, village);
      return;
    }
    const approachX = village.x + Math.cos(village.gateAngle) * Math.max(2.0, village.radius * 0.42);
    const approachZ = village.z + Math.sin(village.gateAngle) * Math.max(2.0, village.radius * 0.42);
    if (onWarpTo) {
      onWarpTo(approachX, approachZ, `${village.label} · ${district.label}`);
    } else {
      requestWorldTeleport(approachX, approachZ);
      onStatusBanner(t("theWorld.stage.warpVillageToast", { name: `${village.label} · ${district.label}` }));
    }
    selectDistrict(district.id);
  };

  const toggleVillageDistricts = (villageId: string) => {
    playDistrictHover();
    setExpandedVillageIds((prev) => {
      const next = new Set(prev);
      if (next.has(villageId)) next.delete(villageId);
      else next.add(villageId);
      return next;
    });
  };

  const handleConfirmResetProgress = () => {
    resetWorldProgressData();
    onResetWorldLocalData?.();
    setResetConfirmOpen(false);
    closeAllPopovers();
    playDistrictSelect();
    onStatusBanner(t("theWorld.hud.resetToast"));
  };

  const handleOpenMailbox = () => {
    closeAllPopovers();
    playDistrictSelect();
    if (onOpenMailbox) onOpenMailbox();
    else openMailbox();
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

  const handleDismissOnboarding = () => {
    setOnboardingDismissed(true);
    persistOnboardingHintDismissed();
  };

  const isAnyPopoverOpen = toolsOpen || envOpen || debugOpen || isFastTravelOpen;
  const showOnboardingHint =
    !onboardingDismissed
    && !hideBottom
    && !store.photoMode
    && !store.cinemaMode
    && !store.overviewMode
    && !store.chatActive
    && !isAnyPopoverOpen;

  return (
    <>
      {/* 좌상단 현재 체류 구역 배지 (항상 깔끔히 표시 · 클릭 시 빠른 이동 G) */}
      {!store.photoMode && !store.cinemaMode ? (
        <button
          type="button"
          className="the-world-zone-badge"
          aria-label={t("theWorld.hud.zoneAria", { zone: resolvedZoneLabel })}
          title={t("theWorld.hud.fastTravelAria")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleToggleFastTravel}
        >
          <span className="the-world-tone-dot" data-tone={resolvedZoneTone} />
          <span className="the-world-zone-badge-name">{resolvedZoneLabel}</span>
          <kbd className="the-world-keycap">G</kbd>
        </button>
      ) : null}

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
                aria-label={t("theWorld.hud.mailboxAria")}
                aria-pressed={store.mailboxOpen}
                title={t("theWorld.hud.mailboxLabel")}
                onClick={handleOpenMailbox}
              >
                <WorldIcon name="mail" size={14} tone="amber" />
                <span className="the-world-hud-badge">{effectiveUnreadMail}</span>
              </button>
            ) : null}

            {/* 빠른 이동 (G) — 명확한 라벨 + G 키캡 */}
            <button
              type="button"
              className={`the-world-btn${isFastTravelOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.fastTravelAria")}
              aria-expanded={isFastTravelOpen}
              title={t("theWorld.hud.fastTravelAria")}
              onClick={handleToggleFastTravel}
            >
              <WorldIcon name="compass" size={14} tone={isFastTravelOpen ? "amber" : "cerulean"} />
              <span>{t("theWorld.hud.fastTravelLabel")}</span>
              <kbd className="the-world-keycap">G</kbd>
            </button>

            {/* 통합 도구 드롭다운 버튼 */}
            <button
              type="button"
              className={`the-world-btn${toolsOpen || envOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.toolsAria")}
              aria-expanded={toolsOpen}
              title={t("theWorld.hud.toolsLabel")}
              onClick={() => {
                const next = !toolsOpen;
                if (fastTravelOpenProp === true && onToggleFastTravel) {
                  onToggleFastTravel();
                }
                playDistrictHover();
                setToolsMenuOpen(next);
              }}
            >
              <WorldIcon name="settings" size={14} tone={toolsOpen || envOpen ? "amber" : "cerulean"} />
              <span>{t("theWorld.hud.toolsLabel")}</span>
              <span className="the-world-tools-caret" aria-hidden="true">{toolsOpen ? "▴" : "▾"}</span>
            </button>

            {/* 독립 도움말(?) 조작 가이드 버튼 */}
            <button
              type="button"
              className={`the-world-btn the-world-help-btn${controlsGuideOpen ? " is-active" : ""}`}
              aria-label={t("theWorld.hud.guideAria")}
              aria-pressed={controlsGuideOpen}
              title={t("theWorld.hud.guideTitle")}
              onClick={() => {
                closeAllPopovers();
                playDistrictSelect();
                onToggleControlsGuide?.();
              }}
            >
              <WorldIcon name="question" size={14} tone={controlsGuideOpen ? "amber" : "cerulean"} />
              <kbd className="the-world-keycap">?</kbd>
            </button>

            {debugPanelVisible ? (
              <button
                type="button"
                className={`the-world-btn is-icon-only${debugOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.debugAria")}
                aria-expanded={debugOpen}
                title={t("theWorld.hud.debugTitle")}
                onClick={() => {
                  const next = !debugOpen;
                  if (fastTravelOpenProp === true && onToggleFastTravel) {
                    onToggleFastTravel();
                  }
                  setDebugPopoverOpen(next);
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

        {/* 빠른 이동 (G) Starlight Glass 팝오버 — 통합 검색 · 카운트 · 스크롤 힌트 · 단일 Tier */}
        {isFastTravelOpen ? (
          <section
            className="the-world-debug-popover the-world-fast-travel-popover"
            role="dialog"
            aria-label={t("theWorld.hud.fastTravelAria")}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="the-world-crest" aria-hidden="true" />
            <header className="the-world-debug-head">
              <span className="the-world-debug-title">
                <WorldIcon name="compass" size={13} tone="amber" />
                <span>{t("theWorld.hud.fastTravelLabel")}</span>
                <kbd className="the-world-keycap">G</kbd>
              </span>
              <span className="the-world-fast-travel-count">
                {t("theWorld.fastTravel.summaryCount", {
                  villages: effectiveVillages.length,
                  districts: totalDistrictCount,
                })}
              </span>
              <button
                type="button"
                className="the-world-chat-icon-btn"
                aria-label={t("theWorld.panel.closeAria")}
                onClick={handleToggleFastTravel}
              >
                <WorldIcon name="close" size={14} />
              </button>
            </header>

            <div className="the-world-fast-travel-search">
              <WorldIcon name="inspect" size={13} tone="cerulean" />
              <input
                ref={searchInputRef}
                type="text"
                className="the-world-fast-travel-search-input"
                value={fastTravelQuery}
                onChange={(e) => setFastTravelQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (fastTravelQuery.trim().length > 0) {
                      setFastTravelQuery("");
                    } else {
                      closeAllPopovers();
                    }
                  } else {
                    e.stopPropagation();
                  }
                }}
                placeholder={t("theWorld.fastTravel.searchPlaceholder")}
                aria-label={t("theWorld.fastTravel.searchAria")}
              />
              {fastTravelQuery.length > 0 ? (
                <button
                  type="button"
                  className="the-world-fast-travel-search-clear"
                  aria-label={t("theWorld.fastTravel.clearSearchAria")}
                  onClick={() => {
                    setFastTravelQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <WorldIcon name="close" size={11} />
                </button>
              ) : null}
            </div>

            <div className={`the-world-fast-travel-scroll-wrap${listHasMoreBelow ? " is-scrollable-bottom" : ""}`}>
              <div
                ref={fastTravelListRef}
                className="the-world-fast-travel-list"
                role="menu"
                aria-label={t("theWorld.hud.fastTravelAria")}
                onScroll={updateListScrollHint}
              >
                {showPlazaResult ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="the-world-fast-travel-item is-plaza"
                    onClick={() => handleWarpDestination(0, -1.5, plazaLabel, t("theWorld.stage.warpPlazaToast"))}
                  >
                    <span className="the-world-fast-travel-icon" aria-hidden="true">
                      <WorldIcon name="warRoom" size={13} tone="amber" />
                    </span>
                    <span className="the-world-fast-travel-main">
                      <span className="the-world-fast-travel-name">{plazaLabel}</span>
                      <span className="the-world-fast-travel-sub">
                        {t("theWorld.fastTravel.plazaSub")}
                      </span>
                    </span>
                    <span className="the-world-fast-travel-badge">HQ</span>
                  </button>
                ) : null}

                {filteredVillages.map(({ village, matchedDistricts }) => {
                  const warpX = village.x + Math.cos(village.gateAngle) * Math.max(2.0, village.radius * 0.45);
                  const warpZ = village.z + Math.sin(village.gateAngle) * Math.max(2.0, village.radius * 0.45);
                  const statusKind = village.hasError
                    ? "error"
                    : village.needsAttention || village.openAsksCount > 0
                      ? "attention"
                      : village.workStep
                        ? "working"
                        : "idle";
                  const statusLabel = statusKind === "error"
                    ? t("theWorld.fastTravel.statusError")
                    : statusKind === "attention"
                      ? t("theWorld.fastTravel.statusAttention")
                      : statusKind === "working"
                        ? t("theWorld.fastTravel.statusWorking")
                        : t("theWorld.fastTravel.statusIdle");
                  const isExpanded =
                    (normalizedQuery.length > 0 && matchedDistricts.length > 0)
                    || expandedVillageIds.has(village.id);
                  const subText = village.activeObjectiveCount > 0
                    ? t("theWorld.fastTravel.districtCountWithGoals", {
                        count: village.districts.length,
                        goals: village.activeObjectiveCount,
                      })
                    : t("theWorld.fastTravel.districtCount", {
                        count: village.districts.length,
                      });
                  return (
                    <div key={village.id} className="the-world-fast-travel-group">
                      <div className="the-world-fast-travel-row">
                        <button
                          type="button"
                          role="menuitem"
                          className="the-world-fast-travel-item"
                          onClick={() => handleWarpDestination(warpX, warpZ, village.label)}
                        >
                          <span className="the-world-tone-dot" data-tone={village.tone} />
                          <span className="the-world-fast-travel-main">
                            <span className="the-world-fast-travel-name">{village.label}</span>
                            <span className="the-world-fast-travel-sub">{subText}</span>
                          </span>
                          <span className={`the-world-fast-travel-status is-${statusKind}`}>
                            {statusLabel}
                          </span>
                          <span className="the-world-fast-travel-badge">
                            {t("theWorld.tier.badge", { tier: village.overallTier })}
                          </span>
                        </button>
                        {village.districts.length > 0 && normalizedQuery.length === 0 ? (
                          <button
                            type="button"
                            className={`the-world-fast-travel-expand-btn${isExpanded ? " is-expanded" : ""}`}
                            aria-expanded={isExpanded}
                            aria-label={t(
                              isExpanded
                                ? "theWorld.fastTravel.collapseDistrictsAria"
                                : "theWorld.fastTravel.expandDistrictsAria",
                              { name: village.label },
                            )}
                            onClick={() => toggleVillageDistricts(village.id)}
                          >
                            <span aria-hidden="true">{isExpanded ? "▴" : "▾"}</span>
                          </button>
                        ) : null}
                      </div>

                      {isExpanded && matchedDistricts.length > 0 ? (
                        <div className="the-world-fast-travel-districts">
                          {matchedDistricts.map((district) => (
                            <button
                              key={district.id}
                              type="button"
                              role="menuitem"
                              className="the-world-fast-travel-district-item"
                              onClick={() => handleWarpDistrict(district, village)}
                            >
                              <span className="the-world-tone-dot" data-tone={district.tone} />
                              <span className="the-world-fast-travel-district-name">{district.label}</span>
                              {district.needsAttention ? (
                                <span className="the-world-fast-travel-status is-attention">
                                  {t("theWorld.fastTravel.statusAttention")}
                                </span>
                              ) : district.activeWorkStep ? (
                                <span className="the-world-fast-travel-status is-working">
                                  {t("theWorld.fastTravel.statusWorking")}
                                </span>
                              ) : null}
                              <span className="the-world-fast-travel-badge">T{district.tier}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                {!showPlazaResult && filteredVillages.length === 0 ? (
                  <div className="the-world-fast-travel-empty">
                    {t("theWorld.fastTravel.noResults")}
                  </div>
                ) : null}
              </div>

              {listHasMoreBelow ? (
                <div className="the-world-fast-travel-fade" aria-hidden="true">
                  <span>{t("theWorld.fastTravel.moreBelow")} ▾</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* 통합 도구 2열 콤팩트 드롭다운 팝오버 (HUD 중복 제거 · 일관된 키캡 · 위험 스타일 초기화) */}
        {toolsOpen ? (
          <section
            className="the-world-debug-popover the-world-tools-popover"
            role="dialog"
            aria-label={t("theWorld.hud.toolsAria")}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="the-world-crest" aria-hidden="true" />
            <header className="the-world-debug-head">
              <span className="the-world-debug-title">
                <WorldIcon name="settings" size={13} tone="amber" />
                <span>{t("theWorld.hud.toolsLabel")}</span>
              </span>
              <button
                type="button"
                className="the-world-chat-icon-btn"
                aria-label={t("theWorld.panel.closeAria")}
                onClick={() => setToolsMenuOpen(false)}
              >
                <WorldIcon name="close" size={14} />
              </button>
            </header>

            <div className="the-world-tools-grid">
              <button
                type="button"
                className={`the-world-tools-item${store.mailboxOpen ? " is-active" : ""}${effectiveUnreadMail > 0 ? " is-attention" : ""}`}
                aria-label={t("theWorld.hud.mailboxAria")}
                onClick={handleOpenMailbox}
              >
                <WorldIcon name="mail" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.mailboxLabel")}</span>
                {effectiveUnreadMail > 0 ? (
                  <span className="the-world-hud-badge">{effectiveUnreadMail}</span>
                ) : null}
              </button>

              <button
                type="button"
                className={`the-world-tools-item${envOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.hud.envAria")}
                onClick={() => {
                  playDistrictHover();
                  setWeatherPopoverOpen(true);
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
                <kbd className="the-world-keycap">P</kbd>
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
                <span className="the-world-tools-item-label">
                  {store.soundMuted ? t("theWorld.hud.soundOffLabel") : t("theWorld.hud.soundOnLabel")}
                </span>
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
                <kbd className="the-world-keycap">C</kbd>
              </button>

              <button
                type="button"
                className={`the-world-tools-item${store.emoteWheelOpen ? " is-active" : ""}`}
                aria-label={t("theWorld.emote.wheelAria")}
                onClick={() => {
                  closeAllPopovers();
                  playDistrictSelect();
                  toggleEmoteWheel();
                }}
              >
                <WorldIcon name="cheer" size={14} tone="rose" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.emoteBtn")}</span>
                <kbd className="the-world-keycap">B</kbd>
              </button>

              <button
                type="button"
                className="the-world-tools-item is-full-row"
                aria-label={t("theWorld.hud.createCommodoreAria")}
                onClick={() => {
                  closeAllPopovers();
                  onCreateCommodore();
                }}
              >
                <WorldIcon name="recruit" size={14} tone="amber" />
                <span className="the-world-tools-item-label">{t("theWorld.hud.recruitLabel")}</span>
              </button>
            </div>

            {/* 2단계 위험 확인 구역: 초원 진행 기록 초기화 */}
            <div className="the-world-tools-footer">
              {resetConfirmOpen ? (
                <div className="the-world-tools-reset-confirm" role="alert">
                  <div className="the-world-tools-reset-copy">
                    <span className="the-world-tools-reset-question">{t("theWorld.hud.resetQuestion")}</span>
                    <span className="the-world-tools-reset-detail">{t("theWorld.hud.resetDetail")}</span>
                  </div>
                  <div className="the-world-tools-reset-actions">
                    <button
                      type="button"
                      className="the-world-tools-reset-btn is-danger"
                      onClick={handleConfirmResetProgress}
                    >
                      {t("theWorld.hud.resetConfirm")}
                    </button>
                    <button
                      type="button"
                      className="the-world-tools-reset-btn"
                      onClick={() => setResetConfirmOpen(false)}
                    >
                      {t("theWorld.hud.resetCancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="the-world-tools-reset-trigger is-danger"
                  aria-label={t("theWorld.hud.resetTrigger")}
                  onClick={() => {
                    playDistrictHover();
                    setResetConfirmOpen(true);
                  }}
                >
                  <WorldIcon name="warning" size={13} tone="rose" />
                  <span>{t("theWorld.hud.resetTrigger")}</span>
                </button>
              )}
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
                onClick={() => setWeatherPopoverOpen(false)}
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
                <div className="the-world-env-sky-row">
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
                onClick={() => setDebugPopoverOpen(false)}
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

      {/* 최초 진입 1회성 경량 조작 힌트 (localStorage 닫기 기억) */}
      {showOnboardingHint ? (
        <div
          className="the-world-onboarding-hint"
          role="note"
          aria-label={t("theWorld.onboarding.aria")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <WorldIcon name="sparkle" size={12} tone="amber" />
          <span className="the-world-onboarding-hint-text">{t("theWorld.onboarding.hint")}</span>
          <button
            type="button"
            className="the-world-onboarding-hint-close"
            aria-label={t("theWorld.onboarding.dismissAria")}
            onClick={handleDismissOnboarding}
          >
            <WorldIcon name="close" size={11} />
          </button>
        </div>
      ) : null}

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
              aria-label={t("theWorld.hud.emoteWaveAria")}
              title={t("theWorld.hud.emoteWaveAria")}
              onClick={() => handleTriggerEmote("wave")}
            >
              <span className="the-world-keycap">1</span>
              <WorldIcon name="greet" size={13} tone="amber" />
              <span>{t("theWorld.hud.emoteWave")}</span>
            </button>

            <button
              type="button"
              className="the-world-btn the-world-quick-btn"
              aria-label={t("theWorld.hud.emoteCheerAria")}
              title={t("theWorld.hud.emoteCheerAria")}
              onClick={() => handleTriggerEmote("cheer")}
            >
              <span className="the-world-keycap">2</span>
              <WorldIcon name="cheer" size={13} tone="rose" />
              <span>{t("theWorld.hud.emoteCheer")}</span>
            </button>

            <button
              type="button"
              className="the-world-btn the-world-quick-btn"
              aria-label={t("theWorld.hud.emoteSpinAria")}
              title={t("theWorld.hud.emoteSpinAria")}
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
