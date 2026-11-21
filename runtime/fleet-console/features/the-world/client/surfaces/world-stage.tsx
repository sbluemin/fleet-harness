import { NATIVE_VIEW_COVER_ATTRIBUTE } from "@fleet-console/ui/native-view";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  type WorldActorPanelMode,
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
  playDistrictHover,
  playDistrictSelect,
  playFlagPlant,
  playLevelUpFanfare,
  playMongleChirp,
  playOverviewToggle,
  playPhotoShutter,
  playSend,
  playWarp,
  setWorldAudioMuted,
} from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import { useWorldSnapshot } from "../world-projection.js";
import {
  clearDispatchFlag,
  closeActorInteraction,
  closeAdmiralCustomizer,
  closeDistrictContextMenu,
  closeQuestBoard,
  closeWarRoom,
  deactivateChat,
  getWorldStoreSnapshot,
  openActorDialogue,
  openActorPanel,
  openActorRadialMenu,
  openAdmiralCustomizer,
  openDistrictContextMenu,
  openQuestBoard,
  openWarRoom,
  placeDispatchFlag,
  pushActorSpeech,
  requestApproachActor,
  requestChatMention,
  requestChatMentions,
  requestPlayerEmote,
  requestRallyAll,
  requestWorldTeleport,
  selectDistrict,
  setAdmiralStyle,
  setDistrictNote,
  setHoveredDistrict,
  setNearWorldActor,
  setOverviewMode,
  setPhotoMode,
  setSittingAtCampfire,
  setVillageBiome,
  setWeatherMode,
  setWorldTimeMode,
  toggleOverviewMode,
  useWorldStore,
} from "../world-store.js";
import { useWorldShortcuts } from "./use-world-shortcuts.js";
import { WorldAdmiralCustomizer } from "./world-admiral-customizer.js";
import { WorldChatLog, WorldSpeechSync } from "./world-chat-log.js";
import { WorldControlsGuide } from "./world-controls-guide.js";
import { WorldDialogueBox } from "./world-dialogue-box.js";
import { WorldDistrictInspector, type WorldDistrictLinkedObjective } from "./world-district-inspector.js";
import { WorldDistrictQuickMenu } from "./world-district-quick-menu.js";
import { WorldHud } from "./world-hud.js";
import { WorldIcon } from "./world-icons.js";
import { WorldLabelsOverlay, type WorldLabelsOverlayHandle } from "./world-labels-overlay.js";
import {
  formatMinimapPlayerTransform,
  WorldMinimap,
  type WorldMinimapHandle,
  type WorldMinimapJumpItem,
} from "./world-minimap.js";
import { WorldPanelModal } from "./world-panel-modal.js";
import { WorldQuestBoardModal } from "./world-quest-board.js";
import { WorldRadialMenu } from "./world-radial-menu.js";
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
  const snapshot = useWorldSnapshot(deps);
  const questBoardData = deps.useWorldQuestBoard(snapshot.actors);
  const metricsLoading = useSyncExternalStore(
    deps.subscribeTheaterMetrics,
    deps.isTheaterMetricsLoading,
    deps.isTheaterMetricsLoading,
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<WorldRuntimeHandle | null>(null);
  const labelsOverlayRef = useRef<WorldLabelsOverlayHandle | null>(null);
  const minimapRef = useRef<WorldMinimapHandle | null>(null);
  const minimapPlayerRef = useRef<SVGGElement | null>(null);
  const lastMinimapPoseRef = useRef({ x: Number.NaN, z: Number.NaN, yaw: Number.NaN });

  // 구조 상태만 React state에 보관(목록·말풍선·근접·선택 변경 시에만 갱신, 평시 0Hz)
  const [labelMetas, setLabelMetas] = useState<readonly WorldActorLabelMeta[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [celebrationToast, setCelebrationToast] = useState<string | null>(null);
  const [controlsGuideOpen, setControlsGuideOpen] = useState(false);
  const [debugPanelVisible, setDebugPanelVisible] = useState(false);
  const [playerHovered, setPlayerHovered] = useState(false);
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

  const toastTimerRef = useRef<number | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);
  const prevDistrictTiersRef = useRef<Map<string, WorldDevelopmentTier>>(new Map());
  const suppressVillageClickRef = useRef(false);
  const villagesRef = useRef<readonly WorldVillageSpec[]>(snapshot.villages);
  villagesRef.current = snapshot.villages;

  const handleFramePositions = useCallback((positions: WorldFrameOverlayPositions) => {
    labelsOverlayRef.current?.applyFramePositions(positions);
    minimapRef.current?.updateRoamingDots?.(positions.minimapActors);

    // 전략 미니맵 플레이어 위치/방향 마커 0Hz Direct-DOM 갱신 (정지 중 SVG 쓰기 0)
    const markerEl = minimapPlayerRef.current;
    if (markerEl) {
      const prev = lastMinimapPoseRef.current;
      const px = positions.playerWorldX;
      const pz = positions.playerWorldZ;
      const pyaw = positions.playerYaw;
      if (
        Number.isNaN(prev.x)
        || Math.abs(px - prev.x) >= 0.08
        || Math.abs(pz - prev.z) >= 0.08
        || Math.abs(pyaw - prev.yaw) >= 0.03
      ) {
        markerEl.setAttribute("transform", formatMinimapPlayerTransform(px, pz, pyaw));
        prev.x = px;
        prev.z = pz;
        prev.yaw = pyaw;
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

  const handleToggleControlsGuide = useCallback(() => {
    setControlsGuideOpen((prev) => !prev);
  }, []);

  const handleCloseControlsGuide = useCallback(() => {
    setControlsGuideOpen(false);
  }, []);

  const handleToggleDebugPanel = useCallback(() => {
    setDebugPanelVisible((prev) => !prev);
  }, []);

  const handlePushSpeech = useCallback((actorId: string, text: string) => {
    runtimeRef.current?.pushSpeech(actorId, text);
  }, []);

  const handleCourierEvent = useCallback((fromActorId: string, targetName: string) => {
    runtimeRef.current?.spawnCourierBetweenActors(fromActorId, targetName);
  }, []);

  // 프로시저럴 오디오 음소거 상태 동기화
  useEffect(() => {
    setWorldAudioMuted(store.soundMuted);
  }, [store.soundMuted]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    if (celebrationTimerRef.current !== null) window.clearTimeout(celebrationTimerRef.current);
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
      onLabelsStructureChanged: setLabelMetas,
      onFramePositions: handleFramePositions,
    });
    const initial = getWorldStoreSnapshot();
    runtime.setWeather(initial.weatherMode);
    runtime.setAdmiralStyle(initial.admiralStyle.tone, initial.admiralStyle.hat);
    runtimeRef.current = runtime;
    return () => {
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [deps, handleFramePositions]);

  // 실시간 월드 스냅샷 동기화
  useEffect(() => {
    runtimeRef.current?.applySnapshot(snapshot);
  }, [snapshot]);

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
  }, [store.overviewMode]);

  useEffect(() => {
    runtimeRef.current?.setWeather(store.weatherMode);
  }, [store.weatherMode]);

  useEffect(() => {
    runtimeRef.current?.setAdmiralStyle(store.admiralStyle.tone, store.admiralStyle.hat);
  }, [store.admiralStyle]);

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

  // 더 월드 진입 시 배경 콘솔에 남은 포커스를 해제해 즉시 `Enter` 채팅이 동작하도록 한다.
  useEffect(() => {
    if (store.lifecycle !== "open" && store.lifecycle !== "diving") return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !rootRef.current?.contains(active)) {
      active.blur();
    }
  }, [store.lifecycle]);

  // 전역 키보드 단축키 (`use-world-shortcuts.ts`)
  useWorldShortcuts({
    rootRef,
    lastPlayerPoseRef: lastMinimapPoseRef,
    controlsGuideOpenRef,
    onToggleControlsGuide: handleToggleControlsGuide,
    onCloseControlsGuide: handleCloseControlsGuide,
    onToggleDebugPanel: handleToggleDebugPanel,
    isReducedMotion: deps.isReducedMotion,
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
      || snap.warRoomOpen
      || snap.admiralCustomizerOpen
      || controlsGuideOpenRef.current
      || snap.photoMode
    ) {
      return;
    }
    const hitDistrict = runtimeRef.current?.pickDistrictAt(event.clientX, event.clientY) ?? null;
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
  }, []);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerDownRef.current !== null) return;
    const snap = getWorldStoreSnapshot();
    if (
      snap.lifecycle !== "open"
      || snap.interactionMode !== "closed"
      || snap.questBoardOpen
      || snap.warRoomOpen
      || snap.admiralCustomizerOpen
      || controlsGuideOpenRef.current
    ) {
      if (snap.hoveredDistrictId !== null) setHoveredDistrict(null);
      if (playerHoveredRef.current) setPlayerHovered(false);
      return;
    }
    const now = performance.now();
    if (now - lastHoverPickRef.current < HOVER_PICK_THROTTLE_MS) return;
    lastHoverPickRef.current = now;

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
  }, []);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = pointerDownRef.current;
    pointerDownRef.current = null;
    const snap = getWorldStoreSnapshot();
    if (!start || snap.lifecycle !== "open") return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;

    if (snap.chatActive) {
      deactivateChat();
    }

    if (snap.admiralCustomizerOpen) {
      return;
    }

    // 클릭 우선순위: 1. 캐릭터 → 2. 3D 퀘스트 게시판 → 3. 모닥불 벤치 → 4. 길드 회관(상황실) → 5. Theater 구역 → 6. (하늘 조망 중) 사령관 마을 → 7. 빈 땅 해제/이동
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

    if (snap.overviewMode) {
      const hitVillage = runtimeRef.current?.pickVillageAt(e.clientX, e.clientY) ?? null;
      if (hitVillage) {
        const landX = hitVillage.x + Math.cos(hitVillage.gateAngle) * Math.max(2.0, hitVillage.radius * 0.45);
        const landZ = hitVillage.z + Math.sin(hitVillage.gateAngle) * Math.max(2.0, hitVillage.radius * 0.45);
        requestWorldTeleport(landX, landZ);
        const tNow = getWorldT(deps.commodore.language());
        pushToast(tNow("theWorld.stage.warpVillageToast", { name: hitVillage.label }));
        return;
      }
    }

    if (snap.questBoardOpen) {
      closeQuestBoard();
      return;
    }

    if (snap.interactionMode !== "closed" || snap.selectedDistrictId !== null) {
      closeActorInteraction();
      return;
    }
  }, [deps, pushToast]);

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

  const handleMinimapSelectVillage = useCallback((village: WorldVillageSpec) => {
    const landX = village.x + Math.cos(village.gateAngle) * Math.max(2.0, village.radius * 0.45);
    const landZ = village.z + Math.sin(village.gateAngle) * Math.max(2.0, village.radius * 0.45);
    requestWorldTeleport(landX, landZ);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow("theWorld.stage.warpVillageToast", { name: village.label }));
  }, [deps, pushToast]);

  const handleVillageSignClick = useCallback((village: WorldVillageSpec) => {
    if (suppressVillageClickRef.current) return;
    handleMinimapSelectVillage(village);
  }, [handleMinimapSelectVillage]);

  const handleMinimapSelectPlaza = useCallback(() => {
    requestWorldTeleport(0, 1.5);
    const tNow = getWorldT(deps.commodore.language());
    pushToast(tNow("theWorld.stage.warpPlazaToast"));
  }, [deps, pushToast]);

  const handleMinimapToggleOverview = useCallback(() => {
    const next = !getWorldStoreSnapshot().overviewMode;
    playOverviewToggle(next);
    toggleOverviewMode();
  }, []);

  const handleMinimapClickPoint = useCallback((wx: number, wz: number) => {
    requestWorldTeleport(wx, wz);
  }, []);

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

  const minimapJumpItems = useMemo<readonly WorldMinimapJumpItem[]>(() => {
    const items: WorldMinimapJumpItem[] = [];
    for (const z of snapshot.zones) {
      if (z.kind === "village") continue;
      items.push({
        id: z.id,
        label: z.label,
        x: z.kind === "plaza" ? 0 : z.x,
        z: z.kind === "plaza" ? 1.5 : z.z,
        tone: z.roofTone,
      });
    }
    for (const v of snapshot.villages) {
      const landX = v.x + Math.cos(v.gateAngle) * Math.max(2.0, v.radius * 0.45);
      const landZ = v.z + Math.sin(v.gateAngle) * Math.max(2.0, v.radius * 0.45);
      items.push({
        id: v.id,
        label: v.label,
        x: landX,
        z: landZ,
        tone: v.tone,
        tier: v.overallTier,
      });
    }
    return items;
  }, [snapshot.villages, snapshot.zones]);

  const handleJumpToDistrict = useCallback((item: WorldMinimapJumpItem) => {
    requestWorldTeleport(item.x, item.z);
    const tNow = getWorldT(deps.commodore.language());
    if (item.id === "plaza-main") {
      pushToast(tNow("theWorld.stage.warpPlazaToast"));
    } else {
      pushToast(tNow("theWorld.stage.warpVillageToast", { name: item.label }));
    }
  }, [deps, pushToast]);

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
  }, []);

  const handleInspectFromQuickMenu = useCallback((districtId: string) => {
    playDistrictSelect();
    selectDistrict(districtId);
  }, []);

  const handleOpenGoalsFromQuickMenu = useCallback((commodoreActorId: string) => {
    openActorPanel(commodoreActorId, "goals");
  }, []);

  const handleTestLevelUp = useCallback(() => {
    const tNow = getWorldT(deps.commodore.language());
    const pose = lastMinimapPoseRef.current;
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
    handleMinimapSelectVillage(village);
  }, [handleMinimapSelectVillage]);

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

  const handleCloseAdmiralCustomizer = useCallback(() => {
    closeAdmiralCustomizer();
  }, []);

  const handleChangeAdmiralStyle = useCallback((patch: Partial<WorldAdmiralStyle>) => {
    setAdmiralStyle(patch);
  }, []);

  const handlePreviewAdmiralChange = useCallback(() => {
    runtimeRef.current?.triggerCustomizerPreviewBounce?.();
  }, []);

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
      setOverviewDragLink(null);
      if (isDragging) {
        suppressVillageClickRef.current = true;
        window.requestAnimationFrame(() => {
          suppressVillageClickRef.current = false;
        });
        if (!cancelled && latestTarget && latestTarget.id !== village.id) {
          const tNow = getWorldT(deps.commodore.language());
          runtimeRef.current?.spawnCourierBetweenVillages(village, latestTarget);
          playFlagPlant();
          requestChatMentions(
            [`commodore:${village.commodoreId}`, `commodore:${latestTarget.commodoreId}`],
            tNow("theWorld.overview.dragLinkPrefill", {
              from: village.label,
              to: latestTarget.label,
            }),
          );
          pushToast(
            tNow("theWorld.overview.dragLinkToast", {
              from: village.label,
              to: latestTarget.label,
            }),
          );
        }
      }
    };

    const onUp = () => finish(false);
    const onCancel = () => finish(true);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, [deps, pushToast]);

  const anyModalOpen = store.questBoardOpen || store.warRoomOpen || store.admiralCustomizerOpen || controlsGuideOpen;
  const dialogueOpen = selectedActor !== null && store.interactionMode === "dialogue";
  const panelMode = selectedActor !== null && isPanelMode(store.interactionMode) ? store.interactionMode : null;
  const playerLabelRevealed = playerHovered || store.admiralCustomizerOpen;

  return (
    <div
      ref={rootRef}
      className={`the-world-root${store.lifecycle === "diving" ? " is-diving" : ""}${store.lifecycle === "escaping" ? " is-escaping" : ""}${store.photoMode ? " is-photo-mode" : ""}`}
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
        sittingAtCampfire={store.sittingAtCampfire}
        playerLabelRevealed={playerLabelRevealed}
        villages={snapshot.villages}
        labelMetas={labelMetas}
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
          {store.overviewMode && store.interactionMode === "closed" && !anyModalOpen && !toastMessage && !celebrationToast ? (
            <button
              type="button"
              className="the-world-overview-banner"
              aria-label={t("theWorld.hud.overviewAria")}
              onClick={handleMinimapToggleOverview}
            >
              <WorldIcon name="mapOverview" size={14} tone="amber" />
              <span>{t("theWorld.hud.overviewLabel")} · {t("theWorld.overview.dragLinkHint")} · M / Esc</span>
            </button>
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
            hideBottom={dialogueOpen || panelMode !== null || anyModalOpen || store.sittingAtCampfire || (store.overviewMode && !store.chatActive)}
            urgentQuestCount={questBoardData.totalUrgentCount}
            weatherMode={store.weatherMode}
            onSelectWeather={handleSelectWeather}
            timeMode={store.timeMode}
            onSelectTimeMode={handleSelectTimeMode}
            onCreateCommodore={deps.openCreateCommodore}
            onStatusBanner={pushToast}
            onTestLevelUp={handleTestLevelUp}
            onTestRainbow={handleTestRainbow}
            onOpenWarRoom={handleOpenWarRoom}
            onOpenAdmiralCustomizer={handleOpenAdmiralCustomizer}
            onOpenCustomizer={handleOpenAdmiralCustomizer}
            onTriggerEmote={handleTriggerEmote}
            onToggleControlsGuide={handleToggleControlsGuide}
            debugPanelVisible={debugPanelVisible}
          />
          {snapshot.villages.length === 0 && !store.photoMode && !anyModalOpen && !store.overviewMode && store.interactionMode === "closed" ? (
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
          {!dialogueOpen && panelMode === null && !anyModalOpen && !store.admiralCustomizerOpen ? (
            <WorldMinimap
              ref={minimapRef}
              villages={snapshot.villages}
              zones={snapshot.zones}
              selectedDistrictId={store.selectedDistrictId}
              overviewMode={store.overviewMode}
              locale={locale}
              playerMarkerRef={minimapPlayerRef}
              districtJumpItems={minimapJumpItems}
              onJumpToDistrict={handleJumpToDistrict}
              onSelectVillage={handleMinimapSelectVillage}
              onSelectPlaza={handleMinimapSelectPlaza}
              onToggleOverview={handleMinimapToggleOverview}
              onClickPoint={handleMinimapClickPoint}
            />
          ) : null}
          <WorldControlsGuide
            open={controlsGuideOpen}
            onClose={handleCloseControlsGuide}
            locale={locale}
          />
          {panelMode === null && !anyModalOpen ? (
            <WorldChatLog
              actors={snapshot.actors}
              deps={deps}
              hidden={dialogueOpen || (store.overviewMode && !store.chatActive)}
              onStatusBanner={pushToast}
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
              onClose={handleCloseWarRoom}
              onRallyAll={handleRallyAll}
              onVisitVillage={handleVisitVillageFromWarRoom}
              onBroadcastAll={handleBroadcastAll}
            />
          ) : null}
          {store.admiralCustomizerOpen ? (
            <WorldAdmiralCustomizer
              style={store.admiralStyle}
              locale={locale}
              onChangeStyle={handleChangeAdmiralStyle}
              onPreviewChange={handlePreviewAdmiralChange}
              onClose={handleCloseAdmiralCustomizer}
            />
          ) : null}
          {selectedDistrict && store.interactionMode === "closed" && !anyModalOpen ? (
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
            />
          ) : null}
          {store.districtContextMenu && contextMenuDistrict && !store.photoMode && !anyModalOpen ? (
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
          {store.photoMode ? (
            <button
              type="button"
              className="the-world-photo-exit"
              aria-label={t("theWorld.photoMode.exitAria")}
              onClick={() => {
                playPhotoShutter();
                setPhotoMode(false);
              }}
            >
              <WorldIcon name="camera" size={13} tone="amber" />
              <span>{t("theWorld.photoMode.exitHint")}</span>
            </button>
          ) : null}
          {store.interactionMode === "radial" && selectedActor ? (
            <WorldRadialMenu
              actor={selectedActor}
              anchorLabel={selectedAnchorLabel}
              isNear={store.nearActorId === selectedActor.id}
              deps={deps}
              onStatusBanner={pushToast}
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
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
