import type { ConsoleLocale } from "@fleet-console/i18n";
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";

import type {
  WorldCameraMode,
  WorldDistrictSpec,
  WorldInteractionMode,
  WorldLifecycleState,
  WorldVillageSpec,
} from "../../shared/world-types.js";
import type {
  WorldActorLabelMeta,
  WorldFrameOverlayPositions,
} from "../engine/world-runtime.js";
import { formatActorInteractAria, getWorldT } from "../i18n/index.js";
import { resolvePlayerCurrentZone } from "../world-projection.js";
import { setCurrentZone } from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

/**
 * Direct-DOM 3D 투영 라벨 오버레이 (`translate3d` 0Hz 갱신 + 거리 LOD `opacity`/`scale`).
 *
 * - 캐릭터 이름표·말풍선·상호작용 힌트, 사령관 마을 푯말, 길드 회관/모닥불/퀘스트 게시판 표식,
 *   구역 호버 툴팁을 렌더링한다.
 * - 원거리 말풍선(≥32m) 숨김, 원거리 마을 배지(≥55m) 페이드/축소, 화면 가장자리 안전 여백,
 *   상단 HUD 침범 방지 페이드, 2D 바운딩 겹침 회피(근거리 우선)를 0-GC로 수행한다.
 */

const POS_DEADZONE_PX = 0.5;
const LOD_EPSILON = 0.02;
const COLLIDE_X_THRESHOLD_PX = 122;
const COLLIDE_Y_THRESHOLD_PX = 28;
const SPEECH_EXTRA_HEIGHT_PX = 46;
const SPEECH_BOX_WIDTH_PX = 210;
const VILLAGE_BOX_WIDTH_PX = 168;
const COLLIDE_MAX_SHIFT_PX = 30;
const COLLIDE_SPEECH_MAX_SHIFT_PX = 72;
const COLLIDE_FAR_DISTANCE_M = 18;
const COLLIDE_FADED_OPACITY = 0.24;
const SPEECH_HIDE_DISTANCE_M = 32;
const VILLAGE_FADE_START_M = 36;
const VILLAGE_FADE_END_M = 55;
const VILLAGE_HIDE_DISTANCE_M = 80;
const EDGE_SAFE_PADDING_PX = 14;
const TOP_HUD_CLEARANCE_PX = 68;
const TOP_HUD_HARD_HIDE_PX = 36;
const TOP_HUD_RIGHT_WIDTH_PX = 560;
const TOP_HUD_LEFT_WIDTH_PX = 260;

interface DeclutterSlot {
  key: string;
  el: HTMLDivElement | null | undefined;
  x: number;
  y: number;
  baseY: number;
  boxWidth: number;
  boxHeight: number;
  maxShift: number;
  priority: number;
  distance: number;
  distant: boolean;
  hideSpeech: boolean;
  opacity: number;
  scale: number;
  speechOffsetY: number;
}

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

function parseSpeech(raw: string): {
  readonly badge: { readonly icon: WorldIconName; readonly tone: WorldIconTone } | null;
  readonly text: string;
} {
  const match = /^\[([a-z]+)\]\s*(.*)$/i.exec(raw);
  if (match) {
    const badge = SPEECH_BADGES[match[1]!.toLowerCase()] ?? null;
    if (badge) return { badge, text: match[2]! };
  }
  return { badge: null, text: raw };
}

interface AppliedAnchorState {
  x: number;
  y: number;
  visible: boolean;
  distant: boolean;
  hideSpeech: boolean;
  opacity: number;
  scale: number;
  speechOffsetY: number;
}

export type WorldActiveInteractTarget =
  | "mailbox"
  | "paradeBell"
  | "actor"
  | "campfire"
  | "fishing"
  | null;

export interface WorldLabelsOverlayHandle {
  applyFramePositions(positions: WorldFrameOverlayPositions): void;
  getLastPlayerScreenPoint(): { readonly x: number; readonly y: number; readonly visible: boolean };
}

export interface WorldLabelsOverlayProps {
  readonly lifecycle: WorldLifecycleState;
  readonly cameraMode: WorldCameraMode;
  readonly interactionMode: WorldInteractionMode;
  readonly anyModalOpen: boolean;
  readonly photoMode: boolean;
  readonly cinemaMode?: boolean | undefined;
  readonly sittingAtCampfire: boolean;
  readonly playerLabelRevealed: boolean;
  readonly villages: readonly WorldVillageSpec[];
  readonly labelMetas: readonly WorldActorLabelMeta[];
  readonly hoveredDistrict: WorldDistrictSpec | null;
  readonly selectedDistrictId: string | null;
  readonly dragTargetVillageId: string | null;
  readonly totalUrgentCount: number;
  readonly locale: ConsoleLocale | undefined;
  readonly onOpenAdmiralCustomizer: () => void;
  readonly onVillageSignPointerDown: (
    village: WorldVillageSpec,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => void;
  readonly onVillageSignClick: (village: WorldVillageSpec) => void;
  readonly onOpenWarRoom: () => void;
  readonly onSitAtCampfire: () => void;
  readonly onOpenQuestBoard: () => void;
  readonly onInteractActor: (actorId: string) => void;
  readonly onOpenUrgentActor?: ((actorId: string) => void) | undefined;
  /** 낚시 중 등 액터 `[E] 상호작용` 배지 노출을 일시 억제할 때 `true`. */
  readonly suppressInteractPrompts?: boolean | undefined;
  /** 현재 `E` 키 입력 시 실행될 단일 최우선 대상 (중복 `[E]` 프롬프트 방지). */
  readonly activeInteractTarget?: WorldActiveInteractTarget | undefined;
  /** 제독 외형 꾸미기 등 클로즈업 화면에서 모든 3D 오버레이 이름표·푯말을 전면 숨길 때 `true`. */
  readonly suppressAllLabels?: boolean | undefined;
}

export const WorldLabelsOverlay = memo(
  forwardRef<WorldLabelsOverlayHandle, WorldLabelsOverlayProps>(function WorldLabelsOverlay(
    {
      lifecycle,
      cameraMode,
      interactionMode,
      anyModalOpen,
      photoMode,
      cinemaMode = false,
      sittingAtCampfire,
      playerLabelRevealed,
      villages,
      labelMetas,
      hoveredDistrict,
      selectedDistrictId,
      dragTargetVillageId,
      totalUrgentCount,
      locale,
      onOpenAdmiralCustomizer,
      onVillageSignPointerDown,
      onVillageSignClick,
      onOpenWarRoom,
      onSitAtCampfire,
      onOpenQuestBoard,
      onInteractActor,
      onOpenUrgentActor,
      suppressInteractPrompts = false,
      activeInteractTarget,
      suppressAllLabels = false,
    },
    ref,
  ) {
    const t = getWorldT(locale);
    const villagesRef = useRef(villages);
    villagesRef.current = villages;
    const plazaLabelRef = useRef("");
    plazaLabelRef.current = t("theWorld.projection.plazaLabel");
    const meadowLabelRef = useRef("");
    meadowLabelRef.current = t("theWorld.hud.zoneMeadow");
    const lastZoneIdRef = useRef<string>("");

    const actorAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const villageAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const playerAnchorRef = useRef<HTMLDivElement | null>(null);
    const districtTooltipRef = useRef<HTMLDivElement | null>(null);
    const noticeBoardAnchorRef = useRef<HTMLDivElement | null>(null);
    const guildHallAnchorRef = useRef<HTMLDivElement | null>(null);
    const campfireBenchAnchorRef = useRef<HTMLDivElement | null>(null);
    const appliedPosCacheRef = useRef<Map<string, AppliedAnchorState>>(new Map());
    const actorRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
    const villageRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
    const lastPlayerScreenRef = useRef<{ x: number; y: number; visible: boolean }>({
      x: Number.NaN,
      y: Number.NaN,
      visible: false,
    });
    const declutterPoolRef = useRef<DeclutterSlot[]>([]);
    const lastActorDistanceRef = useRef<Map<string, number>>(new Map());
    const priorityActorIdsRef = useRef<Set<string>>(new Set());
    const speechActorIdsRef = useRef<Set<string>>(new Set());

    // Keep priority & active-speech actor lookups fresh for 0-GC frame decluttering without adding hook deps.
    priorityActorIdsRef.current.clear();
    speechActorIdsRef.current.clear();
    for (let i = 0; i < labelMetas.length; i += 1) {
      const m = labelMetas[i]!;
      if (m.isSelected || m.isNearPlayer || m.needsAttention) {
        priorityActorIdsRef.current.add(m.actorId);
      }
      if (m.speech && m.speech.length > 0) {
        speechActorIdsRef.current.add(m.actorId);
      }
    }

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
      opacity = 1,
      scale = 1,
      speechOffsetY = 0,
      hideSpeech = false,
    ) => {
      if (!el) return;
      const cache = appliedPosCacheRef.current;
      let prev = cache.get(key);
      if (!visible || opacity <= 0.03) {
        if (!prev) {
          el.style.visibility = "hidden";
          cache.set(key, {
            x: Number.NaN,
            y: Number.NaN,
            visible: false,
            distant: false,
            hideSpeech: false,
            opacity: 1,
            scale: 1,
            speechOffsetY: 0,
          });
        } else if (prev.visible) {
          el.style.visibility = "hidden";
          prev.visible = false;
        }
        return;
      }

      if (!prev) {
        prev = {
          x: Number.NaN,
          y: Number.NaN,
          visible: false,
          distant: false,
          hideSpeech: false,
          opacity: 1,
          scale: 1,
          speechOffsetY: 0,
        };
        cache.set(key, prev);
      }

      if (!prev.visible) {
        el.style.visibility = "visible";
        prev.visible = true;
      }

      const posChanged =
        Number.isNaN(prev.x)
        || Math.abs(x - prev.x) >= POS_DEADZONE_PX
        || Math.abs(y - prev.y) >= POS_DEADZONE_PX;
      const scaleChanged = Math.abs(scale - prev.scale) >= LOD_EPSILON;

      if (posChanged || scaleChanged) {
        el.style.transform = Math.abs(scale - 1) >= LOD_EPSILON
          ? `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`
          : `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
        prev.x = x;
        prev.y = y;
        prev.scale = scale;
      }

      if (Math.abs(opacity - prev.opacity) >= LOD_EPSILON) {
        el.style.opacity = opacity >= 0.99 ? "" : opacity.toFixed(2);
        prev.opacity = opacity;
      }

      if (prev.speechOffsetY !== speechOffsetY) {
        const speechEl = el.querySelector<HTMLElement>(".the-world-speech");
        if (speechEl) {
          speechEl.style.transform = speechOffsetY !== 0 ? `translateY(${speechOffsetY}px)` : "";
        }
        prev.speechOffsetY = speechOffsetY;
      }

      if (prev.distant !== distant || el.classList.contains("is-distant") !== distant) {
        el.classList.toggle("is-distant", distant);
        prev.distant = distant;
      }

      if (prev.hideSpeech !== hideSpeech || el.classList.contains("is-speech-hidden") !== hideSpeech) {
        el.classList.toggle("is-speech-hidden", hideSpeech);
        prev.hideSpeech = hideSpeech;
      }
    }, []);

    useImperativeHandle(ref, () => ({
      applyFramePositions(positions: WorldFrameOverlayPositions) {
        const pool = declutterPoolRef.current;
        const distMap = lastActorDistanceRef.current;
        const priorityActors = priorityActorIdsRef.current;
        const speechActors = speechActorIdsRef.current;
        const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
        const vh = typeof window !== "undefined" ? window.innerHeight : 800;
        let slotCount = 0;

        // Edge-triggered current zone resolution (0-GC when zone ID unchanged).
        const resolvedZone = resolvePlayerCurrentZone(
          positions.playerWorldX,
          positions.playerWorldZ,
          villagesRef.current,
          plazaLabelRef.current,
          meadowLabelRef.current,
        );
        const currentVillageId = resolvedZone.villageId ?? null;
        const zoneSignature = `${resolvedZone.id}|${resolvedZone.label}`;
        if (lastZoneIdRef.current !== zoneSignature) {
          lastZoneIdRef.current = zoneSignature;
          setCurrentZone(resolvedZone);
        }

        const pushSlot = (
          key: string,
          el: HTMLDivElement | null | undefined,
          x: number,
          y: number,
          boxWidth: number,
          boxHeight: number,
          maxShift: number,
          priority: number,
          distance: number,
          distant: boolean,
          hideSpeech: boolean,
          opacity: number,
          scale: number,
          speechOffsetY: number,
        ) => {
          let slot = pool[slotCount];
          if (!slot) {
            slot = {
              key,
              el,
              x,
              y,
              baseY: y,
              boxWidth,
              boxHeight,
              maxShift,
              priority,
              distance,
              distant,
              hideSpeech,
              opacity,
              scale,
              speechOffsetY,
            };
            pool[slotCount] = slot;
          } else {
            slot.key = key;
            slot.el = el;
            slot.x = x;
            slot.y = y;
            slot.baseY = y;
            slot.boxWidth = boxWidth;
            slot.boxHeight = boxHeight;
            slot.maxShift = maxShift;
            slot.priority = priority;
            slot.distance = distance;
            slot.distant = distant;
            slot.hideSpeech = hideSpeech;
            slot.opacity = opacity;
            slot.scale = scale;
            slot.speechOffsetY = speechOffsetY;
          }
          slotCount += 1;
        };

        const actorMap = actorAnchorRefs.current;
        for (let i = 0; i < positions.actorCount; i += 1) {
          const p = positions.actors[i]!;
          distMap.set(p.actorId, p.distance);
          const el = actorMap.get(p.actorId);
          if (!p.visible || !el) {
            applyAnchorPosition(`actor:${p.actorId}`, el, p.x, p.y, false);
            continue;
          }
          const isPriority = priorityActors.has(p.actorId);
          const hasSpeech = speechActors.has(p.actorId);
          // 원거리(~32m 이상) 말풍선 숨김으로 원경 난립 방지
          const hideSpeech = hasSpeech && !isPriority && p.distance >= SPEECH_HIDE_DISTANCE_M;
          const activeSpeech = hasSpeech && !hideSpeech;
          const prio = isPriority ? 0 : activeSpeech ? 1 : 3;
          pushSlot(
            `actor:${p.actorId}`,
            el,
            p.x,
            p.y,
            activeSpeech ? SPEECH_BOX_WIDTH_PX : COLLIDE_X_THRESHOLD_PX,
            activeSpeech ? COLLIDE_Y_THRESHOLD_PX + SPEECH_EXTRA_HEIGHT_PX : COLLIDE_Y_THRESHOLD_PX,
            activeSpeech ? COLLIDE_SPEECH_MAX_SHIFT_PX : COLLIDE_MAX_SHIFT_PX,
            prio,
            p.distance,
            p.isDistant,
            hideSpeech,
            p.opacity ?? 1,
            p.scale ?? 1,
            p.speechOffsetY ?? 0,
          );
        }

        lastPlayerScreenRef.current.x = positions.player.x;
        lastPlayerScreenRef.current.y = positions.player.y;
        lastPlayerScreenRef.current.visible = positions.player.visible;

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
          const el = villageMap.get(v.villageId);
          const isCurrentVillage = currentVillageId === v.villageId;
          if (!v.visible || !el || (!isCurrentVillage && v.distance > VILLAGE_HIDE_DISTANCE_M)) {
            applyAnchorPosition(`village:${v.villageId}`, el, v.x, v.y, false);
            continue;
          }
          let vOpacity = 1;
          let vScale = 1;
          if (!isCurrentVillage && v.distance > VILLAGE_FADE_START_M) {
            const tFade = Math.min(
              1,
              (v.distance - VILLAGE_FADE_START_M) / (VILLAGE_FADE_END_M - VILLAGE_FADE_START_M),
            );
            vOpacity = 1 - tFade * 0.58;
            vScale = 1 - tFade * 0.16;
            if (v.distance > VILLAGE_FADE_END_M) {
              const tFar = Math.min(
                1,
                (v.distance - VILLAGE_FADE_END_M) / (VILLAGE_HIDE_DISTANCE_M - VILLAGE_FADE_END_M),
              );
              vOpacity *= 1 - tFar * 0.72;
            }
          }
          pushSlot(
            `village:${v.villageId}`,
            el,
            v.x,
            v.y,
            VILLAGE_BOX_WIDTH_PX * vScale,
            COLLIDE_Y_THRESHOLD_PX * vScale,
            COLLIDE_MAX_SHIFT_PX,
            isCurrentVillage ? 0 : 4,
            isCurrentVillage ? 0 : v.distance,
            !isCurrentVillage && v.distance > VILLAGE_FADE_START_M,
            false,
            vOpacity,
            vScale,
            0,
          );
        }

        // 호버 중인 구역 툴팁도 화면 가장자리에서 글자가 잘리지 않도록 안전 여백 보정
        const tipX = Math.max(88, Math.min(vw - 88, positions.hoveredDistrict.x));
        const tipY = Math.max(TOP_HUD_CLEARANCE_PX + 12, Math.min(vh - 20, positions.hoveredDistrict.y));
        applyAnchorPosition(
          "district-tooltip",
          districtTooltipRef.current,
          tipX,
          tipY,
          positions.hoveredDistrict.visible,
        );

        const landmarks: readonly [string, HTMLDivElement | null, number, number, boolean][] = [
          ["notice-board", noticeBoardAnchorRef.current, positions.noticeBoard.x, positions.noticeBoard.y, positions.noticeBoard.visible],
          ["guild-hall", guildHallAnchorRef.current, positions.guildHall.x, positions.guildHall.y, positions.guildHall.visible],
          ["campfire-bench", campfireBenchAnchorRef.current, positions.campfireBench.x, positions.campfireBench.y, positions.campfireBench.visible],
        ];
        for (let i = 0; i < landmarks.length; i += 1) {
          const lm = landmarks[i]!;
          if (!lm[4] || !lm[1]) {
            applyAnchorPosition(lm[0], lm[1], lm[2], lm[3], false);
          } else {
            pushSlot(
              lm[0],
              lm[1],
              lm[2],
              lm[3],
              COLLIDE_X_THRESHOLD_PX,
              COLLIDE_Y_THRESHOLD_PX,
              COLLIDE_MAX_SHIFT_PX,
              2,
              12 + i,
              false,
              false,
              1,
              1,
              0,
            );
          }
        }

        // In-place insertion sort by (priority, distance) — 0 GC allocation.
        for (let i = 1; i < slotCount; i += 1) {
          const current = pool[i]!;
          let j = i - 1;
          while (j >= 0) {
            const prev = pool[j]!;
            if (
              prev.priority < current.priority
              || (prev.priority === current.priority && prev.distance <= current.distance)
            ) {
              break;
            }
            pool[j + 1] = prev;
            j -= 1;
          }
          pool[j + 1] = current;
        }

        // 2D screen-space decluttering pass (speech-bubble height aware):
        // Anchor transforms use translate(-50%, -100%), so each box spans [y - boxHeight, y].
        for (let i = 1; i < slotCount; i += 1) {
          const curr = pool[i]!;
          let stillColliding = false;
          for (let j = 0; j < i; j += 1) {
            const other = pool[j]!;
            if (other.opacity <= 0.15) continue;
            const halfW = (curr.boxWidth + other.boxWidth) * 0.5;
            if (Math.abs(curr.x - other.x) >= halfW) continue;

            const currTop = curr.y - curr.boxHeight;
            const currBottom = curr.y;
            const otherTop = other.y - other.boxHeight;
            const otherBottom = other.y;
            if (currTop >= otherBottom || otherTop >= currBottom) continue;

            // Prefer pushing upward to avoid covering character bodies below, unless downward shift is much smaller.
            const pushUp = otherTop - currBottom; // negative
            const pushDown = otherBottom - currTop; // positive
            const shift = curr.y <= other.y || Math.abs(pushUp) <= Math.abs(pushDown) + 10
              ? pushUp
              : pushDown;
            const targetY = curr.y + shift;
            const minY = curr.baseY - curr.maxShift;
            const maxY = curr.baseY + curr.maxShift;
            curr.y = targetY < minY ? minY : targetY > maxY ? maxY : targetY;

            const nextTop = curr.y - curr.boxHeight;
            const nextBottom = curr.y;
            if (nextTop < otherBottom - 2 && otherTop < nextBottom - 2) {
              stillColliding = true;
            }
          }
          if (stillColliding) {
            if (curr.priority >= 4 && curr.distance > 30) {
              curr.opacity = 0;
            } else if (curr.distant || curr.distance > COLLIDE_FAR_DISTANCE_M || curr.priority >= 3) {
              curr.opacity = Math.min(curr.opacity, COLLIDE_FADED_OPACITY);
            } else if (curr.priority >= 1) {
              curr.opacity = Math.min(curr.opacity, 0.52);
            }
          }
        }

        // 화면 가장자리 안전 여백 & 상단 HUD 침범 방지 페이드 (글자 절단 금지)
        for (let i = 0; i < slotCount; i += 1) {
          const slot = pool[i]!;
          const halfW = slot.boxWidth * 0.5;
          const minSafeX = halfW + EDGE_SAFE_PADDING_PX;
          const maxSafeX = vw - halfW - EDGE_SAFE_PADDING_PX;

          // 화면 밖으로 완전히 벗어난 라벨은 숨기고, 가장자리 근처는 텍스트가 잘리지 않게 페이드·보정
          if (slot.x < EDGE_SAFE_PADDING_PX || slot.x > vw - EDGE_SAFE_PADDING_PX || slot.y > vh - 10) {
            slot.opacity = 0;
          } else if (minSafeX < maxSafeX) {
            if (slot.x < minSafeX) {
              const ratio = Math.max(0, (slot.x - EDGE_SAFE_PADDING_PX) / halfW);
              slot.x = minSafeX;
              slot.opacity *= 0.25 + ratio * 0.75;
            } else if (slot.x > maxSafeX) {
              const ratio = Math.max(0, (vw - EDGE_SAFE_PADDING_PX - slot.x) / halfW);
              slot.x = maxSafeX;
              slot.opacity *= 0.25 + ratio * 0.75;
            }
          }

          const boxTop = slot.y - slot.boxHeight;
          const inTopRightHud = slot.x + halfW > vw - TOP_HUD_RIGHT_WIDTH_PX;
          const inTopLeftHud = slot.x - halfW < TOP_HUD_LEFT_WIDTH_PX;
          const hudCeiling = inTopRightHud
            ? TOP_HUD_CLEARANCE_PX + 10
            : inTopLeftHud
              ? TOP_HUD_CLEARANCE_PX + 2
              : TOP_HUD_CLEARANCE_PX - 12;

          if (boxTop < TOP_HUD_HARD_HIDE_PX) {
            slot.opacity = 0;
          } else if (boxTop < hudCeiling) {
            const topRatio = Math.max(0, (boxTop - TOP_HUD_HARD_HIDE_PX) / (hudCeiling - TOP_HUD_HARD_HIDE_PX));
            slot.opacity *= topRatio;
          }

          applyAnchorPosition(
            slot.key,
            slot.el,
            slot.x,
            slot.y,
            slot.opacity > 0.03,
            slot.distant,
            slot.opacity,
            slot.scale,
            slot.speechOffsetY,
            slot.hideSpeech,
          );
        }
      },
      getLastPlayerScreenPoint() {
        return lastPlayerScreenRef.current;
      },
    }), [applyAnchorPosition]);

    const showWorldSigns = lifecycle === "open" && interactionMode === "closed" && !anyModalOpen && !cinemaMode;
    const showPlayerLabel =
      lifecycle === "open"
      && cameraMode === "follow"
      && interactionMode === "closed"
      && !anyModalOpen
      && !photoMode
      && !cinemaMode
      && playerLabelRevealed;
    const showDistrictTooltip =
      showWorldSigns
      && !photoMode
      && hoveredDistrict !== null
      && hoveredDistrict.id !== selectedDistrictId;

    // Enforce single nearest interaction badge (`E 상호작용`) at any time.
    let singleNearActorId: string | null = null;
    let bestNearDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < labelMetas.length; i += 1) {
      const m = labelMetas[i]!;
      if (!m.isNearPlayer) continue;
      const dist = lastActorDistanceRef.current.get(m.actorId) ?? i;
      if (dist < bestNearDistance) {
        bestNearDistance = dist;
        singleNearActorId = m.actorId;
      }
    }

    if (suppressAllLabels) {
      return null;
    }

    return (
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
              onClick={onOpenAdmiralCustomizer}
            >
              <span>{t("theWorld.labels.playerSelf")}</span>
            </button>
          </div>
        ) : null}

        {showWorldSigns
          ? villages.map((village) => (
            <div
              key={village.id}
              ref={getVillageAnchorRef(village.id)}
              className="the-world-actor-anchor"
            >
              <button
                type="button"
                className={`the-world-village-sign${dragTargetVillageId === village.id ? " is-drag-target" : ""}`}
                data-village-id={village.id}
                aria-label={t("theWorld.village.warpAria", { name: village.label })}
                onPointerDown={(e) => onVillageSignPointerDown(village, e)}
                onClick={() => onVillageSignClick(village)}
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

        {showWorldSigns ? (
          <div
            ref={setGuildHallAnchorRef}
            className="the-world-actor-anchor"
          >
            <button
              type="button"
              className="the-world-guild-sign"
              aria-label={t("theWorld.guildHall.signAria")}
              onClick={onOpenWarRoom}
            >
              <WorldIcon name="warRoom" size={13} tone="amber" />
              <span>{t("theWorld.guildHall.signLabel")}</span>
            </button>
          </div>
        ) : null}

        {showWorldSigns && !sittingAtCampfire ? (
          <div
            ref={setCampfireBenchAnchorRef}
            className="the-world-actor-anchor"
          >
            <button
              type="button"
              className="the-world-campfire-sign"
              aria-label={t("theWorld.campfire.sitAria")}
              onClick={onSitAtCampfire}
            >
              <WorldIcon name="fire" size={13} tone="amber" />
              <span>{t("theWorld.campfire.sitHint")}</span>
            </button>
          </div>
        ) : null}

        {showWorldSigns ? (
          <div
            ref={setNoticeBoardAnchorRef}
            className="the-world-actor-anchor"
          >
            <button
              type="button"
              className={`the-world-notice-sign${totalUrgentCount > 0 ? " is-urgent" : ""}`}
              aria-label={t("theWorld.noticeBoard.aria")}
              onClick={onOpenQuestBoard}
            >
              <WorldIcon
                name={totalUrgentCount > 0 ? "bell" : "questBoard"}
                size={13}
                tone={totalUrgentCount > 0 ? "amber" : "cerulean"}
              />
              <span>{t("theWorld.noticeBoard.label")}</span>
              {totalUrgentCount > 0 ? (
                <span className="the-world-notice-sign-badge">
                  {t("theWorld.noticeBoard.urgentBadge", { count: totalUrgentCount })}
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
          const hideForRadial = interactionMode === "radial" && lbl.isSelected;
          const isBackground = interactionMode === "radial" && !lbl.isSelected;
          if (hideForRadial) return null;
          const actorInteractAria = formatActorInteractAria(locale, lbl.name);
          const showActorEPrompt =
            !suppressInteractPrompts
            && (activeInteractTarget === undefined || activeInteractTarget === "actor")
            && lbl.isNearPlayer
            && lbl.actorId === singleNearActorId
            && interactionMode === "closed"
            && !cinemaMode;
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
                    <span className="the-world-speech-text">{parsed.text}</span>
                  </span>
                );
              })() : null}
              {lbl.needsAttention && !cinemaMode && !photoMode && !anyModalOpen ? (
                <button
                  type="button"
                  className="the-world-urgent-beacon"
                  aria-label={t("theWorld.urgent.beaconAria", { name: lbl.name })}
                  onClick={() => (onOpenUrgentActor ?? onInteractActor)(lbl.actorId)}
                >
                  <span aria-hidden="true">{lbl.role === "commodore" ? "?" : "!"}</span>
                </button>
              ) : null}
              {showActorEPrompt ? (
                <button
                  type="button"
                  className="the-world-interact-prompt"
                  aria-label={actorInteractAria}
                  onClick={() => onInteractActor(lbl.actorId)}
                >
                  <span className="the-world-keycap">E</span>
                  <span>{t("theWorld.labels.interact")}</span>
                </button>
              ) : null}
              <button
                type="button"
                className={`the-world-nametag${lbl.isSelected ? " is-selected" : ""}`}
                aria-label={actorInteractAria}
                onClick={() => onInteractActor(lbl.actorId)}
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
    );
  }),
);
