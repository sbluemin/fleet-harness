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
import { getWorldT } from "../i18n/index.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

/**
 * Direct-DOM 3D 투영 라벨 오버레이 (`translate3d` 0Hz 갱신 + 거리 LOD `opacity`/`scale`).
 *
 * - 캐릭터 이름표·말풍선·상호작용 힌트, 사령관 마을 푯말, 길드 회관/모닥불/퀘스트 게시판 표식,
 *   Theater 구역 호버 툴팁을 렌더링한다.
 * - 제독(`나 (제독)`) 이름표는 기본 숨김 처리하여 중앙 시야를 가리지 않고,
 *   제독 캐릭터 호버 또는 커스터마이저 오픈 시에만 노출한다.
 */

const POS_DEADZONE_PX = 0.5;
const LOD_EPSILON = 0.02;
const COLLIDE_X_THRESHOLD_PX = 116;
const COLLIDE_Y_THRESHOLD_PX = 26;
const COLLIDE_MAX_SHIFT_PX = 28;
const COLLIDE_FAR_DISTANCE_M = 18;
const COLLIDE_FADED_OPACITY = 0.42;

interface DeclutterSlot {
  key: string;
  el: HTMLDivElement | null | undefined;
  x: number;
  y: number;
  baseY: number;
  priority: number;
  distance: number;
  distant: boolean;
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
  opacity: number;
  scale: number;
  speechOffsetY: number;
}

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
    },
    ref,
  ) {
    const t = getWorldT(locale);

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

    // Keep priority actor lookup fresh for 0-GC frame decluttering without adding hook deps.
    priorityActorIdsRef.current.clear();
    for (let i = 0; i < labelMetas.length; i += 1) {
      const m = labelMetas[i]!;
      if (m.isSelected || m.isNearPlayer || m.needsAttention) {
        priorityActorIdsRef.current.add(m.actorId);
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
    ) => {
      if (!el) return;
      const cache = appliedPosCacheRef.current;
      let prev = cache.get(key);
      if (!visible) {
        if (!prev) {
          el.style.visibility = "hidden";
          cache.set(key, { x: Number.NaN, y: Number.NaN, visible: false, distant: false, opacity: 1, scale: 1, speechOffsetY: 0 });
        } else if (prev.visible) {
          el.style.visibility = "hidden";
          prev.visible = false;
        }
        return;
      }

      if (!prev) {
        prev = { x: Number.NaN, y: Number.NaN, visible: false, distant: false, opacity: 1, scale: 1, speechOffsetY: 0 };
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
    }, []);

    useImperativeHandle(ref, () => ({
      applyFramePositions(positions: WorldFrameOverlayPositions) {
        const pool = declutterPoolRef.current;
        const distMap = lastActorDistanceRef.current;
        const priorityActors = priorityActorIdsRef.current;
        let slotCount = 0;

        const pushSlot = (
          key: string,
          el: HTMLDivElement | null | undefined,
          x: number,
          y: number,
          priority: number,
          distance: number,
          distant: boolean,
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
              priority,
              distance,
              distant,
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
            slot.priority = priority;
            slot.distance = distance;
            slot.distant = distant;
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
          const prio = priorityActors.has(p.actorId) ? 0 : 1;
          pushSlot(
            `actor:${p.actorId}`,
            el,
            p.x,
            p.y,
            prio,
            p.distance,
            p.isDistant,
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
          if (!v.visible || !el) {
            applyAnchorPosition(`village:${v.villageId}`, el, v.x, v.y, false);
            continue;
          }
          pushSlot(`village:${v.villageId}`, el, v.x, v.y, 3, v.distance, v.distance > COLLIDE_FAR_DISTANCE_M, 1, 1, 0);
        }

        applyAnchorPosition(
          "district-tooltip",
          districtTooltipRef.current,
          positions.hoveredDistrict.x,
          positions.hoveredDistrict.y,
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
            pushSlot(lm[0], lm[1], lm[2], lm[3], 2, 12 + i, false, 1, 1, 0);
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

        // 2D screen-space decluttering pass: shift lower-priority overlapping labels vertically (max 28px),
        // and gently fade distant labels that remain overlapped.
        for (let i = 1; i < slotCount; i += 1) {
          const curr = pool[i]!;
          let stillColliding = false;
          for (let j = 0; j < i; j += 1) {
            const other = pool[j]!;
            if (Math.abs(curr.x - other.x) >= COLLIDE_X_THRESHOLD_PX) continue;
            const dy = curr.y - other.y;
            if (Math.abs(dy) >= COLLIDE_Y_THRESHOLD_PX) continue;

            const needed = COLLIDE_Y_THRESHOLD_PX - Math.abs(dy);
            const pushDir = dy <= 0 ? -1 : 1;
            const targetY = curr.y + pushDir * needed;
            const minY = curr.baseY - COLLIDE_MAX_SHIFT_PX;
            const maxY = curr.baseY + COLLIDE_MAX_SHIFT_PX;
            curr.y = targetY < minY ? minY : targetY > maxY ? maxY : targetY;

            if (Math.abs(curr.y - other.y) < COLLIDE_Y_THRESHOLD_PX - 2) {
              stillColliding = true;
            }
          }
          if (stillColliding && (curr.distant || curr.distance > COLLIDE_FAR_DISTANCE_M || curr.priority >= 3)) {
            curr.opacity = Math.min(curr.opacity, COLLIDE_FADED_OPACITY);
          }
        }

        for (let i = 0; i < slotCount; i += 1) {
          const slot = pool[i]!;
          applyAnchorPosition(
            slot.key,
            slot.el,
            slot.x,
            slot.y,
            true,
            slot.distant,
            slot.opacity,
            slot.scale,
            slot.speechOffsetY,
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
              <span className="the-world-keycap">E</span>
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
              {lbl.isNearPlayer && lbl.actorId === singleNearActorId && interactionMode === "closed" && !cinemaMode ? (
                <button
                  type="button"
                  className="the-world-interact-prompt"
                  aria-label={t("theWorld.actor.interactAria", { name: lbl.name })}
                  onClick={() => onInteractActor(lbl.actorId)}
                >
                  <span className="the-world-keycap">E</span>
                  <span>{t("theWorld.labels.interact")}</span>
                </button>
              ) : null}
              <button
                type="button"
                className={`the-world-nametag${lbl.isSelected ? " is-selected" : ""}`}
                aria-label={t("theWorld.actor.interactAria", { name: lbl.name })}
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
