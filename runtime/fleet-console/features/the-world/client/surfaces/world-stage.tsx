import { NATIVE_VIEW_COVER_ATTRIBUTE } from "@fleet-console/ui/native-view";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  WORLD_CAMPFIRE_BENCH_POS,
  type WorldActorPanelMode,
  type WorldAdmiralStyle,
  type WorldDevelopmentTier,
  type WorldDistrictSpec,
  type WorldVillageBiome,
  type WorldVillageSpec,
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
  activateChat,
  clearDispatchFlag,
  closeActorInteraction,
  closeAdmiralCustomizer,
  closeDistrictContextMenu,
  closeQuestBoard,
  closeWarRoom,
  deactivateChat,
  exitTheWorld,
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
  toggleOverviewMode,
  togglePhotoMode,
  useWorldStore,
} from "../world-store.js";
import { WorldAdmiralCustomizer } from "./world-admiral-customizer.js";
import { WorldChatLog, WorldSpeechSync } from "./world-chat-log.js";
import { WorldDialogueBox } from "./world-dialogue-box.js";
import { WorldDistrictInspector, type WorldDistrictLinkedObjective } from "./world-district-inspector.js";
import { WorldDistrictQuickMenu } from "./world-district-quick-menu.js";
import { WorldHud } from "./world-hud.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";
import { formatMinimapPlayerTransform, WorldMinimap } from "./world-minimap.js";
import { WorldPanelModal } from "./world-panel-modal.js";
import { WorldQuestBoardModal } from "./world-quest-board.js";
import { WorldRadialMenu } from "./world-radial-menu.js";
import { WorldWarRoom } from "./world-war-room.js";

const TOAST_DURATION_MS = 2_800;
const CELEBRATION_TOAST_DURATION_MS = 3_800;
const HOVER_PICK_THROTTLE_MS = 33;
const POS_DEADZONE_PX = 0.5;

const TIER_NAME_KEYS: Readonly<Record<WorldDevelopmentTier, TheWorldMessageKey>> = {
  0: "theWorld.tier.0.name",
  1: "theWorld.tier.1.name",
  2: "theWorld.tier.2.name",
  3: "theWorld.tier.3.name",
  4: "theWorld.tier.4.name",
  5: "theWorld.tier.5.name",
};

const SPEECH_BADGES: Readonly<Record<string, { readonly icon: WorldIconName; readonly tone: WorldIconTone }>> = {
  wake: { icon: "systemWake", tone: "amber" },
  ask: { icon: "question", tone: "amber" },
  tool: { icon: "tool", tone: "cerulean" },
  warn: { icon: "warning", tone: "warn" },
  chat: { icon: "chat", tone: "teal" },
  quest: { icon: "scroll", tone: "amber" },
  rally: { icon: "rally", tone: "amber" },
  gift: { icon: "crate", tone: "rose" },
  baton: { icon: "baton", tone: "cerulean" },
  party: { icon: "confetti", tone: "amber" },
  greet: { icon: "greet", tone: "rose" },
  cheer: { icon: "cheer", tone: "amber" },
  highfive: { icon: "highfive", tone: "rose" },
};

function parseSpeech(raw: string): { readonly badge: { readonly icon: WorldIconName; readonly tone: WorldIconTone } | null; readonly text: string } {
  const match = /^\[([a-z]+)\]\s*(.*)$/i.exec(raw);
  if (match) {
    const badge = SPEECH_BADGES[match[1]!.toLowerCase()] ?? null;
    if (badge) return { badge, text: match[2]! };
  }
  return { badge: null, text: raw };
}

function isPanelMode(mode: string): mode is WorldActorPanelMode {
  return mode === "goals" || mode === "info" || mode === "settings";
}

interface AppliedAnchorState {
  x: number;
  y: number;
  visible: boolean;
  distant: boolean;
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

  // 구조 상태만 React state에 보관(목록·말풍선·근접·선택 변경 시에만 갱신, 평시 0Hz)
  const [labelMetas, setLabelMetas] = useState<readonly WorldActorLabelMeta[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [celebrationToast, setCelebrationToast] = useState<string | null>(null);
  const [overviewDragLink, setOverviewDragLink] = useState<{
    readonly fromVillage: WorldVillageSpec;
    readonly startX: number;
    readonly startY: number;
    readonly curX: number;
    readonly curY: number;
    readonly targetVillage: WorldVillageSpec | null;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);
  const prevDistrictTiersRef = useRef<Map<string, WorldDevelopmentTier>>(new Map());
  const suppressVillageClickRef = useRef(false);
  const villagesRef = useRef<readonly WorldVillageSpec[]>(snapshot.villages);
  villagesRef.current = snapshot.villages;

  // Direct-DOM `translate3d` 좌표 갱신용 ref 맵 + 0.5px 데드존 캐시 + 안정화된 ref 콜백 풀
  const actorAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const villageAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const playerAnchorRef = useRef<HTMLDivElement | null>(null);
  const districtTooltipRef = useRef<HTMLDivElement | null>(null);
  const noticeBoardAnchorRef = useRef<HTMLDivElement | null>(null);
  const guildHallAnchorRef = useRef<HTMLDivElement | null>(null);
  const campfireBenchAnchorRef = useRef<HTMLDivElement | null>(null);
  const minimapPlayerRef = useRef<SVGGElement | null>(null);
  const lastMinimapPoseRef = useRef({ x: Number.NaN, z: Number.NaN, yaw: Number.NaN });
  const appliedPosCacheRef = useRef<Map<string, AppliedAnchorState>>(new Map());
  const actorRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  const villageRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());

  const getActorAnchorRef = useCallback((actorId: string) => {
    let cb = actorRefCallbacks.current.get(actorId);
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) {
          if (actorAnchorRefs.current.get(actorId) !== el) {
            el.style.visibility = "hidden";
            actorAnchorRefs.current.set(actorId, el);
            appliedPosCacheRef.current.delete(`actor:${actorId}`);
          }
        } else {
          actorAnchorRefs.current.delete(actorId);
          appliedPosCacheRef.current.delete(`actor:${actorId}`);
          actorRefCallbacks.current.delete(actorId);
        }
      };
      actorRefCallbacks.current.set(actorId, cb);
    }
    return cb;
  }, []);

  const getVillageAnchorRef = useCallback((villageId: string) => {
    let cb = villageRefCallbacks.current.get(villageId);
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) {
          if (villageAnchorRefs.current.get(villageId) !== el) {
            el.style.visibility = "hidden";
            villageAnchorRefs.current.set(villageId, el);
            appliedPosCacheRef.current.delete(`village:${villageId}`);
          }
        } else {
          villageAnchorRefs.current.delete(villageId);
          appliedPosCacheRef.current.delete(`village:${villageId}`);
          villageRefCallbacks.current.delete(villageId);
        }
      };
      villageRefCallbacks.current.set(villageId, cb);
    }
    return cb;
  }, []);

  const setPlayerAnchorRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      if (playerAnchorRef.current !== el) {
        el.style.visibility = "hidden";
        playerAnchorRef.current = el;
        appliedPosCacheRef.current.delete("player");
      }
    } else {
      playerAnchorRef.current = null;
      appliedPosCacheRef.current.delete("player");
    }
  }, []);

  const setDistrictTooltipRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      if (districtTooltipRef.current !== el) {
        el.style.visibility = "hidden";
        districtTooltipRef.current = el;
        appliedPosCacheRef.current.delete("district-tooltip");
      }
    } else {
      districtTooltipRef.current = null;
      appliedPosCacheRef.current.delete("district-tooltip");
    }
  }, []);

  const setNoticeBoardAnchorRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      if (noticeBoardAnchorRef.current !== el) {
        el.style.visibility = "hidden";
        noticeBoardAnchorRef.current = el;
        appliedPosCacheRef.current.delete("notice-board");
      }
    } else {
      noticeBoardAnchorRef.current = null;
      appliedPosCacheRef.current.delete("notice-board");
    }
  }, []);

  const setGuildHallAnchorRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      if (guildHallAnchorRef.current !== el) {
        el.style.visibility = "hidden";
        guildHallAnchorRef.current = el;
        appliedPosCacheRef.current.delete("guild-hall");
      }
    } else {
      guildHallAnchorRef.current = null;
      appliedPosCacheRef.current.delete("guild-hall");
    }
  }, []);

  const setCampfireBenchAnchorRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      if (campfireBenchAnchorRef.current !== el) {
        el.style.visibility = "hidden";
        campfireBenchAnchorRef.current = el;
        appliedPosCacheRef.current.delete("campfire-bench");
      }
    } else {
      campfireBenchAnchorRef.current = null;
      appliedPosCacheRef.current.delete("campfire-bench");
    }
  }, []);

  const applyAnchorPosition = useCallback((
    key: string,
    el: HTMLDivElement | null | undefined,
    x: number,
    y: number,
    visible: boolean,
    distant = false,
  ) => {
    if (!el) return;
    const cache = appliedPosCacheRef.current;
    let prev = cache.get(key);
    if (!visible) {
      if (!prev) {
        el.style.visibility = "hidden";
        cache.set(key, { x: Number.NaN, y: Number.NaN, visible: false, distant: false });
      } else if (prev.visible) {
        el.style.visibility = "hidden";
        prev.visible = false;
      }
      return;
    }

    if (!prev) {
      prev = { x: Number.NaN, y: Number.NaN, visible: false, distant: false };
      cache.set(key, prev);
    }

    if (!prev.visible) {
      el.style.visibility = "visible";
      prev.visible = true;
    }

    if (
      Number.isNaN(prev.x)
      || Math.abs(x - prev.x) >= POS_DEADZONE_PX
      || Math.abs(y - prev.y) >= POS_DEADZONE_PX
    ) {
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      prev.x = x;
      prev.y = y;
    }

    if (prev.distant !== distant || el.classList.contains("is-distant") !== distant) {
      el.classList.toggle("is-distant", distant);
      prev.distant = distant;
    }
  }, []);

  const handleFramePositions = useCallback((positions: WorldFrameOverlayPositions) => {
    const actorMap = actorAnchorRefs.current;
    for (let i = 0; i < positions.actorCount; i += 1) {
      const p = positions.actors[i]!;
      applyAnchorPosition(`actor:${p.actorId}`, actorMap.get(p.actorId), p.x, p.y, p.visible, p.isDistant);
    }

    applyAnchorPosition(
      "player",
      playerAnchorRef.current,
      positions.player.x,
      positions.player.y,
      positions.player.visible,
    );

    const villageMap = villageAnchorRefs.current;
    for (let i = 0; i < positions.villageCount; i += 1) {
      const v = positions.villages[i]!;
      applyAnchorPosition(`village:${v.villageId}`, villageMap.get(v.villageId), v.x, v.y, v.visible);
    }

    applyAnchorPosition(
      "district-tooltip",
      districtTooltipRef.current,
      positions.hoveredDistrict.x,
      positions.hoveredDistrict.y,
      positions.hoveredDistrict.visible,
    );

    applyAnchorPosition(
      "notice-board",
      noticeBoardAnchorRef.current,
      positions.noticeBoard.x,
      positions.noticeBoard.y,
      positions.noticeBoard.visible,
    );

    applyAnchorPosition(
      "guild-hall",
      guildHallAnchorRef.current,
      positions.guildHall.x,
      positions.guildHall.y,
      positions.guildHall.visible,
    );

    applyAnchorPosition(
      "campfire-bench",
      campfireBenchAnchorRef.current,
      positions.campfireBench.x,
      positions.campfireBench.y,
      positions.campfireBench.visible,
    );

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
  }, [applyAnchorPosition]);

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

  // 월드에 표시되는 모든 사령관 기록과 활성 Objective 타임라인을 미리 구독해
  // 좌측 하단 MMORPG 채팅창·3D 말풍선·인월드 대화창이 실시간으로 흐르게 한다.
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

  // RTS 하늘 조망 모드 3D 카메라 동기화
  useEffect(() => {
    runtimeRef.current?.setOverviewMode(store.overviewMode);
  }, [store.overviewMode]);

  // 날씨 모드 (`clear` / `sakura` / `rain` / `snow`) + 빗소리 앰비언스 동기화
  useEffect(() => {
    runtimeRef.current?.setWeather(store.weatherMode);
  }, [store.weatherMode]);

  // 제독 몽글이 색상·모자 커스터마이징 실시간 동기화
  useEffect(() => {
    runtimeRef.current?.setAdmiralStyle(store.admiralStyle.tone, store.admiralStyle.hat);
  }, [store.admiralStyle]);

  // 모닥불 벤치 불멍 상태 동기화
  useEffect(() => {
    runtimeRef.current?.setCampfireSit(store.sittingAtCampfire);
  }, [store.sittingAtCampfire]);

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

  // 실시간 Theater 구역 Tier 레벨업 감지기 (초기 메트릭 로딩은 제외하고 실제 상승 시에만 축포)
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

  // 선택·호버 하이라이트 링 3D 동기화
  useEffect(() => {
    runtimeRef.current?.setDistrictHighlight(hoveredDistrict, selectedDistrict);
  }, [hoveredDistrict, selectedDistrict]);

  // 구역 선택 시에만 카메라 포커스 이동 (메트릭 새로고침 등 동일 ID 갱신 시 카메라 유지)
  const focusedDistrictIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextId = selectedDistrict?.id ?? null;
    if (nextId === focusedDistrictIdRef.current) return;
    focusedDistrictIdRef.current = nextId;
    runtimeRef.current?.focusDistrict(selectedDistrict);
  }, [selectedDistrict]);

  // 선택된 구역이 스냅샷에서 사라지면 선택 해제
  useEffect(() => {
    if (store.selectedDistrictId && !selectedDistrict) {
      selectDistrict(null);
    }
  }, [selectedDistrict, store.selectedDistrictId]);

  // 협동 연출 명령 전달
  useEffect(() => {
    if (!store.choreography) return;
    const ran = runtimeRef.current?.runChoreography(store.choreography);
    if (ran === false) {
      pushToast("이 연출을 재생하려면 진행 중인 Objective 캠프 또는 구성원이 필요합니다.");
    }
  }, [pushToast, store.choreography]);

  // 심즈 스타일 감정표현/인사 이모트 전달
  const lastEmoteNonceRef = useRef(0);
  useEffect(() => {
    const cmd = store.emoteCommand;
    if (!cmd || cmd.nonce === lastEmoteNonceRef.current) return;
    lastEmoteNonceRef.current = cmd.nonce;
    playMongleChirp(cmd.emote === "cheer" ? 3 : cmd.emote === "highfive" ? 5 : 0);
    runtimeRef.current?.playEmote(cmd.actorId, cmd.emote);
  }, [store.emoteCommand]);

  // 대상에게 다가가기 요청 전달
  const lastApproachNonceRef = useRef(0);
  useEffect(() => {
    const req = store.approachRequest;
    if (!req || req.nonce === lastApproachNonceRef.current) return;
    lastApproachNonceRef.current = req.nonce;
    runtimeRef.current?.approachActor(req.actorId);
  }, [store.approachRequest]);

  // 텔레포트 요청 전달
  const lastTeleportNonceRef = useRef(0);
  useEffect(() => {
    const req = store.teleportRequest;
    if (!req || req.nonce === lastTeleportNonceRef.current) return;
    lastTeleportNonceRef.current = req.nonce;
    playWarp();
    runtimeRef.current?.teleport(req.x, req.z);
  }, [store.teleportRequest]);

  // 로컬 말풍선 전달
  const appliedSpeechesRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const [actorId, entry] of Object.entries(store.localSpeeches)) {
      if (appliedSpeechesRef.current[actorId] === entry.nonce) continue;
      appliedSpeechesRef.current[actorId] = entry.nonce;
      runtimeRef.current?.pushSpeech(actorId, entry.text);
    }
  }, [store.localSpeeches]);

  // 선택 대상이 스냅샷에서 사라지면 상호작용 상태를 정리한다.
  useEffect(() => {
    if (store.selectedActorId && !snapshot.actors.some((a) => a.id === store.selectedActorId)) {
      closeActorInteraction();
    }
  }, [snapshot.actors, store.selectedActorId]);

  // 더 월드 진입 시 배경 콘솔(예: 사이드바 포털 버튼)에 남은 포커스를 해제해 즉시 `Enter` 채팅이 동작하도록 한다.
  useEffect(() => {
    if (store.lifecycle !== "open" && store.lifecycle !== "diving") return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !rootRef.current?.contains(active)) {
      active.blur();
    }
  }, [store.lifecycle]);

  // 키보드 Enter(채팅 활성화) · E(방사형 메뉴) · M(RTS 하늘 조망 토글) · P(포토 모드) · Escape(우선순위 닫기 → 월드 탈출)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target.isContentEditable) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.target.blur();
            const current = getWorldStoreSnapshot();
            if (current.chatActive) {
              deactivateChat();
            } else if (current.warRoomOpen) {
              closeWarRoom();
            } else if (current.admiralCustomizerOpen) {
              closeAdmiralCustomizer();
            } else if (current.questBoardOpen) {
              closeQuestBoard();
            } else if (current.interactionMode !== "closed" || current.selectedDistrictId !== null) {
              closeActorInteraction();
            }
          }
          return;
        }
      }
      const snap = getWorldStoreSnapshot();
      if (snap.lifecycle !== "open") return;
      const anyModalOpen = snap.questBoardOpen || snap.warRoomOpen || snap.admiralCustomizerOpen;

      if (
        event.code === "KeyP"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive) {
          event.preventDefault();
          playPhotoShutter();
          togglePhotoMode();
          return;
        }
      }

      if (
        event.key === "Enter"
        && !event.isComposing
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        const targetEl = event.target instanceof HTMLElement ? event.target : null;
        const isWorldInteractive =
          targetEl !== null
          && Boolean(targetEl.closest(".the-world-root"))
          && (targetEl.tagName === "BUTTON" || targetEl.tagName === "A");
        if (!isWorldInteractive && !snap.photoMode && snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive) {
          event.preventDefault();
          activateChat();
          return;
        }
      }

      if (event.code === "KeyM" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (snap.interactionMode === "closed" && !anyModalOpen) {
          event.preventDefault();
          playOverviewToggle(!snap.overviewMode);
          toggleOverviewMode();
          return;
        }
      }

      if (event.code === "KeyF" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode) {
          if (snap.sittingAtCampfire) {
            event.preventDefault();
            setSittingAtCampfire(false);
            return;
          }
          const pose = lastMinimapPoseRef.current;
          const px = Number.isNaN(pose.x) ? 0.4 : pose.x;
          const pz = Number.isNaN(pose.z) ? 2.2 : pose.z;
          if (Math.hypot(px - WORLD_CAMPFIRE_BENCH_POS.x, pz - WORLD_CAMPFIRE_BENCH_POS.z) <= 10.5) {
            event.preventDefault();
            playDistrictSelect();
            setSittingAtCampfire(true);
            return;
          }
        }
      }

      if (
        (event.code === "Digit1" || event.code === "Digit2" || event.code === "Digit3")
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
      ) {
        if (snap.interactionMode === "closed" && !anyModalOpen && !snap.chatActive && !snap.photoMode && !snap.overviewMode) {
          event.preventDefault();
          const emote = event.code === "Digit1" ? "wave" : event.code === "Digit2" ? "cheer" : "jump";
          requestPlayerEmote(emote);
          return;
        }
      }

      if (event.code === "KeyE" && !anyModalOpen && !snap.photoMode) {
        if (snap.interactionMode === "radial") {
          event.preventDefault();
          closeActorInteraction();
          return;
        }
        if (snap.interactionMode === "closed" && snap.nearActorId) {
          event.preventDefault();
          playMongleChirp();
          openActorRadialMenu(snap.nearActorId);
          return;
        }
      }

      if (event.key === "Escape") {
        // 더 월드 바깥의 콘솔 전역 모달(승인 목록·폴더 선택·새 사령관 모달 등)이 열려 있을 때만 양보한다.
        const hasExternalModal = Array.from(document.querySelectorAll('[aria-modal="true"]:not([hidden])'))
          .some((el) => !rootRef.current?.contains(el));
        if (hasExternalModal) return;
        event.preventDefault();
        if (snap.photoMode) {
          playPhotoShutter();
          setPhotoMode(false);
          return;
        }
        if (snap.sittingAtCampfire) {
          setSittingAtCampfire(false);
          return;
        }
        if (snap.districtContextMenu) {
          closeDistrictContextMenu();
          return;
        }
        if (snap.warRoomOpen) {
          closeWarRoom();
          return;
        }
        if (snap.admiralCustomizerOpen) {
          closeAdmiralCustomizer();
          return;
        }
        if (snap.questBoardOpen) {
          closeQuestBoard();
          return;
        }
        if (snap.chatActive) {
          deactivateChat();
          return;
        }
        if (snap.interactionMode !== "closed" || snap.selectedDistrictId !== null) {
          closeActorInteraction();
          return;
        }
        if (snap.overviewMode) {
          playOverviewToggle(false);
          setOverviewMode(false);
          return;
        }
        exitTheWorld({ reducedMotion: deps.isReducedMotion() });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deps]);

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
    if (snap.lifecycle !== "open" || snap.questBoardOpen || snap.warRoomOpen || snap.admiralCustomizerOpen || snap.photoMode) return;
    const hitDistrict = runtimeRef.current?.pickDistrictAt(event.clientX, event.clientY) ?? null;
    if (hitDistrict) {
      playDistrictSelect();
      openDistrictContextMenu(hitDistrict.id, event.clientX, event.clientY);
    } else if (snap.districtContextMenu) {
      closeDistrictContextMenu();
    }
  }, []);

  // 캔버스 클릭 & 구역 호버 피킹 (드래그 회전과 구분)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverPickRef = useRef(0);

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerDownRef.current !== null) return;
    const snap = getWorldStoreSnapshot();
    if (snap.lifecycle !== "open" || snap.interactionMode !== "closed" || snap.questBoardOpen || snap.warRoomOpen || snap.admiralCustomizerOpen) {
      if (snap.hoveredDistrictId !== null) setHoveredDistrict(null);
      return;
    }
    const now = performance.now();
    if (now - lastHoverPickRef.current < HOVER_PICK_THROTTLE_MS) return;
    lastHoverPickRef.current = now;
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
  }, []);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = pointerDownRef.current;
    pointerDownRef.current = null;
    const snap = getWorldStoreSnapshot();
    if (!start || snap.lifecycle !== "open") return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;

    // 3D 캔버스 클릭 시 활성화된 채팅창을 앰비언트 상태로 부드럽게 수축한다.
    if (snap.chatActive) {
      deactivateChat();
    }

    // 클릭 우선순위: 1. 캐릭터 → 2. 3D 퀘스트 게시판 → 3. 모닥불 벤치 → 4. 길드 회관(상황실) → 5. Theater 구역 → 6. (하늘 조망 중) 사령관 마을 → 7. 빈 땅 해제
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
        pushToast(`${hitVillage.label} 마을로 이동했습니다.`);
        return;
      }
    }

    if (snap.questBoardOpen) {
      closeQuestBoard();
      return;
    }

    if (snap.interactionMode !== "closed" || snap.selectedDistrictId !== null) {
      closeActorInteraction();
    }
  }, [pushToast]);

  // 제독 퀘스트 게시판 모달 콜백
  const handleCloseQuestBoard = useCallback(() => {
    closeQuestBoard();
  }, []);

  const handleVisitQuestCommodore = useCallback((actorId: string) => {
    closeQuestBoard();
    requestApproachActor(actorId);
  }, []);

  // 전략 미니맵 콜백 (React.memo 안정성 유지)
  const handleMinimapSelectVillage = useCallback((village: WorldVillageSpec) => {
    const landX = village.x + Math.cos(village.gateAngle) * Math.max(2.0, village.radius * 0.45);
    const landZ = village.z + Math.sin(village.gateAngle) * Math.max(2.0, village.radius * 0.45);
    requestWorldTeleport(landX, landZ);
    pushToast(`${village.label} 마을로 이동했습니다.`);
  }, [pushToast]);

  const handleMinimapSelectPlaza = useCallback(() => {
    requestWorldTeleport(0, 1.5);
    pushToast("중앙 길드 광장으로 이동했습니다.");
  }, [pushToast]);

  const handleMinimapToggleOverview = useCallback(() => {
    const next = !getWorldStoreSnapshot().overviewMode;
    playOverviewToggle(next);
    toggleOverviewMode();
  }, []);

  const handleMinimapClickPoint = useCallback((wx: number, wz: number) => {
    requestWorldTeleport(wx, wz);
  }, []);

  // SimCity Inspector 콜백 (React.memo 안정성 유지)
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
    pushToast(`${label} 구역으로 이동했습니다.`);
  }, [pushToast]);

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

  const selectedActor = useMemo(
    () => (store.selectedActorId ? snapshot.actors.find((a) => a.id === store.selectedActorId) ?? null : null),
    [snapshot.actors, store.selectedActorId],
  );
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

  // 우클릭 퀵메뉴 & Inspector 작전 깃발 · 바이옴 · 레벨업 테스트 콜백
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
    clearDispatchFlag(districtId);
  }, []);

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
        // 플레이어가 광장 등 멀리 있는 상태에서 테스트해도 시야 정면에서 황금 축포를 즉시 확인
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

  // 함대 상황실 · 제독 꾸미기 · 무지개 · 구역 메모 · 하늘 조망 마을→마을 드래그 합동 연락 콜백
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
        pushActorSpeech(actor.id, `[chat] "${trimmed.slice(0, 22)}" 접수!`);
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

  const handleTestRainbow = useCallback(() => {
    const tNow = getWorldT(deps.commodore.language());
    runtimeRef.current?.triggerRainbow(18);
    playLevelUpFanfare();
    pushCelebrationToast(tNow("theWorld.rainbow.toast"));
  }, [deps, pushCelebrationToast]);

  const handleChangeDistrictNote = useCallback((districtId: string, note: string) => {
    setDistrictNote(districtId, note);
    if (note.trim().length > 0) {
      const tNow = getWorldT(deps.commodore.language());
      const districtName = findDistrictInVillages(villagesRef.current, districtId)?.district.label ?? "";
      pushToast(tNow("theWorld.district.noteSavedToast", { name: districtName }));
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

  const anyModalOpen = store.questBoardOpen || store.warRoomOpen || store.admiralCustomizerOpen;
  const dialogueOpen = selectedActor !== null && store.interactionMode === "dialogue";
  const panelMode = selectedActor !== null && isPanelMode(store.interactionMode) ? store.interactionMode : null;
  const showPlayerLabel = store.lifecycle === "open" && store.cameraMode === "follow" && store.interactionMode === "closed" && !anyModalOpen;
  const showDistrictTooltip =
    store.lifecycle === "open"
    && !store.photoMode
    && !anyModalOpen
    && store.interactionMode === "closed"
    && hoveredDistrict !== null
    && hoveredDistrict.id !== store.selectedDistrictId;

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

      <div className="the-world-labels">
        {showPlayerLabel ? (
          <div
            ref={setPlayerAnchorRef}
            className="the-world-actor-anchor the-world-player-anchor"
          >
            <button
              type="button"
              className="the-world-nametag is-player"
              aria-label={t("theWorld.hud.admiralStyleAria")}
              onClick={handleOpenAdmiralCustomizer}
            >
              <span>나 (제독)</span>
            </button>
          </div>
        ) : null}

        {store.lifecycle === "open" && store.interactionMode === "closed" && !anyModalOpen
          ? snapshot.villages.map((village) => (
            <div
              key={village.id}
              ref={getVillageAnchorRef(village.id)}
              className="the-world-actor-anchor"
            >
              <button
                type="button"
                className={`the-world-village-sign${overviewDragLink?.targetVillage?.id === village.id ? " is-drag-target" : ""}`}
                data-village-id={village.id}
                aria-label={t("theWorld.village.warpAria", { name: village.label })}
                onPointerDown={(e) => handleVillageSignPointerDown(village, e)}
                onClick={() => {
                  if (suppressVillageClickRef.current) return;
                  handleMinimapSelectVillage(village);
                }}
              >
                <span className="the-world-tone-dot" data-tone={village.tone} />
                <span>{village.label}</span>
                <span className="the-world-village-sign-tier">
                  {village.districts.length > 0
                    ? t("theWorld.village.signSubtitle", {
                      tier: village.overallTier,
                      count: village.districts.length,
                    })
                    : t("theWorld.village.emptyDistricts")}
                </span>
              </button>
            </div>
          ))
          : null}

        {store.lifecycle === "open" && store.interactionMode === "closed" && !anyModalOpen ? (
          <div
            ref={setGuildHallAnchorRef}
            className="the-world-actor-anchor"
          >
            <button
              type="button"
              className="the-world-guild-sign"
              aria-label={t("theWorld.guildHall.signAria")}
              onClick={handleOpenWarRoom}
            >
              <WorldIcon name="warRoom" size={13} tone="amber" />
              <span>{t("theWorld.guildHall.signLabel")}</span>
            </button>
          </div>
        ) : null}

        {store.lifecycle === "open" && store.interactionMode === "closed" && !anyModalOpen && !store.sittingAtCampfire ? (
          <div
            ref={setCampfireBenchAnchorRef}
            className="the-world-actor-anchor"
          >
            <button
              type="button"
              className="the-world-campfire-sign"
              aria-label={t("theWorld.campfire.sitAria")}
              onClick={() => {
                playDistrictSelect();
                setSittingAtCampfire(true);
              }}
            >
              <WorldIcon name="fire" size={13} tone="amber" />
              <span className="the-world-keycap">F</span>
              <span>{t("theWorld.campfire.sitHint")}</span>
            </button>
          </div>
        ) : null}

        {store.lifecycle === "open" && store.interactionMode === "closed" && !anyModalOpen ? (
          <div
            ref={setNoticeBoardAnchorRef}
            className="the-world-actor-anchor"
          >
            <button
              type="button"
              className={`the-world-notice-sign${questBoardData.totalUrgentCount > 0 ? " is-urgent" : ""}`}
              aria-label={t("theWorld.noticeBoard.aria")}
              onClick={() => {
                playDistrictSelect();
                openQuestBoard();
              }}
            >
              <WorldIcon
                name={questBoardData.totalUrgentCount > 0 ? "bell" : "questBoard"}
                size={13}
                tone={questBoardData.totalUrgentCount > 0 ? "amber" : "cerulean"}
              />
              <span>{t("theWorld.noticeBoard.label")}</span>
              {questBoardData.totalUrgentCount > 0 ? (
                <span className="the-world-notice-sign-badge">
                  {t("theWorld.noticeBoard.urgentBadge", { count: questBoardData.totalUrgentCount })}
                </span>
              ) : null}
            </button>
          </div>
        ) : null}

        {showDistrictTooltip && hoveredDistrict ? (
          <div
            ref={setDistrictTooltipRef}
            className="the-world-district-tooltip"
            aria-hidden="true"
          >
            <span className="the-world-tone-dot" data-tone={hoveredDistrict.tone} />
            <span>{hoveredDistrict.label}</span>
            <span className="the-world-district-tooltip-tier">
              {t("theWorld.tier.badge", { tier: hoveredDistrict.tier })}
            </span>
          </div>
        ) : null}

        {labelMetas.map((lbl) => {
          const hideForRadial = store.interactionMode === "radial" && lbl.isSelected;
          const isBackground = store.interactionMode === "radial" && !lbl.isSelected;
          if (hideForRadial) return null;
          return (
            <div
              key={lbl.actorId}
              ref={getActorAnchorRef(lbl.actorId)}
              className={`the-world-actor-anchor${isBackground ? " is-background" : ""}`}
            >
              {lbl.speech ? (() => {
                const parsed = parseSpeech(lbl.speech);
                return (
                  <span className="the-world-speech">
                    {parsed.badge ? <WorldIcon name={parsed.badge.icon} size={13} tone={parsed.badge.tone} /> : null}
                    <span>{parsed.text}</span>
                  </span>
                );
              })() : null}
              {lbl.isNearPlayer && store.interactionMode === "closed" ? (
                <button
                  type="button"
                  className="the-world-interact-prompt"
                  aria-label={t("theWorld.actor.interactAria", { name: lbl.name })}
                  onClick={() => openActorRadialMenu(lbl.actorId)}
                >
                  <span className="the-world-keycap">E</span>
                  <span>상호작용</span>
                </button>
              ) : null}
              <button
                type="button"
                className={`the-world-nametag${lbl.isSelected ? " is-selected" : ""}`}
                aria-label={t("theWorld.actor.interactAria", { name: lbl.name })}
                onClick={() => openActorRadialMenu(lbl.actorId)}
              >
                <span className="the-world-tone-dot" data-tone={lbl.tone} />
                <WorldIcon
                  name={lbl.quaker ? "quaker" : lbl.role === "commodore" ? "commodore" : lbl.role === "commander" ? "commander" : "member"}
                  size={12}
                  tone={lbl.quaker ? "moss" : lbl.role === "commodore" ? "amber" : lbl.role === "commander" ? "cerulean" : "inherit"}
                />
                <span>{lbl.name}</span>
              </button>
            </div>
          );
        })}
      </div>

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
            hideBottom={dialogueOpen || panelMode !== null || anyModalOpen || store.sittingAtCampfire}
            urgentQuestCount={questBoardData.totalUrgentCount}
            onCreateCommodore={deps.openCreateCommodore}
            onStatusBanner={pushToast}
            onTestLevelUp={handleTestLevelUp}
            onTestRainbow={handleTestRainbow}
            onOpenWarRoom={handleOpenWarRoom}
            onOpenAdmiralCustomizer={handleOpenAdmiralCustomizer}
          />
          {!dialogueOpen && panelMode === null && !anyModalOpen ? (
            <WorldMinimap
              villages={snapshot.villages}
              zones={snapshot.zones}
              selectedDistrictId={store.selectedDistrictId}
              overviewMode={store.overviewMode}
              locale={locale}
              playerMarkerRef={minimapPlayerRef}
              onSelectVillage={handleMinimapSelectVillage}
              onSelectPlaza={handleMinimapSelectPlaza}
              onToggleOverview={handleMinimapToggleOverview}
              onClickPoint={handleMinimapClickPoint}
            />
          ) : null}
          {panelMode === null && !anyModalOpen ? (
            <WorldChatLog
              actors={snapshot.actors}
              deps={deps}
              hidden={dialogueOpen}
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
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
