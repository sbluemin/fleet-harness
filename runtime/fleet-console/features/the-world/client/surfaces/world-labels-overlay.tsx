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
}

export const WorldLabelsOverlay = memo(
  forwardRef<WorldLabelsOverlayHandle, WorldLabelsOverlayProps>(function WorldLabelsOverlay(
    {
      lifecycle,
      cameraMode,
      interactionMode,
      anyModalOpen,
      photoMode,
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
        const actorMap = actorAnchorRefs.current;
        for (let i = 0; i < positions.actorCount; i += 1) {
          const p = positions.actors[i]!;
          applyAnchorPosition(
            `actor:${p.actorId}`,
            actorMap.get(p.actorId),
            p.x,
            p.y,
            p.visible,
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
      },
      getLastPlayerScreenPoint() {
        return lastPlayerScreenRef.current;
      },
    }), [applyAnchorPosition]);

    const showWorldSigns = lifecycle === "open" && interactionMode === "closed" && !anyModalOpen;
    const showPlayerLabel =
      lifecycle === "open"
      && cameraMode === "follow"
      && interactionMode === "closed"
      && !anyModalOpen
      && !photoMode
      && playerLabelRevealed;
    const showDistrictTooltip =
      showWorldSigns
      && !photoMode
      && hoveredDistrict !== null
      && hoveredDistrict.id !== selectedDistrictId;

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
              <span className="the-world-keycap">F</span>
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
              {lbl.isNearPlayer && interactionMode === "closed" ? (
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
