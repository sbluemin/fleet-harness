import { NATIVE_VIEW_COVER_ATTRIBUTE } from "@fleet-console/ui/native-view";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import {
  WORLD_CAMPFIRE_BENCH_POS,
  type WorldActorPanelMode,
  type WorldActorSpec,
  type WorldAdmiralHat,
  type WorldAdmiralStyle,
  type WorldDevelopmentTier,
  type WorldDistrictSpec,
  type WorldPlayerEmote,
  type WorldTimeMode,
  type WorldVillageBiome,
  type WorldVillageSpec,
  type WorldWeatherMode,
} from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import {
  createWorldRuntime,
  type WorldActorLabelMeta,
  type WorldFrameOverlayPositions,
  type WorldRuntimeHandle,
} from "../engine/world-runtime.js";
import {
  playCompanionCall,
  playDistrictHover,
  playDistrictSelect,
  playFlagPlant,
  playLevelUpFanfare,
  playMailboxOpen,
  playMongleChirp,
  playOverviewToggle,
  playPondSplash,
  playSend,
  playStampUnlock,
  playWarp,
  setBgmEnabled,
  setWorldAudioMuted,
} from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import { useWorldSnapshot } from "../world-projection.js";
import {
  addCompanionActorId,
  clearCompanionActorIds,
  clearDispatchFlag,
  clearLastFishCatch,
  clearPhotoSnapshotPreview,
  closeActorInteraction,
  closeAdmiralCustomizer,
  closeDistrictContextMenu,
  closeGazette,
  closeMailbox,
  closeQuestBoard,
  closeQuickJump,
  closeSkyQuickMenu,
  closeWarRoom,
  deactivateChat,
  exitTheWorld,
  getWorldStoreSnapshot,
  openActorDialogue,
  openActorPanel,
  openActorRadialMenu,
  openAdmiralCustomizer,
  openDistrictContextMenu,
  openGazette,
  openMailbox,
  openQuestBoard,
  openSkyQuickMenu,
  openWarRoom,
  placeDispatchFlag,
  pushActorSpeech,
  recordFishCatch,
  removeCompanionActorId,
  requestApproachActor,
  requestChatMention,
  requestChatMentions,
  requestPlayerEmote,
  requestRallyAll,
  requestWorldTeleport,
  resetWorldProgressData,
  selectDistrict,
  setAdmiralStyle,
  setCinemaMode,
  setCinemaSpotlight,
  setCommodoreGift,
  setDistrictNote,
  setEmoteWheelOpen,
  setFishingState,
  setHoveredDistrict,
  setNearWorldActor,
  setOperationFlag,
  setOverviewMode,
  setPhotoMode,
  setQuickJumpOpen,
  setSittingAtCampfire,
  setStampBookOpen,
  setVillageBiome,
  setWeatherMode,
  setWorldTimeMode,
  toggleBgm,
  toggleCinemaMode,
  toggleOverviewMode,
  toggleReleasedFish,
  unlockStamp,
  useCurrentZone,
  useMailboxReadKeys,
  useReleasedFishIds,
  useWorldStore,
  type WorldOperationFlagDeployInput,
  type WorldStampId,
} from "../world-store.js";
import { CAMPFIRE_F_PRIORITY_RADIUS, useWorldShortcuts } from "./use-world-shortcuts.js";
import { WorldAdmiralCustomizer } from "./world-admiral-customizer.js";
import { WorldChatLog, WorldSpeechSync } from "./world-chat-log.js";
import { WorldControlsGuide } from "./world-controls-guide.js";
import { WorldDialogueBox } from "./world-dialogue-box.js";
import { WorldDistrictInspector, type WorldDistrictLinkedObjective } from "./world-district-inspector.js";
import { WorldDistrictQuickMenu } from "./world-district-quick-menu.js";
import { WorldEmoteWheel, type WorldAdmiralEmoteKind } from "./world-emote-wheel.js";
import { WorldGazette } from "./world-gazette.js";
import { WorldFlightRingGuide, WorldHud } from "./world-hud.js";
import { WorldIcon } from "./world-icons.js";
import {
  WorldLabelsOverlay,
  type WorldActiveInteractTarget,
  type WorldLabelsOverlayHandle,
} from "./world-labels-overlay.js";
import { computeMailboxUnreadCount, WorldMailbox } from "./world-mailbox.js";
import { WorldPanelModal } from "./world-panel-modal.js";
import { WorldPhotoStudio } from "./world-photo-studio.js";
import { WorldQuestBoardModal } from "./world-quest-board.js";
import { WorldRadialMenu } from "./world-radial-menu.js";
import type { WorldFishId, WorldFishRarity } from "../engine/fishing-controller.js";
import { WorldSkyCommand, type WorldSkyHoverTarget } from "./world-sky-command.js";
import { WorldStampBook, type WorldStampBookTab } from "./world-stamp-book.js";
import { WorldWarRoom } from "./world-war-room.js";

const TOAST_DURATION_MS = 2_800;
const CELEBRATION_TOAST_DURATION_MS = 3_800;
const HOVER_PICK_THROTTLE_MS = 33;
const PLAYER_HOVER_RADIUS_PX = 46;

const TIER_NAME_KEYS: Readonly<Record<WorldDevelopmentTier, TheWorldMessageKey>> = {
  0: "theWorld.tier.0.name",
  1: "theWorld.tier.1.name",
  2: "theWorld.tier.2.name",
  3: "theWorld.tier.3.name",
  4: "theWorld.tier.4.name",
  5: "theWorld.tier.5.name",
};

const HAT_LABEL_KEYS: Readonly<Record<WorldAdmiralHat, TheWorldMessageKey>> = {
  admiral: "theWorld.admiral.hat.admiral",
  crown: "theWorld.admiral.hat.crown",
  explorer: "theWorld.admiral.hat.explorer",
  flower_crown: "theWorld.admiral.hat.flower_crown",
  none: "theWorld.admiral.hat.none",
};

const STAMP_TITLE_KEYS: Readonly<Record<WorldStampId, TheWorldMessageKey>> = {
  first_dive: "theWorld.stamps.item.first_dive.title",
  squadron_flight: "theWorld.stamps.item.squadron_flight.title",
  campfire_party: "theWorld.stamps.item.campfire_party.title",
  rain_umbrella_walk: "theWorld.stamps.item.rain_umbrella_walk.title",
  photo_snap: "theWorld.stamps.item.photo_snap.title",
  sky_ring_combo: "theWorld.stamps.item.sky_ring_combo.title",
  tier5_citadel: "theWorld.stamps.item.tier5_citadel.title",
  objective_celebration: "theWorld.stamps.item.objective_celebration.title",
};

const BIOME_LABEL_KEYS: Readonly<Record<WorldVillageBiome, TheWorldMessageKey>> = {
  meadow: "theWorld.biome.meadow",
  sakura: "theWorld.biome.sakura",
  citadel: "theWorld.biome.citadel",
  autumn: "theWorld.biome.autumn",
};

const FISH_TITLE_KEYS: Readonly<Record<WorldFishId, TheWorldMessageKey>> = {
  meadow_minnow: "theWorld.fishing.fish.meadow_minnow.title",
  golden_koi: "theWorld.fishing.fish.golden_koi.title",
  starlight_trout: "theWorld.fishing.fish.starlight_trout.title",
  cherry_loach: "theWorld.fishing.fish.cherry_loach.title",
  moon_jelly: "theWorld.fishing.fish.moon_jelly.title",
  rainbow_carp: "theWorld.fishing.fish.rainbow_carp.title",
  star_shell: "theWorld.fishing.fish.star_shell.title",
  message_bottle: "theWorld.fishing.fish.message_bottle.title",
};

const FISH_DESC_KEYS: Readonly<Record<WorldFishId, TheWorldMessageKey>> = {
  meadow_minnow: "theWorld.fishing.fish.meadow_minnow.desc",
  golden_koi: "theWorld.fishing.fish.golden_koi.desc",
  starlight_trout: "theWorld.fishing.fish.starlight_trout.desc",
  cherry_loach: "theWorld.fishing.fish.cherry_loach.desc",
  moon_jelly: "theWorld.fishing.fish.moon_jelly.desc",
  rainbow_carp: "theWorld.fishing.fish.rainbow_carp.desc",
  star_shell: "theWorld.fishing.fish.star_shell.desc",
  message_bottle: "theWorld.fishing.fish.message_bottle.desc",
};

const FISH_RARITY_KEYS: Readonly<Record<WorldFishRarity, TheWorldMessageKey>> = {
  common: "theWorld.fishing.rarityCommon",
  rare: "theWorld.fishing.rarityRare",
  legendary: "theWorld.fishing.rarityLegendary",
};

function isPanelMode(mode: string): mode is WorldActorPanelMode {
  return mode === "chat" || mode === "goals" || mode === "info" || mode === "settings";
}

function findDistrictInVillages(
  villages: readonly WorldVillageSpec[],
  districtId: string | null,
): { readonly district: WorldDistrictSpec; readonly village: WorldVillageSpec } | null {
  if (!districtId) return null;
  for (const village of villages) {
    for (const district of village.districts) {
      if (district.id === districtId) {
        return { district, village };
      }
    }
  }
  return null;
}

export default function WorldStage({ deps }: { readonly deps: TheWorldClientDeps }) {
  const store = useWorldStore();
  const currentZone = useCurrentZone();
  const mailboxReadKeys = useMailboxReadKeys();
  const releasedFishIds = useReleasedFishIds();
  const snapshot = useWorldSnapshot(deps);
  const questBoardData = deps.useWorldQuestBoard(snapshot.actors);
  const unreadMailCount = useMemo(
    () => computeMailboxUnreadCount(questBoardData, mailboxReadKeys),
    [mailboxReadKeys, questBoardData],
  );
  const unreadMailCountRef = useRef(unreadMailCount);
  unreadMailCountRef.current = unreadMailCount;
  const metricsLoading = useSyncExternalStore(
    deps.subscribeTheaterMetrics,
    deps.isTheaterMetricsLoading,
    deps.isTheaterMetricsLoading,
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<WorldRuntimeHandle | null>(null);
  const labelsOverlayRef = useRef<WorldLabelsOverlayHandle | null>(null);
  const lastPlayerPoseRef = useRef({ x: Number.NaN, z: Number.NaN, yaw: Number.NaN });

  // 구조 상태만 React state에 보관(목록·말풍선·근접·선택 변경 시에만 갱신, 평시 0Hz)
  const [labelMetas, setLabelMetas] = useState<readonly WorldActorLabelMeta[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [celebrationToast, setCelebrationToast] = useState<string | null>(null);
  const [controlsGuideOpen, setControlsGuideOpen] = useState(false);
  const [debugPanelVisible, setDebugPanelVisible] = useState(false);
  const [playerHovered, setPlayerHovered] = useState(false);
  const [skyHoverTarget, setSkyHoverTarget] = useState<WorldSkyHoverTarget | null>(null);
  const [ringComboHud, setRingComboHud] = useState<{ readonly count: number; readonly boost: boolean } | null>(null);
  const [companionRosterOpen, setCompanionRosterOpen] = useState(false);
  const [nearMailbox, setNearMailbox] = useState(false);
  const [nearParadeBell, setNearParadeBell] = useState(false);
  const [nearCampfire, setNearCampfire] = useState(false);
  const [nearFishingWater, setNearFishingWater] = useState(false);
  const [stampBookInitialTab, setStampBookInitialTab] = useState<WorldStampBookTab>("stamps");
  const companionShellRef = useRef<HTMLDivElement | null>(null);
  const ringGuideElRef = useRef<HTMLDivElement | null>(null);
  const ringGuideChevronRef = useRef<HTMLSpanElement | null>(null);
  const ringGuideDistRef = useRef<HTMLSpanElement | null>(null);
  const lastRingGuideVisibleRef = useRef(false);
  const lastRingGuideDistRef = useRef(-1);
  const fastTravelOpenRef = useRef(store.quickJumpOpen);
  fastTravelOpenRef.current = store.quickJumpOpen;
  const nearMailboxRef = useRef(nearMailbox);
  nearMailboxRef.current = nearMailbox;
  const nearParadeBellRef = useRef(nearParadeBell);
  nearParadeBellRef.current = nearParadeBell;
  const nearCampfireRef = useRef(nearCampfire);
  nearCampfireRef.current = nearCampfire;
  const nearFishingWaterRef = useRef(nearFishingWater);
  nearFishingWaterRef.current = nearFishingWater;
  const fishCatchTimerRef = useRef<number | null>(null);
  const ringComboTimerRef = useRef<number | null>(null);
  const villageDragCleanupRef = useRef<(() => void) | null>(null);
  const [overviewDragLink, setOverviewDragLink] = useState<{
    readonly fromVillage: WorldVillageSpec;
    readonly startX: number;
    readonly startY: number;
    readonly curX: number;
    readonly curY: number;
    readonly targetVillage: WorldVillageSpec | null;
  } | null>(null);

  const controlsGuideOpenRef = useRef(controlsGuideOpen);
  controlsGuideOpenRef.current = controlsGuideOpen;
  const playerHoveredRef = useRef(playerHovered);
  playerHoveredRef.current = playerHovered;
  const skyHoverTargetRef = useRef(skyHoverTarget);
  skyHoverTargetRef.current = skyHoverTarget;

  const toastTimerRef = useRef<number | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);
  const prevDistrictTiersRef = useRef<Map<string, WorldDevelopmentTier>>(new Map());
  const suppressVillageClickRef = useRef(false);
  const villagesRef = useRef<readonly WorldVillageSpec[]>(snapshot.villages);
  villagesRef.current = snapshot.villages;
  const actorsRef = useRef<readonly WorldActorSpec[]>(snapshot.actors);
  actorsRef.current = snapshot.actors;
  const urgentCursorRef = useRef(-1);

  const handleFramePositions = useCallback((positions: WorldFrameOverlayPositions) => {
    labelsOverlayRef.current?.applyFramePositions(positions);

    const px = positions.playerWorldX;
    const pz = positions.playerWorldZ;
    const pyaw = positions.playerYaw;

    // 모닥불 `E` 키 우선 반경 엣지 트리거 갱신 (상태 전환 시에만 리렌더, 평시 0Hz)
    const distCampfire = Math.hypot(px - WORLD_CAMPFIRE_BENCH_POS.x, pz - WORLD_CAMPFIRE_BENCH_POS.z);
    const nextNearCampfire = distCampfire <= CAMPFIRE_F_PRIORITY_RADIUS;
    if (nextNearCampfire !== nearCampfireRef.current) {
      nearCampfireRef.current = nextNearCampfire;
      setNearCampfire(nextNearCampfire);
    }

    const prev = lastPlayerPoseRef.current;
    if (
      Number.isNaN(prev.x)
      || Math.abs(px - prev.x) >= 0.08
      || Math.abs(pz - prev.z) >= 0.08
      || Math.abs(pyaw - prev.yaw) >= 0.03
    ) {
      prev.x = px;
      prev.z = pz;
      prev.yaw = pyaw;
    }

    // 비행 중 가장 가까운 하늘 링 오프스크린 방향 화살표 0Hz Direct-DOM 갱신
    const guideEl = ringGuideElRef.current;
    if (guideEl) {
      const rg = positions.ringGuide;
      if (rg.visible) {
        guideEl.style.opacity = "1";
        guideEl.style.transform = `translate3d(${rg.xPx.toFixed(1)}px, ${rg.yPx.toFixed(1)}px, 0) translate(-50%, -50%)`;
        if (ringGuideChevronRef.current) {
          ringGuideChevronRef.current.style.transform = `rotate(${rg.angleRad.toFixed(3)}rad)`;
        }
        const roundedDist = Math.max(1, Math.round(rg.distM));
        if (roundedDist !== lastRingGuideDistRef.current && ringGuideDistRef.current) {
          lastRingGuideDistRef.current = roundedDist;
          ringGuideDistRef.current.textContent = `${roundedDist}m`;
        }
        lastRingGuideVisibleRef.current = true;
      } else if (lastRingGuideVisibleRef.current) {
        guideEl.style.opacity = "0";
        lastRingGuideVisibleRef.current = false;
      }
    }
  }, []);

  const pushToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToastMessage(null);
    }, TOAST_DURATION_MS);
  }, []);

  const pushCelebrationToast = useCallback((msg: string) => {
    setCelebrationToast(msg);
    if (celebrationTimerRef.current !== null) window.clearTimeout(celebrationTimerRef.current);
    celebrationTimerRef.current = window.setTimeout(() => {
      celebrationTimerRef.current = null;
      setCelebrationToast(null);
    }, CELEBRATION_TOAST_DURATION_MS);
  }, []);

  const triggerStamp = useCallback((id: WorldStampId) => {
    if (!unlockStamp(id)) return;
    playStampUnlock();
    const tNow = getWorldT(deps.commodore.language());
    pushCelebrationToast(
      tNow("theWorld.stamps.unlockedToast", { title: tNow(STAMP_TITLE_KEYS[id]) }),
    );
  }, [deps, pushCelebrationToast]);

  const handleToggleControlsGuide = useCallback(() => {
    setControlsGuideOpen((prev) => !prev);
  }, []);

  const handleCloseControlsGuide = useCallback(() => {
    setControlsGuideOpen(false);
  }, []);

  const handleToggleFastTravel = useCallback(() => {
    const next = !getWorldStoreSnapshot().quickJumpOpen;
    if (next && getWorldStoreSnapshot().fishingPhase !== "idle") {
      runtimeRef.current?.cancelFishing();
    }
    setQuickJumpOpen(next);
  }, []);

  const handleCloseFastTravel = useCallback(() => {
    closeQuickJump();
  }, []);

  const handleWarpTo = useCallback((x: number, z: number, label: string) => {
    closeQuickJump();
    const wasFlying = getWorldStoreSnapshot().overviewMode;
    if (wasFlying) {
      runtimeRef.current?.setLandingPreview(null);
      setOverviewMode(false);
    }
    requestWorldTeleport(x, z);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(
      wasFlying
        ? tNow("theWorld.flight.diveToast", { label })
        : tNow("theWorld.stage.warpVillageToast", { name: label }),
    );
  }, [deps, pushToast]);

  const handleWarpToDistrict = useCallback((district: WorldDistrictSpec, _village: WorldVillageSpec) => {
    closeQuickJump();
    const wasFlying = getWorldStoreSnapshot().overviewMode;
    if (wasFlying) {
      runtimeRef.current?.setLandingPreview(null);
      setOverviewMode(false);
    }
    requestWorldTeleport(district.x, district.z);
    selectDistrict(district.id);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(
      wasFlying
        ? tNow("theWorld.flight.diveToast", { label: district.label })
        : tNow("theWorld.district.teleportAria", { name: district.label }),
    );
  }, [deps, pushToast]);

  const handleOpenInConsole = useCallback((commodoreId: string, objectiveId?: string | null) => {
    if (objectiveId) {
      deps.openObjectiveInConsole(commodoreId, objectiveId);
    } else {
      deps.openCommodoreInConsole(commodoreId);
    }
    exitTheWorld({ reducedMotion: deps.isReducedMotion() });
  }, [deps]);

  const handleResetWorldLocalData = useCallback(() => {
    resetWorldProgressData();
    runtimeRef.current?.syncPondFish([]);
    runtimeRef.current?.setOperationFlag(null);
    closeQuickJump();
    const isEnNow = deps.commodore.language() === "en";
    pushToast(
      isEnNow
        ? "Meadow progress (stamps, fish, notes, look) has been reset."
        : "초원 진행 기록(스탬프 · 도감 · 메모 · 외형)을 초기화했습니다.",
    );
  }, [deps, pushToast]);

  const handleToggleDebugPanel = useCallback(() => {
    setDebugPanelVisible((prev) => !prev);
  }, []);

  const handlePushSpeech = useCallback((actorId: string, text: string) => {
    runtimeRef.current?.pushSpeech(actorId, text);
  }, []);

  const handleCourierEvent = useCallback((fromActorId: string, targetName: string) => {
    runtimeRef.current?.spawnCourierBetweenActors(fromActorId, targetName);
  }, []);

  // 프로시저럴 오디오 음소거 · 힐링 BGM 상태 동기화
  useEffect(() => {
    setWorldAudioMuted(store.soundMuted);
  }, [store.soundMuted]);

  useEffect(() => {
    setBgmEnabled(store.bgmEnabled);
  }, [store.bgmEnabled]);

  useEffect(() => () => {
    setBgmEnabled(false);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    if (celebrationTimerRef.current !== null) window.clearTimeout(celebrationTimerRef.current);
    if (fishCatchTimerRef.current !== null) window.clearTimeout(fishCatchTimerRef.current);
    if (ringComboTimerRef.current !== null) window.clearTimeout(ringComboTimerRef.current);
    villageDragCleanupRef.current?.();
    villageDragCleanupRef.current = null;
  }, []);

  // 월드에 표시되는 모든 사령관 기록과 활성 Objective 타임라인을 미리 구독한다.
  useEffect(() => {
    for (const actor of snapshot.actors) {
      if (actor.role === "commodore" && actor.commodoreId) {
        deps.ensureCommodoreTranscript(actor.commodoreId);
      } else if (actor.rootObjectiveId) {
        deps.ensureObjectiveTimeline(actor.rootObjectiveId);
      }
    }
  }, [deps, snapshot.actors]);

  // Three.js 엔진 초기화 (마운트 시 1회)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const runtime = createWorldRuntime({
      canvas,
      getFuzz: deps.getAvatarFuzz,
      isReducedMotion: deps.isReducedMotion,
      isLowerUnfocusedFrameRate: deps.isLowerUnfocusedFrameRate,
      onNearActorChanged: (id) => setNearWorldActor(id),
      onOverviewAutoExit: () => setOverviewMode(false),
      onCampfireStandUp: () => setSittingAtCampfire(false),
      onCinemaSpotlight: (label) => setCinemaSpotlight(label),
      onCompanionDutyReturn: (actorId, actorName) => {
        removeCompanionActorId(actorId);
        const tNow = getWorldT(deps.commodore.language());
        pushActorSpeech(actorId, tNow("theWorld.companion.dutyReturnSpeech"));
        pushToast(tNow("theWorld.companion.dutyReturnToast", { name: actorName }));
      },
      onMeteorLanded: () => {
        if (ringComboTimerRef.current !== null) {
          window.clearTimeout(ringComboTimerRef.current);
          ringComboTimerRef.current = null;
        }
        setRingComboHud(null);
        triggerStamp("first_dive");
      },
      onSkyRingPass: (combo, boostTrigger) => {
        setRingComboHud({ count: combo, boost: Boolean(boostTrigger) });
        if (ringComboTimerRef.current !== null) window.clearTimeout(ringComboTimerRef.current);
        ringComboTimerRef.current = window.setTimeout(() => {
          ringComboTimerRef.current = null;
          setRingComboHud(null);
        }, 3_200);
        const tNow = getWorldT(deps.commodore.language());
        pushToast(
          combo >= 2
            ? tNow("theWorld.skyRing.comboToast", { combo })
            : tNow("theWorld.skyRing.passToast", { combo }),
        );
        if (combo >= 2) {
          triggerStamp("sky_ring_combo");
        }
      },
      onNearParadeBellChange: setNearParadeBell,
      onNearMailboxChange: setNearMailbox,
      onNearFishingWaterChange: setNearFishingWater,
      onFishingPhaseChange: (phase) => setFishingState(phase),
      onFishingMissed: () => {
        const tNow = getWorldT(deps.commodore.language());
        pushToast(tNow("theWorld.fishing.missed"));
      },
      onLabelsStructureChanged: setLabelMetas,
      onFramePositions: handleFramePositions,
    });
    const initial = getWorldStoreSnapshot();
    runtime.setWeather(initial.weatherMode);
    runtime.setAdmiralStyle(initial.admiralStyle);
    runtime.setCommodoreGifts(initial.commodoreGifts);
    runtime.setCinemaMode(initial.cinemaMode);
    runtime.setCompanionActors(initial.companionActorIds);
    runtime.setAuroraEnabled(initial.auroraEnabled);
    runtime.syncPondFish(initial.releasedFishIds);
    runtime.setMailboxUnread(unreadMailCountRef.current > 0);
    if (initial.operationFlag) {
      runtime.setOperationFlag(
        { id: initial.operationFlag.id, x: initial.operationFlag.x, z: initial.operationFlag.z },
        initial.operationFlag.commodoreId,
      );
    }
    runtimeRef.current = runtime;
    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [deps, handleFramePositions, pushToast, triggerStamp]);

  // 입장 웰컴 브리핑 (진입당 1회, 액터 로드 0.9초 후 가장 가까운 사령관이 달려와 브리핑)
  const briefingSentRef = useRef(false);
  const questSummaryRef = useRef({
    urgent: questBoardData.totalUrgentCount,
    done: questBoardData.completedMissions.length,
  });
  questSummaryRef.current = {
    urgent: questBoardData.totalUrgentCount,
    done: questBoardData.completedMissions.length,
  };

  useEffect(() => {
    if (store.lifecycle === "closed") {
      briefingSentRef.current = false;
      return;
    }
    if (store.lifecycle !== "open" || snapshot.actors.length === 0 || briefingSentRef.current) {
      return;
    }
    briefingSentRef.current = true;
    const timer = window.setTimeout(() => {
      const tNow = getWorldT(deps.commodore.language());
      const { urgent, done } = questSummaryRef.current;
      const line = urgent > 0 && done > 0
        ? tNow("theWorld.briefing.urgentAndDone", { urgent, done })
        : urgent > 0
          ? tNow("theWorld.briefing.urgentOnly", { urgent })
          : done > 0
            ? tNow("theWorld.briefing.doneOnly", { done })
            : tNow("theWorld.briefing.calm");
      runtimeRef.current?.triggerWelcomeBriefing(line);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [deps, snapshot.actors.length, store.lifecycle]);

  // 항해 스탬프 8종 자동 해금 감시 훅
  useEffect(() => {
    if (store.lifecycle !== "open") return;
    if (store.overviewMode && store.companionActorIds.length >= 2) {
      triggerStamp("squadron_flight");
    }
  }, [store.companionActorIds.length, store.lifecycle, store.overviewMode, triggerStamp]);

  useEffect(() => {
    if (store.lifecycle !== "open") return;
    if (store.sittingAtCampfire && store.companionActorIds.length >= 1) {
      triggerStamp("campfire_party");
    }
  }, [store.companionActorIds.length, store.lifecycle, store.sittingAtCampfire, triggerStamp]);

  useEffect(() => {
    if (store.lifecycle !== "open") return;
    if (store.weatherMode === "rain") {
      triggerStamp("rain_umbrella_walk");
    }
  }, [store.lifecycle, store.weatherMode, triggerStamp]);

  useEffect(() => {
    if (store.lifecycle !== "open") return;
    if (snapshot.villages.some((v) => v.overallTier >= 5 || v.maxDistrictTier >= 5)) {
      triggerStamp("tier5_citadel");
    }
  }, [snapshot.villages, store.lifecycle, triggerStamp]);

  const prevCompletedIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const missions = questBoardData.completedMissions;
    if (prevCompletedIdsRef.current === null) {
      prevCompletedIdsRef.current = new Set(missions.map((m) => m.id));
      return;
    }
    const prevIds = prevCompletedIdsRef.current;
    const newlyCompleted = missions.filter((m) => !prevIds.has(m.id));
    prevCompletedIdsRef.current = new Set(missions.map((m) => m.id));
    if (newlyCompleted.length > 0) {
      triggerStamp("objective_celebration");
      const first = newlyCompleted[0]!;
      const village = villagesRef.current.find((v) => v.commodoreId === first.commodoreId) ?? null;
      runtimeRef.current?.triggerVillageFirework(village?.id);
      const isEnNow = deps.commodore.language() === "en";
      pushCelebrationToast(
        isEnNow
          ? `Mission complete: ${first.title} — Village fireworks!`
          : `작전 완료! ${first.title} — 마을 축포 발사!`,
      );
    }
  }, [deps, pushCelebrationToast, questBoardData.completedMissions, triggerStamp]);

  useEffect(() => {
    if (store.lifecycle === "open" && store.choreography?.kind === "celebrate") {
      triggerStamp("objective_celebration");
    }
  }, [store.choreography, store.lifecycle, triggerStamp]);

  // 실시간 월드 스냅샷 동기화 + 콘솔에서 보고 있던 사령관 마을로 최초 진입 포커스 (#4)
  const initialViewedFocusAppliedRef = useRef(false);
  useEffect(() => {
    if (store.lifecycle === "closed") {
      initialViewedFocusAppliedRef.current = false;
    }
  }, [store.lifecycle]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.applySnapshot(snapshot);
    if (!initialViewedFocusAppliedRef.current && snapshot.villages.length > 0) {
      initialViewedFocusAppliedRef.current = true;
      const viewedCommodoreId = deps.getViewedCommodoreId();
      if (viewedCommodoreId) {
        const targetVillage = snapshot.villages.find((v) => v.commodoreId === viewedCommodoreId) ?? null;
        if (targetVillage) {
          runtime.spawnAtVillage(targetVillage);
        }
      }
    }
  }, [deps, snapshot]);

  // 전환/시간/카메라/상호작용 상태 동기화
  useEffect(() => {
    runtimeRef.current?.setMode({
      lifecycle: store.lifecycle,
      timeMode: store.timeMode,
      cameraMode: store.cameraMode,
      interactionMode: store.interactionMode,
      selectedActorId: store.selectedActorId,
    });
  }, [store.lifecycle, store.timeMode, store.cameraMode, store.interactionMode, store.selectedActorId]);

  useEffect(() => {
    runtimeRef.current?.setOverviewMode(store.overviewMode);
    if (!store.overviewMode) {
      runtimeRef.current?.setLandingPreview(null);
      setSkyHoverTarget(null);
      closeSkyQuickMenu();
      if (ringComboTimerRef.current !== null) {
        window.clearTimeout(ringComboTimerRef.current);
        ringComboTimerRef.current = null;
      }
      setRingComboHud(null);
      lastRingGuideVisibleRef.current = false;
      lastRingGuideDistRef.current = -1;
    }
  }, [store.overviewMode]);

  useEffect(() => {
    if (store.quickJumpOpen && getWorldStoreSnapshot().fishingPhase !== "idle") {
      runtimeRef.current?.cancelFishing();
    }
  }, [store.quickJumpOpen]);

  useEffect(() => {
    runtimeRef.current?.setCompanionActors(store.companionActorIds);
  }, [store.companionActorIds]);

  useEffect(() => {
    runtimeRef.current?.setAuroraEnabled(store.auroraEnabled);
  }, [store.auroraEnabled]);

  useEffect(() => {
    runtimeRef.current?.setMailboxUnread(unreadMailCount > 0);
  }, [unreadMailCount]);

  useEffect(() => {
    runtimeRef.current?.syncPondFish(releasedFishIds);
  }, [releasedFishIds]);

  useEffect(() => {
    const flag = store.operationFlag;
    if (!flag) {
      runtimeRef.current?.setOperationFlag(null);
      return;
    }
    runtimeRef.current?.setOperationFlag(
      { id: flag.id, x: flag.x, z: flag.z },
      flag.commodoreId,
    );
  }, [store.operationFlag]);

  useEffect(() => {
    runtimeRef.current?.setWeather(store.weatherMode);
  }, [store.weatherMode]);

  useEffect(() => {
    runtimeRef.current?.setAdmiralStyle(store.admiralStyle);
  }, [store.admiralStyle]);

  useEffect(() => {
    runtimeRef.current?.setCommodoreGifts(store.commodoreGifts);
  }, [store.commodoreGifts]);

  useEffect(() => {
    runtimeRef.current?.setCinemaMode(store.cinemaMode);
  }, [store.cinemaMode]);

  useEffect(() => {
    runtimeRef.current?.setCampfireSit(store.sittingAtCampfire);
  }, [store.sittingAtCampfire]);

  useEffect(() => {
    runtimeRef.current?.setCustomizerMode?.(store.admiralCustomizerOpen);
  }, [store.admiralCustomizerOpen]);

  // 함대 상황실 「전 사령관 긴급 소집」 트리거 동기화
  const lastRallyNonceRef = useRef(0);
  useEffect(() => {
    if (!store.rallyNonce || store.rallyNonce === lastRallyNonceRef.current) return;
    lastRallyNonceRef.current = store.rallyNonce;
    runtimeRef.current?.rallyAllToPlaza();
  }, [store.rallyNonce]);

  // 제독 퀵 감정표현 (`1` / `2` / `3`) 트리거 동기화
  const lastPlayerEmoteNonceRef = useRef(0);
  useEffect(() => {
    const cmd = store.playerEmoteCommand;
    if (!cmd || cmd.nonce === lastPlayerEmoteNonceRef.current) return;
    lastPlayerEmoteNonceRef.current = cmd.nonce;
    runtimeRef.current?.playPlayerEmote(cmd.emote);
    const tNow = getWorldT(deps.commodore.language());
    const toastKey: TheWorldMessageKey = cmd.emote === "wave"
      ? "theWorld.emote.waveToast"
      : cmd.emote === "cheer"
        ? "theWorld.emote.cheerToast"
        : "theWorld.emote.jumpToast";
    pushToast(tNow(toastKey));
  }, [deps, pushToast, store.playerEmoteCommand]);

  // 제독 구역 메모 핀 3D 동기화 (씬 리빌드 0)
  useEffect(() => {
    const pins: { readonly x: number; readonly z: number }[] = [];
    for (const v of snapshot.villages) {
      for (const d of v.districts) {
        const note = store.districtNotes[d.id];
        if (note && note.trim().length > 0) {
          pins.push({ x: d.x, z: d.z });
        }
      }
    }
    runtimeRef.current?.setDistrictNotePins(pins);
  }, [snapshot.villages, store.districtNotes]);

  // 3D 광장 퀘스트 게시판 긴급 알림 크리스탈 동기화 (씬 리빌드 0)
  useEffect(() => {
    runtimeRef.current?.setQuestBoardAlert(questBoardData.totalUrgentCount);
  }, [questBoardData.totalUrgentCount]);

  // 활성 작전 깃발(RTS 홀로그램 마커) 3D 동기화 (씬 리빌드 0)
  useEffect(() => {
    const flagIds = Object.keys(store.dispatchFlags);
    if (flagIds.length === 0) {
      runtimeRef.current?.setDispatchFlags([]);
      return;
    }
    const activeFlags: { readonly x: number; readonly z: number; readonly tone: WorldDistrictSpec["tone"] }[] = [];
    for (const v of snapshot.villages) {
      for (const d of v.districts) {
        if (store.dispatchFlags[d.id]) {
          activeFlags.push({ x: d.x, z: d.z, tone: d.tone });
        }
      }
    }
    runtimeRef.current?.setDispatchFlags(activeFlags);
  }, [snapshot.villages, store.dispatchFlags]);

  // 실시간 Theater 구역 Tier 레벨업 감지기 (초기 메트릭 로딩 제외, 실제 상승 시에만 축포)
  useEffect(() => {
    const prevMap = prevDistrictTiersRef.current;
    const tLive = getWorldT(deps.commodore.language());
    let celebrated: WorldDistrictSpec | null = null;
    for (const v of snapshot.villages) {
      for (const d of v.districts) {
        if (!d.metricsLoaded) continue;
        const prevTier = prevMap.get(d.id);
        if (prevTier !== undefined && d.tier > prevTier) {
          celebrated = d;
        }
        prevMap.set(d.id, d.tier);
      }
    }
    if (celebrated) {
      runtimeRef.current?.triggerLevelUpCelebration(celebrated.x, celebrated.z, celebrated.tone);
      playLevelUpFanfare();
      pushCelebrationToast(
        tLive("theWorld.levelUp.toast", {
          name: celebrated.label,
          tier: celebrated.tier,
          tierName: tLive(TIER_NAME_KEYS[celebrated.tier]),
        }),
      );
    }
  }, [deps, pushCelebrationToast, snapshot.villages]);

  // 심시티 Theater 구역 호버/선택 상태 해소
  const selectedDistrictMatch = useMemo(
    () => findDistrictInVillages(snapshot.villages, store.selectedDistrictId),
    [snapshot.villages, store.selectedDistrictId],
  );
  const hoveredDistrictMatch = useMemo(
    () => findDistrictInVillages(snapshot.villages, store.hoveredDistrictId),
    [snapshot.villages, store.hoveredDistrictId],
  );
  const selectedDistrict = selectedDistrictMatch?.district ?? null;
  const selectedVillage = selectedDistrictMatch?.village ?? null;
  const hoveredDistrict = hoveredDistrictMatch?.district ?? null;

  useEffect(() => {
    runtimeRef.current?.setDistrictHighlight(hoveredDistrict, selectedDistrict);
  }, [hoveredDistrict, selectedDistrict]);

  const focusedDistrictIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextId = selectedDistrict?.id ?? null;
    if (nextId === focusedDistrictIdRef.current) return;
    focusedDistrictIdRef.current = nextId;
    runtimeRef.current?.focusDistrict(selectedDistrict);
  }, [selectedDistrict]);

  useEffect(() => {
    if (store.selectedDistrictId && !selectedDistrict) {
      selectDistrict(null);
    }
  }, [selectedDistrict, store.selectedDistrictId]);

  useEffect(() => {
    if (!store.choreography) return;
    const ran = runtimeRef.current?.runChoreography(store.choreography);
    if (ran === false) {
      const tNow = getWorldT(deps.commodore.language());
      pushToast(tNow("theWorld.stage.simNeedsObjectiveToast"));
    }
  }, [deps, pushToast, store.choreography]);

  const lastEmoteNonceRef = useRef(0);
  useEffect(() => {
    const cmd = store.emoteCommand;
    if (!cmd || cmd.nonce === lastEmoteNonceRef.current) return;
    lastEmoteNonceRef.current = cmd.nonce;
    playMongleChirp(cmd.emote === "cheer" ? 3 : cmd.emote === "highfive" ? 5 : 0);
    runtimeRef.current?.playEmote(cmd.actorId, cmd.emote);
  }, [store.emoteCommand]);

  const lastApproachNonceRef = useRef(0);
  useEffect(() => {
    const req = store.approachRequest;
    if (!req || req.nonce === lastApproachNonceRef.current) return;
    lastApproachNonceRef.current = req.nonce;
    runtimeRef.current?.approachActor(req.actorId);
  }, [store.approachRequest]);

  const lastTeleportNonceRef = useRef(0);
  useEffect(() => {
    const req = store.teleportRequest;
    if (!req || req.nonce === lastTeleportNonceRef.current) return;
    lastTeleportNonceRef.current = req.nonce;
    playWarp();
    runtimeRef.current?.teleport(req.x, req.z);
  }, [store.teleportRequest]);

  const appliedSpeechesRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const [actorId, entry] of Object.entries(store.localSpeeches)) {
      if (appliedSpeechesRef.current[actorId] === entry.nonce) continue;
      appliedSpeechesRef.current[actorId] = entry.nonce;
      runtimeRef.current?.pushSpeech(actorId, entry.text);
    }
  }, [store.localSpeeches]);

  useEffect(() => {
    if (store.selectedActorId && !snapshot.actors.some((a) => a.id === store.selectedActorId)) {
      closeActorInteraction();
    }
  }, [snapshot.actors, store.selectedActorId]);

  // 더 월드가 열려 있는 동안 하부 콘솔 영역을 inert/aria-hidden으로 격리해 포커스·스크린리더 누수를 차단한다 (#1).
  useEffect(() => {
    const rootEl = rootRef.current;
    const shell = rootEl?.closest(".console-shell") ?? rootEl?.parentElement ?? null;
    if (!shell) return;

    const targets = Array.from(
      shell.querySelectorAll<HTMLElement>(":scope > .console-route-content, :scope > .console-shell-bars"),
    ).filter((el) => !rootEl || !el.contains(rootEl));

    const saved = targets.map((el) => ({
      el,
      inert: el.inert,
      ariaHidden: el.getAttribute("aria-hidden"),
    }));

    for (const { el } of saved) {
      el.inert = true;
      el.setAttribute("aria-hidden", "true");
    }

    const active = document.activeElement;
    if (active instanceof HTMLElement && (!rootEl || !rootEl.contains(active))) {
      active.blur();
    }

    return () => {
      for (const item of saved) {
        item.el.inert = item.inert;
        if (item.ariaHidden === null) {
          item.el.removeAttribute("aria-hidden");
        } else {
          item.el.setAttribute("aria-hidden", item.ariaHidden);
        }
      }
    };
  }, []);

  // 더 월드 진입 시 배경 콘솔에 남은 포커스를 해제해 즉시 `Enter` 채팅이 동작하도록 한다.
  useEffect(() => {
    if (store.lifecycle !== "open" && store.lifecycle !== "diving") return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !rootRef.current?.contains(active)) {
      active.blur();
    }
  }, [store.lifecycle]);

  const handleOpenUrgentActor = useCallback((actorId: string) => {
    if (getWorldStoreSnapshot().cinemaMode) {
      setCinemaMode(false);
    }
    playMongleChirp();
    requestApproachActor(actorId);
    openActorDialogue(actorId);
  }, []);

  const handleFocusNextUrgentActor = useCallback(() => {
    const tNow = getWorldT(deps.commodore.language());
    const all = actorsRef.current;
    const urgent = [
      ...all.filter((a) => a.needsAttention && a.role === "commodore"),
      ...all.filter((a) => a.needsAttention && a.role !== "commodore"),
    ];
    if (urgent.length === 0) {
      pushToast(tNow("theWorld.urgent.noneToast"));
      return;
    }
    const nextIdx = (urgentCursorRef.current + 1) % urgent.length;
    urgentCursorRef.current = nextIdx;
    const target = urgent[nextIdx]!;
    handleOpenUrgentActor(target.id);
    pushToast(tNow("theWorld.urgent.focusedToast", { name: target.name }));
  }, [deps, handleOpenUrgentActor, pushToast]);

  const handleOpenMailbox = useCallback(() => {
    if (getWorldStoreSnapshot().fishingPhase !== "idle") {
      runtimeRef.current?.cancelFishing();
    }
    playMailboxOpen();
    openMailbox();
  }, []);

  const handleCloseMailbox = useCallback(() => {
    closeMailbox();
  }, []);

  const handleRingParadeBell = useCallback(() => {
    const tNow = getWorldT(deps.commodore.language());
    runtimeRef.current?.ringParadeBell(tNow("theWorld.bell.rallySpeech"));
    pushCelebrationToast(tNow("theWorld.bell.rallyToast"));
  }, [deps, pushCelebrationToast]);

  const handleStartFishing = useCallback(() => {
    if (fishCatchTimerRef.current !== null) {
      window.clearTimeout(fishCatchTimerRef.current);
      fishCatchTimerRef.current = null;
    }
    clearLastFishCatch();
    runtimeRef.current?.startFishing();
  }, []);

  const handleReelFishing = useCallback(() => {
    const names = actorsRef.current
      .filter((a) => a.role === "commodore")
      .map((a) => a.name);
    const res = runtimeRef.current?.reelFishing(names);
    if (!res) return;
    if (res.outcome === "caught") {
      recordFishCatch(res.fish.id, {
        rarity: res.fish.rarity,
        ...(res.senderName ? { senderName: res.senderName } : {}),
      });
      if (fishCatchTimerRef.current !== null) window.clearTimeout(fishCatchTimerRef.current);
      fishCatchTimerRef.current = window.setTimeout(() => {
        fishCatchTimerRef.current = null;
        clearLastFishCatch();
      }, 4_400);
    } else if (res.outcome === "missed") {
      const tNow = getWorldT(deps.commodore.language());
      pushToast(tNow("theWorld.fishing.missed"));
    }
  }, [deps, pushToast]);

  const handleCancelFishing = useCallback(() => {
    runtimeRef.current?.cancelFishing();
  }, []);

  // 전역 키보드 단축키 (`use-world-shortcuts.ts`)
  useWorldShortcuts({
    rootRef,
    controlsGuideOpenRef,
    fastTravelOpenRef,
    nearMailboxRef,
    nearParadeBellRef,
    nearCampfireRef,
    nearFishingWaterRef,
    onToggleControlsGuide: handleToggleControlsGuide,
    onCloseControlsGuide: handleCloseControlsGuide,
    onToggleFastTravel: handleToggleFastTravel,
    onCloseFastTravel: handleCloseFastTravel,
    onToggleDebugPanel: handleToggleDebugPanel,
    onFocusNextUrgentActor: handleFocusNextUrgentActor,
    onOpenMailbox: handleOpenMailbox,
    onRingParadeBell: handleRingParadeBell,
    onStartFishing: handleStartFishing,
    onReelFishing: handleReelFishing,
    onCancelFishing: handleCancelFishing,
  });

  // 우클릭 브라우저 기본 컨텍스트 메뉴 차단 (텍스트 입력창 내부만 예외 허용)
  const handleRootContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement) {
      const tag = event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) {
        return;
      }
    }
    event.preventDefault();
  }, []);

  // 캔버스 우클릭 → Theater 구역 빠른 작전 명령 퀵메뉴
  const handleCanvasContextMenu = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const snap = getWorldStoreSnapshot();
    if (
      snap.lifecycle !== "open"
      || snap.questBoardOpen
      || snap.mailboxOpen
      || snap.warRoomOpen
      || snap.admiralCustomizerOpen
      || snap.gazetteOpen
      || snap.stampBookOpen
      || controlsGuideOpenRef.current
      || snap.photoMode
      || snap.cinemaMode
    ) {
      return;
    }
    const hitDistrict = runtimeRef.current?.pickDistrictAt(event.clientX, event.clientY) ?? null;
    if (snap.overviewMode) {
      const hitVillage = hitDistrict
        ? villagesRef.current.find((v) => v.id === hitDistrict.villageId) ?? null
        : runtimeRef.current?.pickVillageAt(event.clientX, event.clientY) ?? null;
      if (hitVillage) {
        const actor = actorsRef.current.find(
          (a) => a.role === "commodore" && a.commodoreId === hitVillage.commodoreId,
        ) ?? null;
        playDistrictSelect();
        setSkyHoverTarget(null);
        openSkyQuickMenu({
          districtId: hitDistrict?.id ?? "",
          commodoreId: hitVillage.commodoreId,
          actorId: actor?.id ?? `commodore:${hitVillage.commodoreId}`,
          x: event.clientX,
          y: event.clientY,
        });
      } else if (snap.skyQuickMenu) {
        closeSkyQuickMenu();
      }
      return;
    }
    if (hitDistrict) {
      playDistrictSelect();
      openDistrictContextMenu(hitDistrict.id, event.clientX, event.clientY);
    } else if (snap.districtContextMenu) {
      closeDistrictContextMenu();
    }
  }, []);

  // 캔버스 클릭 & 구역/제독 호버 피킹 (드래그 회전과 구분)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverPickRef = useRef(0);

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
    if (getWorldStoreSnapshot().overviewMode) {
      runtimeRef.current?.setLandingPreview(null);
    }
  }, []);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerDownRef.current !== null) return;
    const snap = getWorldStoreSnapshot();
    if (
      snap.lifecycle !== "open"
      || snap.interactionMode !== "closed"
      || snap.questBoardOpen
      || snap.mailboxOpen
      || snap.warRoomOpen
      || snap.admiralCustomizerOpen
      || snap.gazetteOpen
      || snap.stampBookOpen
      || snap.cinemaMode
      || snap.photoMode
      || snap.emoteWheelOpen
      || controlsGuideOpenRef.current
    ) {
      if (snap.hoveredDistrictId !== null) setHoveredDistrict(null);
      if (playerHoveredRef.current) setPlayerHovered(false);
      if (skyHoverTargetRef.current !== null) setSkyHoverTarget(null);
      runtimeRef.current?.setLandingPreview(null);
      return;
    }
    const now = performance.now();
    if (now - lastHoverPickRef.current < HOVER_PICK_THROTTLE_MS) return;
    lastHoverPickRef.current = now;

    // 하늘 비행(`overviewMode`) 중 공중 호버 스캔 카드 & 3D 유성 착지 예고 링 갱신 (#11)
    if (snap.overviewMode) {
      if (snap.hoveredDistrictId !== null) setHoveredDistrict(null);
      if (playerHoveredRef.current) setPlayerHovered(false);
      if (snap.skyQuickMenu) {
        if (skyHoverTargetRef.current !== null) setSkyHoverTarget(null);
        runtimeRef.current?.setLandingPreview(null);
        return;
      }
      const hitDistrict = runtimeRef.current?.pickDistrictAt(e.clientX, e.clientY) ?? null;
      const hitVillage = hitDistrict
        ? villagesRef.current.find((v) => v.id === hitDistrict.villageId) ?? null
        : runtimeRef.current?.pickVillageAt(e.clientX, e.clientY) ?? null;
      if (hitVillage) {
        const actor = actorsRef.current.find(
          (a) => a.role === "commodore" && a.commodoreId === hitVillage.commodoreId,
        ) ?? null;
        setSkyHoverTarget({
          village: hitVillage,
          district: hitDistrict,
          actor,
          x: e.clientX,
          y: e.clientY,
        });
        if (hitDistrict) {
          runtimeRef.current?.setLandingPreview({
            x: hitDistrict.x,
            z: hitDistrict.z,
            scale: 1.15,
          });
        } else {
          const entryDist = Math.max(2.35, Math.min(hitVillage.radius - 2.65, hitVillage.radius * 0.42));
          runtimeRef.current?.setLandingPreview({
            x: hitVillage.x + Math.cos(hitVillage.gateAngle) * entryDist,
            z: hitVillage.z + Math.sin(hitVillage.gateAngle) * entryDist,
            scale: 1.35,
          });
        }
      } else {
        if (skyHoverTargetRef.current !== null) {
          setSkyHoverTarget(null);
        }
        const groundPt = runtimeRef.current?.pickGroundPointAt(e.clientX, e.clientY) ?? null;
        if (groundPt) {
          runtimeRef.current?.setLandingPreview({
            x: groundPt.x,
            z: groundPt.z,
            scale: 1.0,
          });
        } else {
          runtimeRef.current?.setLandingPreview(null);
        }
      }
      return;
    }

    if (skyHoverTargetRef.current !== null) setSkyHoverTarget(null);

    // 제독 3D 캐릭터 호버 판정 (이름표 기본 숨김 → 호버 시 노출)
    const pt = labelsOverlayRef.current?.getLastPlayerScreenPoint();
    const nearPlayer = Boolean(
      pt?.visible
      && !Number.isNaN(pt.x)
      && Math.hypot(e.clientX - pt.x, e.clientY - (pt.y + 34)) <= PLAYER_HOVER_RADIUS_PX,
    );
    if (nearPlayer !== playerHoveredRef.current) {
      setPlayerHovered(nearPlayer);
    }

    const hit = runtimeRef.current?.pickDistrictAt(e.clientX, e.clientY) ?? null;
    const nextId = hit?.id ?? null;
    if (nextId !== snap.hoveredDistrictId) {
      if (nextId !== null) playDistrictHover();
      setHoveredDistrict(nextId);
    }
  }, []);

  const handleCanvasPointerLeave = useCallback(() => {
    if (getWorldStoreSnapshot().hoveredDistrictId !== null) {
      setHoveredDistrict(null);
    }
    if (playerHoveredRef.current) {
      setPlayerHovered(false);
    }
    if (skyHoverTargetRef.current !== null) {
      setSkyHoverTarget(null);
    }
    runtimeRef.current?.setLandingPreview(null);
  }, []);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = pointerDownRef.current;
    pointerDownRef.current = null;
    const snap = getWorldStoreSnapshot();
    if (!start || snap.lifecycle !== "open") return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 6) return;

    if (snap.chatActive) {
      deactivateChat();
    }

    if (snap.admiralCustomizerOpen || snap.gazetteOpen || snap.stampBookOpen || snap.mailboxOpen || snap.cinemaMode) {
      return;
    }

    // 낚시 중 캔버스 클릭: 입질(`bite`)이면 즉시 릴 감기, 대기/포획 중에는 구역·액터 피킹 차단
    if (snap.fishingPhase === "bite") {
      handleReelFishing();
      return;
    }
    if (snap.fishingPhase !== "idle") {
      return;
    }

    // 별빛 비행(`overviewMode`) 중 클릭 우선순위:
    // 1. 액터 · 퀘스트 게시판 → 2. 마을/구역 유성 급강하 → 3. 일반 초원 땅 어디든 클릭 유성 착지
    if (snap.overviewMode) {
      if (snap.skyQuickMenu) {
        closeSkyQuickMenu();
        return;
      }
      const hitFlightActorId = runtimeRef.current?.pickActorAt(e.clientX, e.clientY) ?? null;
      if (hitFlightActorId) {
        playMongleChirp();
        openActorRadialMenu(hitFlightActorId);
        return;
      }
      if (runtimeRef.current?.pickNoticeBoardAt(e.clientX, e.clientY)) {
        playDistrictSelect();
        openQuestBoard();
        return;
      }
      const hitVillage = runtimeRef.current?.pickVillageAt(e.clientX, e.clientY) ?? null;
      if (hitVillage) {
        runtimeRef.current?.diveToPoint(hitVillage.x, hitVillage.z, {
          lookAtX: hitVillage.x,
          lookAtZ: hitVillage.z,
        });
        setOverviewMode(false);
        const tNow = getWorldT(deps.commodore.language());
        pushToast(tNow("theWorld.flight.diveToast", { label: hitVillage.label }));
        return;
      }
      const hitFlightDistrict = runtimeRef.current?.pickDistrictAt(e.clientX, e.clientY) ?? null;
      if (hitFlightDistrict) {
        runtimeRef.current?.diveToPoint(hitFlightDistrict.x, hitFlightDistrict.z, {
          lookAtX: hitFlightDistrict.x,
          lookAtZ: hitFlightDistrict.z,
        });
        setOverviewMode(false);
        const tNow = getWorldT(deps.commodore.language());
        pushToast(tNow("theWorld.flight.diveToast", { label: hitFlightDistrict.label }));
        return;
      }
      const groundPt = runtimeRef.current?.pickGroundPointAt(e.clientX, e.clientY) ?? null;
      if (groundPt) {
        runtimeRef.current?.diveToPoint(groundPt.x, groundPt.z);
        setOverviewMode(false);
        return;
      }
      return;
    }

    // 클릭 우선순위: 1. 캐릭터 → 2. 3D 퀘스트 게시판 → 3. 3D 함대 우체통 → 4. 모닥불 벤치 → 5. 길드 회관(상황실) → 6. Theater 구역 → 7. 빈 땅 해제
    const hitActorId = runtimeRef.current?.pickActorAt(e.clientX, e.clientY) ?? null;
    if (hitActorId) {
      playMongleChirp();
      openActorRadialMenu(hitActorId);
      return;
    }

    if (runtimeRef.current?.pickNoticeBoardAt(e.clientX, e.clientY)) {
      playDistrictSelect();
      openQuestBoard();
      return;
    }

    if (runtimeRef.current?.pickMailboxAt(e.clientX, e.clientY)) {
      handleOpenMailbox();
      return;
    }

    if (!snap.overviewMode && runtimeRef.current?.pickCampfireBenchAt(e.clientX, e.clientY)) {
      playDistrictSelect();
      setSittingAtCampfire(!snap.sittingAtCampfire);
      return;
    }

    if (runtimeRef.current?.pickGuildHallAt(e.clientX, e.clientY)) {
      playDistrictSelect();
      openWarRoom();
      return;
    }

    const hitDistrict = runtimeRef.current?.pickDistrictAt(e.clientX, e.clientY) ?? null;
    if (hitDistrict) {
      playDistrictSelect();
      selectDistrict(hitDistrict.id);
      return;
    }

    if (snap.questBoardOpen) {
      closeQuestBoard();
      return;
    }

    if (snap.interactionMode !== "closed" || snap.selectedDistrictId !== null) {
      closeActorInteraction();
      return;
    }
  }, [deps, handleOpenMailbox, handleReelFishing, pushToast]);

  // 모달 & HUD & 미니맵 콜백 (React.memo 안정성 유지)
  const handleCloseQuestBoard = useCallback(() => {
    closeQuestBoard();
  }, []);

  const handleOpenQuestBoardFromSign = useCallback(() => {
    playDistrictSelect();
    openQuestBoard();
  }, []);

  const handleSitAtCampfireFromSign = useCallback(() => {
    playDistrictSelect();
    setSittingAtCampfire(true);
  }, []);

  const handleInteractActorFromLabel = useCallback((actorId: string) => {
    openActorRadialMenu(actorId);
  }, []);

  const handleVisitQuestCommodore = useCallback((actorId: string) => {
    closeQuestBoard();
    requestApproachActor(actorId);
  }, []);

  const handleWarpToVillage = useCallback((village: WorldVillageSpec) => {
    closeQuickJump();
    const wasFlying = getWorldStoreSnapshot().overviewMode;
    if (wasFlying) {
      runtimeRef.current?.setLandingPreview(null);
      setOverviewMode(false);
    }
    requestWorldTeleport(village.x, village.z);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(
      wasFlying
        ? tNow("theWorld.flight.diveToast", { label: village.label })
        : tNow("theWorld.stage.warpVillageToast", { name: village.label }),
    );
  }, [deps, pushToast]);

  const handleVillageSignClick = useCallback((village: WorldVillageSpec) => {
    if (suppressVillageClickRef.current) return;
    handleWarpToVillage(village);
  }, [handleWarpToVillage]);

  const handleToggleFlight = useCallback(() => {
    const next = !getWorldStoreSnapshot().overviewMode;
    playOverviewToggle(next);
    toggleOverviewMode();
    if (!next) {
      const tNow = getWorldT(deps.commodore.language());
      pushToast(tNow("theWorld.flight.landToast"));
    }
  }, [deps, pushToast]);

  const handleWarpFromMailbox = useCallback((village: WorldVillageSpec) => {
    closeMailbox();
    handleWarpToVillage(village);
  }, [handleWarpToVillage]);

  const handleTalkFromMailbox = useCallback((actorId: string) => {
    closeMailbox();
    handleOpenUrgentActor(actorId);
  }, [handleOpenUrgentActor]);

  const handleDeployOperationFlag = useCallback((input: WorldOperationFlagDeployInput) => {
    setOperationFlag({
      ...input,
      id: `opflag:${Date.now()}`,
      createdAt: Date.now(),
    });
    const isEnNow = deps.commodore.language() === "en";
    const actor = actorsRef.current.find(
      (a) => a.role === "commodore" && a.commodoreId === input.commodoreId,
    );
    if (actor) {
      pushActorSpeech(
        actor.id,
        isEnNow
          ? `Heading out: ${input.directive.slice(0, 24)}`
          : `출동합니다: ${input.directive.slice(0, 24)}`,
      );
    }
    pushCelebrationToast(
      isEnNow
        ? `Operation flag deployed at ${input.label} (${input.commodoreName})`
        : `${input.label}에 작전 깃발 배치 · ${input.commodoreName} 출동!`,
    );
    if (input.commodoreId && input.directive.trim().length > 0) {
      void deps.sendMessageToCommodore(input.commodoreId, input.directive.trim());
    }
  }, [deps, pushCelebrationToast]);

  const handleClearOperationFlag = useCallback(() => {
    setOperationFlag(null);
    const isEnNow = deps.commodore.language() === "en";
    pushToast(isEnNow ? "Operation flag cleared." : "작전 깃발을 회수했습니다.");
  }, [deps, pushToast]);

  const handleCloseDistrict = useCallback(() => {
    selectDistrict(null);
  }, []);

  const handleRefreshMetrics = useCallback(() => {
    void deps.ensureTheaterMetrics({ refresh: true });
  }, [deps]);

  const handleMentionCommodore = useCallback((actorId: string) => {
    requestChatMention(actorId);
  }, []);

  const handleTeleportToDistrict = useCallback((x: number, z: number, label: string) => {
    requestWorldTeleport(x, z);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow("theWorld.district.teleportAria", { name: label }));
  }, [deps, pushToast]);

  const handleOpenDistrictDialogue = useCallback((actorId: string) => {
    openActorDialogue(actorId);
  }, []);

  const handleFocusDistrictCommodore = useCallback((actorId: string) => {
    requestApproachActor(actorId);
    openActorRadialMenu(actorId);
  }, []);

  const handleOpenDistrictObjective = useCallback((commodoreActorId: string, objectiveId: string) => {
    openActorPanel(commodoreActorId, "goals", objectiveId);
  }, []);

  const handleSelectWeather = useCallback((mode: WorldWeatherMode) => {
    setWeatherMode(mode);
  }, []);

  const handleSelectTimeMode = useCallback((mode: WorldTimeMode) => {
    setWorldTimeMode(mode);
  }, []);

  const handleTriggerEmote = useCallback((emote: WorldPlayerEmote) => {
    requestPlayerEmote(emote);
  }, []);

  const handlePhotoGroupPose = useCallback(() => {
    runtimeRef.current?.triggerPhotoGroupPose();
  }, []);

  const handlePhotoCapture = useCallback((): string | null => {
    const dataUrl = runtimeRef.current?.captureSnapshotDataUrl() ?? null;
    if (dataUrl) {
      triggerStamp("photo_snap");
    }
    return dataUrl;
  }, [triggerStamp]);

  const handleCloseStampBook = useCallback(() => {
    setStampBookOpen(false);
    setStampBookInitialTab("stamps");
  }, []);

  const handleOpenFishBook = useCallback(() => {
    clearLastFishCatch();
    setStampBookInitialTab("fish");
    setStampBookOpen(true);
    playDistrictSelect();
  }, []);

  const handleOpenStampBookFromCustomizer = useCallback(() => {
    closeAdmiralCustomizer();
    setStampBookInitialTab("stamps");
    setStampBookOpen(true);
  }, []);

  const handlePhotoExit = useCallback(() => {
    clearPhotoSnapshotPreview();
    setPhotoMode(false);
  }, []);

  const handleCloseEmoteWheel = useCallback(() => {
    setEmoteWheelOpen(false);
  }, []);

  const handleSelectAdmiralEmote = useCallback((kind: WorldAdmiralEmoteKind) => {
    runtimeRef.current?.triggerAdmiralEmote(kind);
    if (kind === "sit") {
      setSittingAtCampfire(true);
    }
  }, []);

  const handleCloseSkyQuickMenu = useCallback(() => {
    closeSkyQuickMenu();
  }, []);

  const handleSkyAnswerAsk = useCallback((actorId: string) => {
    setOverviewMode(false);
    openActorDialogue(actorId);
  }, []);

  const handleSkyDiveToTarget = useCallback((x: number, z: number, label: string) => {
    requestWorldTeleport(x, z);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow("theWorld.flight.diveToast", { label }));
  }, [deps, pushToast]);

  const handleSkyOpenNotebook = useCallback((actorId: string) => {
    setOverviewMode(false);
    openActorPanel(actorId, "chat");
  }, []);

  const companionActors = useMemo<readonly WorldActorSpec[]>(() => {
    if (store.companionActorIds.length === 0) return [];
    const byId = new Map(snapshot.actors.map((a) => [a.id, a]));
    const list: WorldActorSpec[] = [];
    for (const id of store.companionActorIds) {
      const found = byId.get(id);
      if (found) list.push(found);
    }
    return list;
  }, [snapshot.actors, store.companionActorIds]);

  const otherCommodores = useMemo<readonly { readonly actor: WorldActorSpec; readonly busy: boolean }[]>(() => {
    const activeIds = new Set(store.companionActorIds);
    const items: { readonly actor: WorldActorSpec; readonly busy: boolean }[] = [];
    for (const actor of snapshot.actors) {
      if (actor.role !== "commodore" || !actor.commodoreId) continue;
      if (activeIds.has(actor.id)) continue;
      const busy = actor.state === "running" || actor.needsAttention;
      items.push({ actor, busy });
    }
    items.sort((a, b) => Number(a.busy) - Number(b.busy));
    return items;
  }, [snapshot.actors, store.companionActorIds]);

  const idleAvailableCommodores = useMemo<readonly WorldActorSpec[]>(
    () => otherCommodores.filter((entry) => !entry.busy).map((entry) => entry.actor),
    [otherCommodores],
  );

  // 편대 로스터 팝오버 자동 닫힘(동행 0명·모드 전환·바깥 클릭·Esc)
  useEffect(() => {
    if (companionActors.length === 0 || store.photoMode || store.cinemaMode || store.overviewMode) {
      setCompanionRosterOpen(false);
    }
  }, [companionActors.length, store.cinemaMode, store.overviewMode, store.photoMode]);

  useEffect(() => {
    if (!companionRosterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        companionShellRef.current
        && event.target instanceof Node
        && companionShellRef.current.contains(event.target)
      ) {
        return;
      }
      setCompanionRosterOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCompanionRosterOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [companionRosterOpen]);

  const handleEndCompanionWalk = useCallback(() => {
    const count = companionActors.length;
    const firstName = companionActors[0]?.name ?? "";
    setCompanionRosterOpen(false);
    clearCompanionActorIds();
    playDistrictSelect();
    if (count === 1 && firstName) {
      const tNow = getWorldT(deps.commodore.language());
      pushToast(tNow("theWorld.companion.leftToast", { name: firstName }));
    } else if (count >= 2) {
      const tNow = getWorldT(deps.commodore.language());
      pushToast(tNow("theWorld.companion.leftAllToast", { count }));
    }
  }, [companionActors, deps, pushToast]);

  const handleRemoveSingleCompanion = useCallback((actor: WorldActorSpec) => {
    removeCompanionActorId(actor.id);
    playDistrictSelect();
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow("theWorld.companion.leftToast", { name: actor.name }));
  }, [deps, pushToast]);

  const handleJoinSingleCompanion = useCallback((actor: WorldActorSpec) => {
    addCompanionActorId(actor.id);
    playCompanionCall();
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow("theWorld.companion.joinedToast", { name: actor.name }));
  }, [deps, pushToast]);

  const handleRecruitAllCompanions = useCallback(() => {
    if (idleAvailableCommodores.length === 0) return;
    for (const actor of idleAvailableCommodores) {
      addCompanionActorId(actor.id);
    }
    playCompanionCall();
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow("theWorld.companion.recruitedAllToast", { count: idleAvailableCommodores.length }));
  }, [deps, idleAvailableCommodores, pushToast]);

  const selectedActor = useMemo(
    () => (store.selectedActorId ? snapshot.actors.find((a) => a.id === store.selectedActorId) ?? null : null),
    [snapshot.actors, store.selectedActorId],
  );
  const selectedActorDistricts = useMemo<readonly WorldDistrictSpec[] | undefined>(() => {
    if (!selectedActor || selectedActor.role !== "commodore" || !selectedActor.commodoreId) return undefined;
    const village = snapshot.villages.find((v) => v.commodoreId === selectedActor.commodoreId);
    return village?.districts;
  }, [selectedActor, snapshot.villages]);

  const handleJumpToPanelDistrict = useCallback((theaterId: string) => {
    for (const village of villagesRef.current) {
      const match = village.districts.find((d) => d.theaterId === theaterId);
      if (match) {
        closeActorInteraction();
        requestWorldTeleport(match.x, match.z);
        const tNow = getWorldT(deps.commodore.language());
        pushToast(tNow("theWorld.district.teleportAria", { name: match.label }));
        return;
      }
    }
  }, [deps, pushToast]);
  const selectedAnchorLabel = store.interactionMode === "radial" && selectedActor
    ? (runtimeRef.current?.getActorScreenAnchor(selectedActor.id) ?? null)
    : null;

  const districtCommodoreActor = useMemo(
    () => (selectedDistrict
      ? snapshot.actors.find((a) => a.role === "commodore" && a.commodoreId === selectedDistrict.commodoreId) ?? null
      : null),
    [selectedDistrict, snapshot.actors],
  );

  const districtLinkedObjectives = useMemo<readonly WorldDistrictLinkedObjective[]>(() => {
    if (!selectedDistrict || selectedDistrict.linkedObjectiveIds.length === 0) return [];
    const records = deps.readObjectiveRecords();
    const byId = new Map(records.map((r) => [r.id, r]));
    return selectedDistrict.linkedObjectiveIds.map((id) => {
      const rec = byId.get(id);
      return {
        id,
        title: rec?.title ?? id.slice(0, 8),
        status: typeof rec?.status === "string" ? rec.status : undefined,
      };
    });
  }, [deps, selectedDistrict]);

  const locale = deps.commodore.language();
  const t = getWorldT(locale);

  const contextMenuDistrict = useMemo(
    () => findDistrictInVillages(snapshot.villages, store.districtContextMenu?.districtId ?? null)?.district ?? null,
    [snapshot.villages, store.districtContextMenu],
  );

  const handleCloseDistrictContextMenu = useCallback(() => {
    closeDistrictContextMenu();
  }, []);

  const handlePlantFlagAndOrder = useCallback((district: WorldDistrictSpec) => {
    const tNow = getWorldT(deps.commodore.language());
    placeDispatchFlag(district.id, district.label);
    playFlagPlant();
    const prefill = tNow("theWorld.quickDispatch.prefillOrder", { district: district.label });
    requestChatMention(`commodore:${district.commodoreId}`, prefill);
    pushToast(tNow("theWorld.district.flagPlantedToast", { name: district.label }));
  }, [deps, pushToast]);

  const handlePlantFlagFromInspector = useCallback((district: WorldDistrictSpec) => {
    const tNow = getWorldT(deps.commodore.language());
    placeDispatchFlag(district.id, district.label);
    playFlagPlant();
    pushToast(tNow("theWorld.district.flagPlantedToast", { name: district.label }));
  }, [deps, pushToast]);

  const handleClearDispatchFlag = useCallback((districtId: string) => {
    const hadFlag = Boolean(getWorldStoreSnapshot().dispatchFlags[districtId]);
    clearDispatchFlag(districtId);
    if (hadFlag) {
      const tNow = getWorldT(deps.commodore.language());
      const districtName = findDistrictInVillages(villagesRef.current, districtId)?.district.label ?? "";
      pushToast(tNow("theWorld.district.flagClearedToast", { name: districtName }));
    }
  }, [deps, pushToast]);

  const handleSelectVillageBiome = useCallback((commodoreId: string, biome: WorldVillageBiome) => {
    setVillageBiome(commodoreId, biome);
    const village = villagesRef.current.find((v) => v.commodoreId === commodoreId);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(
      tNow("theWorld.biome.changedToast", {
        name: village?.label ?? "",
        biome: tNow(BIOME_LABEL_KEYS[biome]),
      }),
    );
  }, [deps, pushToast]);

  const handleInspectFromQuickMenu = useCallback((districtId: string) => {
    playDistrictSelect();
    selectDistrict(districtId);
  }, []);

  const handleOpenGoalsFromQuickMenu = useCallback((commodoreActorId: string) => {
    openActorPanel(commodoreActorId, "goals");
  }, []);

  const handleTestLevelUp = useCallback(() => {
    const tNow = getWorldT(deps.commodore.language());
    const pose = lastPlayerPoseRef.current;
    const px = Number.isNaN(pose.x) ? 0 : pose.x;
    const pz = Number.isNaN(pose.z) ? 1.5 : pose.z;

    let target: WorldDistrictSpec | null = selectedDistrict;
    let targetDist = target ? Math.hypot(target.x - px, target.z - pz) : Infinity;
    if (!target) {
      let nearest: WorldDistrictSpec | null = null;
      let nearestDist = Infinity;
      let highest: WorldDistrictSpec | null = null;
      for (const v of snapshot.villages) {
        for (const d of v.districts) {
          const dist = Math.hypot(d.x - px, d.z - pz);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearest = d;
          }
          if (!highest || d.tier > highest.tier) {
            highest = d;
          }
        }
      }
      target = nearestDist <= 22 ? nearest : (highest ?? nearest);
      targetDist = target ? Math.hypot(target.x - px, target.z - pz) : Infinity;
    }

    if (target) {
      runtimeRef.current?.triggerLevelUpCelebration(target.x, target.z, target.tone);
      if (targetDist > 18) {
        const yaw = Number.isNaN(pose.yaw) ? 0 : pose.yaw;
        runtimeRef.current?.triggerLevelUpCelebration(
          px + Math.sin(yaw) * 2.2,
          pz + Math.cos(yaw) * 2.2,
          target.tone,
        );
      }
      playLevelUpFanfare();
      pushCelebrationToast(
        tNow("theWorld.levelUp.toast", {
          name: target.label,
          tier: target.tier,
          tierName: tNow(TIER_NAME_KEYS[target.tier]),
        }),
      );
      return;
    }

    runtimeRef.current?.triggerLevelUpCelebration(0, -1.2, "amber");
    playLevelUpFanfare();
    pushCelebrationToast(
      tNow("theWorld.levelUp.toast", {
        name: "Plaza",
        tier: 5,
        tierName: tNow(TIER_NAME_KEYS[5]),
      }),
    );
  }, [deps, pushCelebrationToast, selectedDistrict, snapshot.villages]);

  const handleOpenWarRoom = useCallback(() => {
    playDistrictSelect();
    openWarRoom();
  }, []);

  const handleCloseWarRoom = useCallback(() => {
    closeWarRoom();
  }, []);

  const handleRallyAll = useCallback(() => {
    const tNow = getWorldT(deps.commodore.language());
    closeWarRoom();
    requestRallyAll();
    pushCelebrationToast(tNow("theWorld.warRoom.rallyToast"));
  }, [deps, pushCelebrationToast]);

  const handleVisitVillageFromWarRoom = useCallback((village: WorldVillageSpec) => {
    closeWarRoom();
    handleWarpToVillage(village);
  }, [handleWarpToVillage]);

  const handleBroadcastAll = useCallback(async (message: string) => {
    const tNow = getWorldT(deps.commodore.language());
    const trimmed = message.trim();
    if (!trimmed) return 0;
    const commodores = snapshot.actors.filter((a) => a.role === "commodore" && a.commodoreId);
    let delivered = 0;
    for (const actor of commodores) {
      if (!actor.commodoreId) continue;
      const res = await deps.sendMessageToCommodore(actor.commodoreId, trimmed);
      if (res.ok) {
        delivered += 1;
        pushActorSpeech(actor.id, tNow("theWorld.chat.receivedSpeech", { text: trimmed.slice(0, 22) }));
      }
    }
    if (delivered > 0) {
      playSend();
      pushToast(tNow("theWorld.warRoom.broadcastSentToast", { count: delivered }));
    }
    return delivered;
  }, [deps, pushToast, snapshot.actors]);

  const handleOpenAdmiralCustomizer = useCallback(() => {
    playDistrictSelect();
    openAdmiralCustomizer();
  }, []);

  const handleOpenGiftTab = useCallback((commodoreId: string) => {
    closeActorInteraction();
    playDistrictSelect();
    openAdmiralCustomizer({ tab: "gifts", focusCommodoreId: commodoreId });
  }, []);

  const handleCloseAdmiralCustomizer = useCallback(() => {
    closeAdmiralCustomizer();
  }, []);

  const handleChangeAdmiralStyle = useCallback((patch: Partial<WorldAdmiralStyle>) => {
    setAdmiralStyle(patch);
  }, []);

  const handlePreviewAdmiralChange = useCallback(() => {
    runtimeRef.current?.triggerCustomizerPreviewBounce?.();
  }, []);

  const handleOpenGazette = useCallback(() => {
    playDistrictSelect();
    openGazette();
  }, []);

  const handleCloseGazette = useCallback(() => {
    closeGazette();
  }, []);

  const handleWarpFromGazette = useCallback((village: WorldVillageSpec) => {
    closeGazette();
    handleWarpToVillage(village);
  }, [handleWarpToVillage]);

  const handleTalkFromGazette = useCallback((actorId: string) => {
    closeGazette();
    handleOpenUrgentActor(actorId);
  }, [handleOpenUrgentActor]);

  const handleToggleCinemaMode = useCallback(() => {
    const next = !getWorldStoreSnapshot().cinemaMode;
    playOverviewToggle(next);
    toggleCinemaMode();
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow(next ? "theWorld.cinema.enteredToast" : "theWorld.cinema.exitedToast"));
  }, [deps, pushToast]);

  const handleToggleBgm = useCallback(() => {
    const next = !getWorldStoreSnapshot().bgmEnabled;
    toggleBgm();
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow(next ? "theWorld.hud.bgmOnToast" : "theWorld.hud.bgmOffToast"));
  }, [deps, pushToast]);

  const handleGiftHat = useCallback((
    commodoreId: string,
    hat: WorldAdmiralHat | null,
    commodoreName: string,
  ) => {
    setCommodoreGift(commodoreId, hat);
    playDistrictSelect();
    const tNow = getWorldT(deps.commodore.language());
    if (hat === null) {
      pushToast(tNow("theWorld.admiral.giftClearedToast", { name: commodoreName }));
    } else {
      pushToast(tNow("theWorld.admiral.giftGivenToast", {
        name: commodoreName,
        hat: tNow(HAT_LABEL_KEYS[hat]),
      }));
    }
  }, [deps, pushToast]);

  const commodoreActors = useMemo(
    () => snapshot.actors.filter((a) => a.role === "commodore" && Boolean(a.commodoreId)),
    [snapshot.actors],
  );

  const handleTestRainbow = useCallback(() => {
    const tNow = getWorldT(deps.commodore.language());
    runtimeRef.current?.triggerRainbow(18);
    playLevelUpFanfare();
    pushCelebrationToast(tNow("theWorld.rainbow.toast"));
  }, [deps, pushCelebrationToast]);

  const handleChangeDistrictNote = useCallback((districtId: string, note: string) => {
    const hadNote = Boolean(getWorldStoreSnapshot().districtNotes[districtId]?.trim());
    setDistrictNote(districtId, note);
    const tNow = getWorldT(deps.commodore.language());
    const districtName = findDistrictInVillages(villagesRef.current, districtId)?.district.label ?? "";
    if (note.trim().length > 0) {
      pushToast(tNow("theWorld.district.noteSavedToast", { name: districtName }));
    } else if (hadNote) {
      pushToast(tNow("theWorld.district.noteClearedToast", { name: districtName }));
    }
  }, [deps, pushToast]);

  const handleVillageSignPointerDown = useCallback((
    village: WorldVillageSpec,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0 || !getWorldStoreSnapshot().overviewMode) return;
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    let isDragging = false;
    let latestTarget: WorldVillageSpec | null = null;

    const resolveTargetVillage = (cx: number, cy: number): WorldVillageSpec | null => {
      const els = document.elementsFromPoint(cx, cy);
      for (const el of els) {
        const btn = el.closest?.("[data-village-id]");
        const vid = btn?.getAttribute("data-village-id");
        if (vid && vid !== village.id) {
          const found = villagesRef.current.find((v) => v.id === vid);
          if (found) return found;
        }
      }
      const picked = runtimeRef.current?.pickVillageAt(cx, cy) ?? null;
      return picked && picked.id !== village.id ? picked : null;
    };

    const onMove = (e: PointerEvent) => {
      if (!isDragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 10) return;
      isDragging = true;
      latestTarget = resolveTargetVillage(e.clientX, e.clientY);
      setOverviewDragLink({
        fromVillage: village,
        startX,
        startY,
        curX: e.clientX,
        curY: e.clientY,
        targetVillage: latestTarget,
      });
    };

    const finish = (cancelled: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      villageDragCleanupRef.current = null;
      setOverviewDragLink(null);
      if (isDragging) {
        suppressVillageClickRef.current = true;
        window.requestAnimationFrame(() => {
          suppressVillageClickRef.current = false;
        });
        if (!cancelled && latestTarget && latestTarget.id !== village.id) {
          const tNow = getWorldT(deps.commodore.language());
          runtimeRef.current?.spawnCourierBetweenVillages(village, latestTarget);
          runtimeRef.current?.spawnJointMissionArch(village.x, village.z, latestTarget.x, latestTarget.z);
          playFlagPlant();
          requestChatMentions(
            [`commodore:${village.commodoreId}`, `commodore:${latestTarget.commodoreId}`],
            tNow("theWorld.overview.dragLinkPrefill", {
              from: village.label,
              to: latestTarget.label,
            }),
          );
          pushCelebrationToast(
            tNow("theWorld.jointArch.formedToast", {
              from: village.label,
              to: latestTarget.label,
            }),
          );
        }
      }
    };

    const onUp = () => finish(false);
    const onCancel = () => finish(true);

    villageDragCleanupRef.current?.();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    villageDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [deps, pushCelebrationToast]);

  const visibleLabelMetas = useMemo(
    () => (store.overviewMode
      ? labelMetas.map((lbl) => (lbl.isNearPlayer ? { ...lbl, isNearPlayer: false } : lbl))
      : labelMetas),
    [labelMetas, store.overviewMode],
  );

  const anyModalOpen = store.questBoardOpen
    || store.mailboxOpen
    || store.warRoomOpen
    || store.admiralCustomizerOpen
    || store.gazetteOpen
    || store.stampBookOpen
    || controlsGuideOpen;
  const isEnLocale = locale === "en";
  const dialogueOpen = selectedActor !== null && store.interactionMode === "dialogue";
  const panelMode = selectedActor !== null && isPanelMode(store.interactionMode) ? store.interactionMode : null;
  const playerLabelRevealed = !store.overviewMode && (playerHovered || store.admiralCustomizerOpen);

  // 낚시 중 모달·포토·채팅·이모트 휠·모닥불 착석·시네마·비행·대화 진입 시 즉시 낚시 자동 취소 (유령 입질/키 충돌 차단)
  const fishingInterrupted = anyModalOpen
    || store.photoMode
    || store.chatActive
    || store.emoteWheelOpen
    || store.sittingAtCampfire
    || store.cinemaMode
    || store.overviewMode
    || store.interactionMode !== "closed";

  useEffect(() => {
    if (store.fishingPhase !== "idle" && fishingInterrupted) {
      runtimeRef.current?.cancelFishing();
    }
  }, [fishingInterrupted, store.fishingPhase]);

  useEffect(() => {
    if (
      store.quickJumpOpen
      && (anyModalOpen || store.photoMode || store.cinemaMode || store.interactionMode !== "closed")
    ) {
      closeQuickJump();
    }
  }, [anyModalOpen, store.cinemaMode, store.interactionMode, store.photoMode, store.quickJumpOpen]);

  // `E` 키 단일 최우선 대상 산출 (`use-world-shortcuts.ts`의 KeyE 우선순위와 1:1 일치, 중복 `[E]` 배지 차단)
  const activeInteractTarget = useMemo<WorldActiveInteractTarget>(() => {
    if (
      store.lifecycle !== "open"
      || store.overviewMode
      || store.photoMode
      || store.cinemaMode
      || anyModalOpen
      || store.interactionMode !== "closed"
      || store.chatActive
      || store.sittingAtCampfire
      || store.fishingPhase !== "idle"
    ) {
      return null;
    }
    if (nearMailbox) return "mailbox";
    if (nearParadeBell) return "paradeBell";
    if (store.nearActorId && !store.companionActorIds.includes(store.nearActorId)) {
      return "actor";
    }
    if (nearCampfire) return "campfire";
    if (nearFishingWater) return "fishing";
    if (store.nearActorId) return "actor";
    return null;
  }, [
    anyModalOpen,
    nearCampfire,
    nearFishingWater,
    nearMailbox,
    nearParadeBell,
    store.chatActive,
    store.cinemaMode,
    store.companionActorIds,
    store.fishingPhase,
    store.interactionMode,
    store.lifecycle,
    store.nearActorId,
    store.overviewMode,
    store.photoMode,
    store.sittingAtCampfire,
  ]);

  const showDockInteractPrompt =
    activeInteractTarget === "mailbox"
    || activeInteractTarget === "paradeBell"
    || activeInteractTarget === "campfire"
    || activeInteractTarget === "fishing";

  // 근처 사령관/마을 정문 원클릭 결재·질문 퀵 액션 해소
  const nearFieldReviewTarget = useMemo(() => {
    if (!store.nearActorId) return null;
    const nearActor = snapshot.actors.find((a) => a.id === store.nearActorId) ?? null;
    if (!nearActor || nearActor.role !== "commodore" || !nearActor.commodoreId) return null;
    const hasAsk = questBoardData.asks.some((ask) => ask.commodoreId === nearActor.commodoreId)
      || (nearActor.askCount ?? 0) > 0;
    if (hasAsk) {
      return { kind: "ask" as const, actor: nearActor, objectiveId: null as string | null };
    }
    const reviewMission = questBoardData.reviewMissions.find((m) => m.commodoreId === nearActor.commodoreId) ?? null;
    if (reviewMission) {
      return { kind: "review" as const, actor: nearActor, objectiveId: reviewMission.objectiveId };
    }
    if (nearActor.needsAttention) {
      return { kind: "ask" as const, actor: nearActor, objectiveId: null as string | null };
    }
    return null;
  }, [questBoardData.asks, questBoardData.reviewMissions, snapshot.actors, store.nearActorId]);

  return (
    <div
      ref={rootRef}
      className={`the-world-root${store.lifecycle === "diving" ? " is-diving" : ""}${store.lifecycle === "escaping" ? " is-escaping" : ""}${store.photoMode ? " is-photo-mode" : ""}${store.cinemaMode ? " is-cinema-mode" : ""}`}
      data-flying={store.overviewMode ? "true" : undefined}
      role="region"
      aria-label={t("theWorld.stage.aria")}
      onContextMenu={handleRootContextMenu}
      {...{ [NATIVE_VIEW_COVER_ATTRIBUTE]: "" }}
    >
      <canvas
        ref={canvasRef}
        className={`the-world-canvas${store.hoveredDistrictId ? " is-hovering-district" : ""}`}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerLeave={handleCanvasPointerLeave}
        onPointerUp={handleCanvasPointerUp}
        onContextMenu={handleCanvasContextMenu}
      />

      <div
        className={`the-world-warp-veil${store.lifecycle === "diving" || store.lifecycle === "escaping" ? " is-active" : ""}`}
        aria-hidden="true"
      />

      <WorldLabelsOverlay
        ref={labelsOverlayRef}
        lifecycle={store.lifecycle}
        cameraMode={store.cameraMode}
        interactionMode={store.interactionMode}
        anyModalOpen={anyModalOpen}
        photoMode={store.photoMode}
        cinemaMode={store.cinemaMode}
        sittingAtCampfire={store.sittingAtCampfire || store.overviewMode}
        suppressInteractPrompts={store.fishingPhase !== "idle" || activeInteractTarget !== "actor"}
        activeInteractTarget={activeInteractTarget}
        playerLabelRevealed={playerLabelRevealed}
        villages={snapshot.villages}
        labelMetas={visibleLabelMetas}
        hoveredDistrict={hoveredDistrict}
        selectedDistrictId={store.selectedDistrictId}
        dragTargetVillageId={overviewDragLink?.targetVillage?.id ?? null}
        totalUrgentCount={questBoardData.totalUrgentCount}
        locale={locale}
        onOpenAdmiralCustomizer={handleOpenAdmiralCustomizer}
        onVillageSignPointerDown={handleVillageSignPointerDown}
        onVillageSignClick={handleVillageSignClick}
        onOpenWarRoom={handleOpenWarRoom}
        onSitAtCampfire={handleSitAtCampfireFromSign}
        onOpenQuestBoard={handleOpenQuestBoardFromSign}
        onInteractActor={handleInteractActorFromLabel}
        onOpenUrgentActor={handleOpenUrgentActor}
      />

      {store.lifecycle === "open" ? (
        <>
          <WorldSpeechSync
            actors={snapshot.actors}
            deps={deps}
            onPushSpeech={handlePushSpeech}
            onCourierEvent={handleCourierEvent}
          />
          {overviewDragLink ? (() => {
            const mx = (overviewDragLink.startX + overviewDragLink.curX) * 0.5;
            const my = Math.min(overviewDragLink.startY, overviewDragLink.curY) - 48;
            const pathD = `M ${overviewDragLink.startX} ${overviewDragLink.startY} Q ${mx} ${my} ${overviewDragLink.curX} ${overviewDragLink.curY}`;
            return (
              <>
                <svg className="the-world-overview-drag-svg" aria-hidden="true">
                  <path className="the-world-overview-drag-line" d={pathD} />
                  <circle className="the-world-overview-drag-dot" cx={overviewDragLink.startX} cy={overviewDragLink.startY} r={5} />
                  <circle
                    className={`the-world-overview-drag-dot${overviewDragLink.targetVillage ? " is-locked" : ""}`}
                    cx={overviewDragLink.curX}
                    cy={overviewDragLink.curY}
                    r={overviewDragLink.targetVillage ? 7 : 5}
                  />
                </svg>
                {overviewDragLink.targetVillage ? (
                  <span
                    className="the-world-overview-drag-label"
                    style={{ left: `${mx}px`, top: `${my}px` }}
                    aria-hidden="true"
                  >
                    {t("theWorld.overview.dragLinkLabel", {
                      from: overviewDragLink.fromVillage.label,
                      to: overviewDragLink.targetVillage.label,
                    })}
                  </span>
                ) : null}
              </>
            );
          })() : null}
          {store.overviewMode && store.interactionMode === "closed" && !anyModalOpen && !store.photoMode && !store.cinemaMode && !toastMessage && !celebrationToast ? (
            <button
              type="button"
              className="the-world-overview-banner"
              aria-label={t("theWorld.hud.overviewAria")}
              onClick={handleToggleFlight}
            >
              <WorldIcon name="sparkle" size={14} tone="amber" />
              <span>{t("theWorld.flight.banner")}</span>
            </button>
          ) : null}
          {store.overviewMode && !anyModalOpen && !store.photoMode && !store.cinemaMode ? (
            <WorldFlightRingGuide
              containerRef={ringGuideElRef}
              chevronRef={ringGuideChevronRef}
              distRef={ringGuideDistRef}
              locale={locale}
            />
          ) : null}
          {store.overviewMode && ringComboHud && !anyModalOpen && !store.photoMode && !store.cinemaMode ? (
            <div
              className={`the-world-ring-combo-pill${ringComboHud.boost ? " is-boost" : ""}`}
              role="status"
              aria-live="polite"
            >
              <WorldIcon name="sparkle" size={14} tone="amber" />
              <span>
                {isEnLocale
                  ? `RING COMBO ×${ringComboHud.count}${ringComboHud.boost ? " · STAR BOOST!" : ""}`
                  : `링 콤보 ×${ringComboHud.count}${ringComboHud.boost ? " · 별빛 부스트!" : ""}`}
              </span>
            </div>
          ) : null}
          {companionActors.length > 0 && !store.photoMode && !store.cinemaMode && !anyModalOpen && !store.overviewMode ? (
            <div
              ref={companionShellRef}
              className="the-world-companion-shell"
              onPointerDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              <div
                className={`the-world-companion-pill${companionRosterOpen ? " is-open" : ""}`}
                role="status"
                aria-live="polite"
              >
                <button
                  type="button"
                  className="the-world-companion-pill-trigger"
                  aria-expanded={companionRosterOpen}
                  aria-label={t("theWorld.companion.rosterToggleAria")}
                  onClick={() => {
                    playDistrictHover();
                    setCompanionRosterOpen((prev) => !prev);
                  }}
                >
                  <span className="the-world-companion-pill-dot" aria-hidden="true" />
                  <span className="the-world-companion-pill-text">
                    {companionActors.length === 1
                      ? t("theWorld.companion.pill", { name: companionActors[0]!.name })
                      : t("theWorld.companion.pillMulti", {
                          name: companionActors[0]!.name,
                          others: companionActors.length - 1,
                        })}
                  </span>
                  <span className="the-world-companion-pill-caret" aria-hidden="true">
                    {companionRosterOpen ? "▴" : "▾"}
                  </span>
                </button>
                <button
                  type="button"
                  className="the-world-companion-pill-end"
                  onClick={handleEndCompanionWalk}
                >
                  {companionActors.length === 1
                    ? t("theWorld.companion.endWalk")
                    : t("theWorld.companion.endWalkAll")}
                </button>
              </div>

              {companionRosterOpen ? (
                <section
                  className="the-world-companion-roster"
                  role="dialog"
                  aria-label={t("theWorld.companion.rosterAria")}
                >
                  <div className="the-world-crest" aria-hidden="true" />
                  <header className="the-world-companion-roster-head">
                    <span className="the-world-companion-roster-title">
                      <WorldIcon name="crew" size={13} tone="amber" />
                      <span>{t("theWorld.companion.rosterTitle", { count: companionActors.length })}</span>
                    </span>
                    <div className="the-world-companion-roster-actions">
                      {idleAvailableCommodores.length > 0 ? (
                        <button
                          type="button"
                          className="the-world-companion-roster-btn is-primary"
                          onClick={handleRecruitAllCompanions}
                        >
                          <WorldIcon name="sparkle" size={11} tone="inherit" />
                          <span>{t("theWorld.companion.recruitAll")}</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="the-world-companion-roster-btn"
                        onClick={handleEndCompanionWalk}
                      >
                        <span>{t("theWorld.companion.endWalkAll")}</span>
                      </button>
                    </div>
                  </header>

                  <div className="the-world-companion-roster-body">
                    <div className="the-world-companion-roster-section">
                      <span className="the-world-companion-roster-heading">
                        {t("theWorld.companion.activeHeading")}
                      </span>
                      <div className="the-world-companion-roster-list">
                        {companionActors.map((actor) => (
                          <div key={actor.id} className="the-world-companion-roster-row is-active">
                            <div className="the-world-companion-roster-who">
                              <MongleAvatar
                                base={actor.baseId}
                                tone={actor.tone}
                                role={actor.role}
                                state={actor.state}
                                activity={actor.activity}
                                size={24}
                                label={actor.name}
                                decorative
                              />
                              <span className="the-world-companion-roster-name">{actor.name}</span>
                            </div>
                            <button
                              type="button"
                              className="the-world-companion-roster-remove"
                              aria-label={t("theWorld.companion.removeOneAria", { name: actor.name })}
                              onClick={() => handleRemoveSingleCompanion(actor)}
                            >
                              <WorldIcon name="close" size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="the-world-companion-roster-section">
                      <span className="the-world-companion-roster-heading">
                        {t("theWorld.companion.availableHeading")}
                      </span>
                      {otherCommodores.length === 0 ? (
                        <p className="the-world-companion-roster-empty">
                          {t("theWorld.companion.allJoinedEmpty")}
                        </p>
                      ) : (
                        <div className="the-world-companion-roster-list">
                          {otherCommodores.map(({ actor, busy }) => (
                            <div
                              key={actor.id}
                              className={`the-world-companion-roster-row${busy ? " is-busy" : ""}`}
                            >
                              <div className="the-world-companion-roster-who">
                                <MongleAvatar
                                  base={actor.baseId}
                                  tone={actor.tone}
                                  role={actor.role}
                                  state={actor.state}
                                  activity={actor.activity}
                                  size={24}
                                  label={actor.name}
                                  decorative
                                />
                                <span className="the-world-companion-roster-name">{actor.name}</span>
                              </div>
                              {busy ? (
                                <span className="the-world-companion-roster-busy">
                                  {t("theWorld.companion.busyLabel")}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="the-world-companion-roster-join"
                                  onClick={() => handleJoinSingleCompanion(actor)}
                                >
                                  {t("theWorld.companion.joinOne")}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
          {!store.photoMode && !store.cinemaMode && !store.overviewMode && !anyModalOpen && store.interactionMode === "closed"
            && (nearFieldReviewTarget !== null || showDockInteractPrompt) ? (
            <div className="the-world-proximity-dock">
              {nearFieldReviewTarget ? (
                <button
                  type="button"
                  className={`the-world-field-review-chip ${nearFieldReviewTarget.kind === "ask" ? "is-ask" : "is-review"}`}
                  aria-label={t(
                    nearFieldReviewTarget.kind === "ask"
                      ? "theWorld.fieldReview.askAria"
                      : "theWorld.fieldReview.reviewAria",
                    { name: nearFieldReviewTarget.actor.name },
                  )}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    playDistrictSelect();
                    if (nearFieldReviewTarget.kind === "review" && nearFieldReviewTarget.objectiveId) {
                      openActorPanel(nearFieldReviewTarget.actor.id, "goals", nearFieldReviewTarget.objectiveId);
                    } else {
                      openActorDialogue(nearFieldReviewTarget.actor.id);
                    }
                  }}
                >
                  <WorldIcon
                    name={nearFieldReviewTarget.kind === "ask" ? "bell" : "questBoard"}
                    size={12}
                    tone={nearFieldReviewTarget.kind === "ask" ? "amber" : "cerulean"}
                  />
                  <span className="the-world-field-review-chip-label">
                    {nearFieldReviewTarget.actor.name} ·{" "}
                    {t(
                      nearFieldReviewTarget.kind === "ask"
                        ? "theWorld.fieldReview.answerAsk"
                        : "theWorld.fieldReview.reviewMission",
                    )}
                  </span>
                </button>
              ) : null}
              {activeInteractTarget === "mailbox" ? (
                <button
                  type="button"
                  className="the-world-field-review-chip is-ask"
                  aria-label={t("theWorld.hud.mailboxAria")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={handleOpenMailbox}
                >
                  <WorldIcon name="bell" size={12} tone="amber" />
                  <span className="the-world-field-review-chip-label">
                    {isEnLocale
                      ? `E · Check Fleet Mailbox${unreadMailCount > 0 ? ` (${unreadMailCount})` : ""}`
                      : `E · 함대 우체통 확인${unreadMailCount > 0 ? ` (${unreadMailCount})` : ""}`}
                  </span>
                </button>
              ) : activeInteractTarget === "paradeBell" ? (
                <button
                  type="button"
                  className="the-world-field-review-chip is-ask"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={handleRingParadeBell}
                >
                  <WorldIcon name="bell" size={12} tone="amber" />
                  <span className="the-world-field-review-chip-label">{t("theWorld.bell.prompt")}</span>
                </button>
              ) : activeInteractTarget === "campfire" ? (
                <button
                  type="button"
                  className="the-world-field-review-chip is-ask"
                  aria-label={t("theWorld.campfire.sitAria")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    playDistrictSelect();
                    setSittingAtCampfire(true);
                  }}
                >
                  <WorldIcon name="fire" size={12} tone="amber" />
                  <span className="the-world-field-review-chip-label">
                    E · {t("theWorld.campfire.sitHint")}
                  </span>
                </button>
              ) : activeInteractTarget === "fishing" ? (
                <button
                  type="button"
                  className="the-world-field-review-chip is-review"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={handleStartFishing}
                >
                  <WorldIcon name="sparkle" size={12} tone="teal" />
                  <span className="the-world-field-review-chip-label">{t("theWorld.fishing.castPrompt")}</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {(store.fishingPhase === "waiting" || store.fishingPhase === "bite") && !store.photoMode && !store.cinemaMode && !anyModalOpen ? (
            <div
              className={`the-world-fishing-hud${store.fishingPhase === "bite" ? " the-world-fishing-bite" : ""}`}
              role="status"
              aria-live="polite"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={store.fishingPhase === "bite" ? handleReelFishing : undefined}
            >
              <WorldIcon name={store.fishingPhase === "bite" ? "bell" : "sparkle"} size={14} tone="amber" />
              <span>
                {store.fishingPhase === "bite"
                  ? t("theWorld.fishing.bite")
                  : t("theWorld.fishing.waiting")}
              </span>
              <button
                type="button"
                className="the-world-fishing-hud-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancelFishing();
                }}
              >
                {t("theWorld.fishing.cancel")}
              </button>
            </div>
          ) : null}
          {store.lastFishCatch && !store.photoMode && !store.cinemaMode ? (
            <section
              className="the-world-fish-catch-card"
              role="status"
              aria-live="polite"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="the-world-fish-catch-head">
                <span className="the-world-fish-catch-kicker">
                  <WorldIcon name="sparkle" size={13} tone="amber" />
                  <span>{t("theWorld.fishing.caughtTitle")}</span>
                  {store.lastFishCatch.isNew ? (
                    <span className="the-world-fish-catch-new">{t("theWorld.fishing.newDiscovery")}</span>
                  ) : null}
                </span>
                <span className={`the-world-fish-rarity is-${store.lastFishCatch.rarity}`}>
                  {t(FISH_RARITY_KEYS[store.lastFishCatch.rarity])}
                </span>
              </div>
              <h4 className="the-world-fish-catch-name">
                {t(FISH_TITLE_KEYS[store.lastFishCatch.fishId])}
              </h4>
              <p className="the-world-fish-catch-desc">
                {store.lastFishCatch.fishId === "message_bottle" && store.lastFishCatch.senderName
                  ? t("theWorld.fishing.bottleMessage", { name: store.lastFishCatch.senderName })
                  : t(FISH_DESC_KEYS[store.lastFishCatch.fishId])}
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={`the-world-fish-release-btn${releasedFishIds.includes(store.lastFishCatch.fishId) ? " is-released" : ""}`}
                  aria-pressed={releasedFishIds.includes(store.lastFishCatch.fishId)}
                  onClick={() => {
                    const fishId = store.lastFishCatch?.fishId;
                    if (!fishId) return;
                    const wasReleased = releasedFishIds.includes(fishId);
                    toggleReleasedFish(fishId);
                    if (!wasReleased) {
                      playPondSplash();
                      pushToast(
                        isEnLocale
                          ? "Released into the Starlight Pond!"
                          : "별빛 연못에 방생했어요! 광장 연못에서 헤엄쳐요.",
                      );
                    } else {
                      playDistrictSelect();
                    }
                  }}
                >
                  <WorldIcon name="sparkle" size={11} tone="teal" />
                  <span>
                    {releasedFishIds.includes(store.lastFishCatch.fishId)
                      ? (isEnLocale ? "Swimming in Pond ✓" : "연못에서 헤엄치는 중 ✓")
                      : (isEnLocale ? "Release to Starlight Pond" : "별빛 연못에 방생하기")}
                  </span>
                </button>
                <button
                  type="button"
                  className="the-world-fishing-hud-btn"
                  onClick={handleOpenFishBook}
                >
                  <WorldIcon name="trophy" size={11} tone="amber" />
                  <span>
                    {t("theWorld.fishing.tabFish", {
                      count: Object.keys(store.caughtFishCounts).filter((k) => (store.caughtFishCounts[k] ?? 0) > 0).length,
                      total: 8,
                    })}
                  </span>
                </button>
              </div>
            </section>
          ) : null}
          {store.sittingAtCampfire && !store.photoMode && !anyModalOpen ? (
            <button
              type="button"
              className="the-world-campfire-banner"
              aria-label={t("theWorld.campfire.standAria")}
              onClick={() => setSittingAtCampfire(false)}
            >
              <WorldIcon name="fire" size={14} tone="amber" />
              <span>{t("theWorld.campfire.sittingBanner")}</span>
            </button>
          ) : null}
          <WorldHud
            snapshot={snapshot}
            locale={locale}
            reducedMotion={deps.isReducedMotion()}
            toastMessage={celebrationToast ?? toastMessage}
            toastKind={celebrationToast ? "celebration" : "info"}
            hideBottom={
              dialogueOpen
              || panelMode !== null
              || anyModalOpen
              || store.sittingAtCampfire
              || store.cinemaMode
              || (store.overviewMode && !store.chatActive)
            }
            urgentQuestCount={questBoardData.totalUrgentCount}
            unreadMailCount={unreadMailCount}
            villages={snapshot.villages}
            onWarpTo={handleWarpTo}
            onWarpToDistrict={handleWarpToDistrict}
            onResetWorldLocalData={handleResetWorldLocalData}
            weatherMode={store.weatherMode}
            onSelectWeather={handleSelectWeather}
            timeMode={store.timeMode}
            onSelectTimeMode={handleSelectTimeMode}
            onCreateCommodore={deps.openCreateCommodore}
            onStatusBanner={pushToast}
            onTestLevelUp={handleTestLevelUp}
            onTestRainbow={handleTestRainbow}
            onOpenWarRoom={handleOpenWarRoom}
            onOpenGazette={handleOpenGazette}
            onOpenMailbox={handleOpenMailbox}
            onRingParadeBell={handleRingParadeBell}
            onToggleCinemaMode={handleToggleCinemaMode}
            onToggleBgm={handleToggleBgm}
            onOpenAdmiralCustomizer={handleOpenAdmiralCustomizer}
            onOpenCustomizer={handleOpenAdmiralCustomizer}
            onTriggerEmote={handleTriggerEmote}
            onToggleControlsGuide={handleToggleControlsGuide}
            controlsGuideOpen={controlsGuideOpen}
            debugPanelVisible={debugPanelVisible}
            currentZoneLabel={currentZone?.label ?? null}
            currentZoneTone={currentZone?.tone ?? null}
          />
          {snapshot.villages.length === 0 && !store.photoMode && !store.cinemaMode && !anyModalOpen && !store.overviewMode && store.interactionMode === "closed" ? (
            <section
              className="the-world-empty-welcome"
              aria-label={t("theWorld.emptyWorld.title")}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="the-world-empty-welcome-icon" aria-hidden="true">
                <WorldIcon name="sparkle" size={20} tone="amber" />
              </div>
              <div className="the-world-empty-welcome-copy">
                <h3 className="the-world-empty-welcome-title">{t("theWorld.emptyWorld.title")}</h3>
                <p className="the-world-empty-welcome-desc">{t("theWorld.emptyWorld.desc")}</p>
              </div>
              <button
                type="button"
                className="the-world-primary-action"
                onClick={deps.openCreateCommodore}
              >
                <WorldIcon name="recruit" size={14} tone="inherit" />
                <span>{t("theWorld.emptyWorld.cta")}</span>
              </button>
            </section>
          ) : null}
          <WorldControlsGuide
            open={controlsGuideOpen}
            onClose={handleCloseControlsGuide}
            locale={locale}
          />
          {panelMode === null && !anyModalOpen && !store.cinemaMode ? (
            <WorldChatLog
              actors={snapshot.actors}
              deps={deps}
              hidden={dialogueOpen || (store.overviewMode && !store.chatActive)}
              onStatusBanner={pushToast}
            />
          ) : null}
          {store.mailboxOpen ? (
            <WorldMailbox
              open
              locale={locale}
              questData={questBoardData}
              snapshot={snapshot}
              deps={deps}
              onWarpToVillage={handleWarpFromMailbox}
              onOpenDialogue={handleTalkFromMailbox}
              onClose={handleCloseMailbox}
            />
          ) : null}
          {store.gazetteOpen ? (
            <WorldGazette
              open
              snapshot={snapshot}
              questData={questBoardData}
              weatherMode={store.weatherMode}
              timeMode={store.timeMode}
              locale={locale}
              onWarpToVillage={handleWarpFromGazette}
              onTalkToCommodore={handleTalkFromGazette}
              onClose={handleCloseGazette}
            />
          ) : null}
          {store.questBoardOpen ? (
            <WorldQuestBoardModal
              data={questBoardData}
              actors={snapshot.actors}
              deps={deps}
              onClose={handleCloseQuestBoard}
              onVisitCommodore={handleVisitQuestCommodore}
              onOpenDialogue={handleOpenDistrictDialogue}
              onInspectObjective={handleOpenDistrictObjective}
            />
          ) : null}
          {store.warRoomOpen ? (
            <WorldWarRoom
              snapshot={snapshot}
              locale={locale}
              deps={deps}
              onClose={handleCloseWarRoom}
              onRallyAll={handleRallyAll}
              onVisitVillage={handleVisitVillageFromWarRoom}
              onBroadcastAll={handleBroadcastAll}
              onOpenInConsole={handleOpenInConsole}
            />
          ) : null}
          {store.stampBookOpen ? (
            <WorldStampBook
              open
              unlockedStamps={store.unlockedStamps}
              caughtFishCounts={store.caughtFishCounts}
              initialTab={stampBookInitialTab}
              locale={locale}
              onOpenCustomizer={handleOpenAdmiralCustomizer}
              onPondSplash={playPondSplash}
              onClose={handleCloseStampBook}
            />
          ) : null}
          {store.admiralCustomizerOpen ? (
            <WorldAdmiralCustomizer
              style={store.admiralStyle}
              locale={locale}
              commodores={commodoreActors}
              commodoreGifts={store.commodoreGifts}
              onChangeStyle={handleChangeAdmiralStyle}
              onGiftHat={handleGiftHat}
              onPreviewChange={handlePreviewAdmiralChange}
              onLockedHint={pushToast}
              onOpenStampBook={handleOpenStampBookFromCustomizer}
              onClose={handleCloseAdmiralCustomizer}
            />
          ) : null}
          {selectedDistrict && store.interactionMode === "closed" && !anyModalOpen && !store.cinemaMode ? (
            <WorldDistrictInspector
              district={selectedDistrict}
              village={selectedVillage}
              commodoreActor={districtCommodoreActor}
              linkedObjectives={districtLinkedObjectives}
              locale={locale}
              refreshing={metricsLoading}
              hasDispatchFlag={Boolean(store.dispatchFlags[selectedDistrict.id])}
              districtNote={store.districtNotes[selectedDistrict.id] ?? ""}
              onClose={handleCloseDistrict}
              onRefreshMetrics={handleRefreshMetrics}
              onMentionCommodore={handleMentionCommodore}
              onTeleportToDistrict={handleTeleportToDistrict}
              onOpenDialogue={handleOpenDistrictDialogue}
              onFocusCommodore={handleFocusDistrictCommodore}
              onOpenObjective={handleOpenDistrictObjective}
              onPlantDispatchFlag={handlePlantFlagFromInspector}
              onClearDispatchFlag={handleClearDispatchFlag}
              onSelectVillageBiome={handleSelectVillageBiome}
              onChangeNote={handleChangeDistrictNote}
              operationFlag={store.operationFlag}
              onDeployOperationFlag={handleDeployOperationFlag}
              onClearOperationFlag={handleClearOperationFlag}
              onOpenInConsole={handleOpenInConsole}
              deps={deps}
            />
          ) : null}
          {store.districtContextMenu && contextMenuDistrict && !store.photoMode && !store.cinemaMode && !anyModalOpen ? (
            <WorldDistrictQuickMenu
              district={contextMenuDistrict}
              clientX={store.districtContextMenu.clientX}
              clientY={store.districtContextMenu.clientY}
              hasDispatchFlag={Boolean(store.dispatchFlags[contextMenuDistrict.id])}
              locale={locale}
              onClose={handleCloseDistrictContextMenu}
              onPlantFlagAndOrder={handlePlantFlagAndOrder}
              onClearFlag={handleClearDispatchFlag}
              onInspectDistrict={handleInspectFromQuickMenu}
              onOpenDialogue={handleOpenDistrictDialogue}
              onOpenGoals={handleOpenGoalsFromQuickMenu}
            />
          ) : null}
          <WorldPhotoStudio
            open={store.photoMode}
            locale={locale}
            snapshotPreview={store.photoSnapshotPreview}
            onGroupPose={handlePhotoGroupPose}
            onCapture={handlePhotoCapture}
            onExit={handlePhotoExit}
            onStatusBanner={pushToast}
          />
          <WorldEmoteWheel
            open={store.emoteWheelOpen}
            locale={locale}
            onSelectEmote={handleSelectAdmiralEmote}
            onClose={handleCloseEmoteWheel}
          />
          <WorldSkyCommand
            overviewMode={store.overviewMode && !store.photoMode && !store.cinemaMode && !anyModalOpen}
            hoverTarget={skyHoverTarget}
            quickMenu={store.skyQuickMenu}
            villages={snapshot.villages}
            actors={snapshot.actors}
            deps={deps}
            locale={locale}
            onCloseQuickMenu={handleCloseSkyQuickMenu}
            onAnswerAsk={handleSkyAnswerAsk}
            onDiveToTarget={handleSkyDiveToTarget}
            onOpenNotebook={handleSkyOpenNotebook}
            onStatusBanner={pushToast}
            operationFlag={store.operationFlag}
            onDeployOperationFlag={handleDeployOperationFlag}
            onClearOperationFlag={handleClearOperationFlag}
          />
          {store.interactionMode === "radial" && selectedActor ? (
            <WorldRadialMenu
              actor={selectedActor}
              anchorLabel={selectedAnchorLabel}
              isNear={store.nearActorId === selectedActor.id}
              deps={deps}
              onStatusBanner={pushToast}
              onOpenGiftTab={handleOpenGiftTab}
            />
          ) : null}
          {dialogueOpen && selectedActor ? (
            <WorldDialogueBox
              actor={selectedActor}
              deps={deps}
              onStatusBanner={pushToast}
            />
          ) : null}
          {panelMode && selectedActor ? (
            <WorldPanelModal
              actor={selectedActor}
              mode={panelMode}
              inspectedObjectiveId={store.inspectedObjectiveId}
              deps={deps}
              districts={selectedActorDistricts}
              onJumpToDistrict={handleJumpToPanelDistrict}
              onOpenInConsole={handleOpenInConsole}
              onStatusBanner={pushToast}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
