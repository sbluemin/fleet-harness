import { useEffect, useMemo, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorSpec, WorldScreenLabel } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { playCompanionCall, playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  addCompanionActorId,
  closeActorInteraction,
  openActorDialogue,
  openActorPanel,
  removeCompanionActorId,
  requestActorEmote,
  requestApproachActor,
  triggerWorldChoreography,
  useWorldStore,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

interface RadialAction {
  readonly id: string;
  readonly icon: WorldIconName;
  readonly iconTone: WorldIconTone;
  readonly label: string;
  readonly tone?: "primary" | "default";
  readonly run: () => void;
}

const ROLE_LABEL_KEY: Record<WorldActorSpec["role"], TheWorldMessageKey> = {
  commodore: "theWorld.role.commodore",
  commander: "theWorld.role.commander",
  member: "theWorld.role.member",
};

const STATE_LABEL_KEY: Record<WorldActorSpec["state"], TheWorldMessageKey> = {
  idle: "theWorld.state.idle",
  fresh: "theWorld.state.fresh",
  unseen: "theWorld.state.unseen",
  running: "theWorld.state.running",
  awaiting: "theWorld.state.awaiting",
  decision: "theWorld.state.decision",
  review: "theWorld.state.review",
  done: "theWorld.state.done",
  ended: "theWorld.state.ended",
  error: "theWorld.state.error",
};

/**
 * 심즈 / MMORPG 스타일 캐릭터 중심 방사형 상호작용 메뉴.
 *
 * 모든 항목이 2D 콘솔로 이탈하지 않고 더 월드 내부의 게임 창(대화·목표 보드·상태/정보·설정·감정표현)으로 이어지며,
 * 마우스 클릭뿐 아니라 숫자키(`1`–`6`), 방향키/Tab + `Enter`로 즉시 선택할 수 있다.
 */
export function WorldRadialMenu({
  actor,
  anchorLabel,
  isNear,
  deps,
  onStatusBanner,
}: {
  readonly actor: WorldActorSpec;
  readonly anchorLabel: WorldScreenLabel | null;
  readonly isNear: boolean;
  readonly deps: TheWorldClientDeps;
  readonly onStatusBanner: (msg: string) => void;
}) {
  const t = getWorldT(deps.commodore.language());
  const store = useWorldStore();
  const isCompanion = store.companionActorIds.includes(actor.id);
  const [activeIndex, setActiveIndex] = useState(0);

  const actions = useMemo<readonly RadialAction[]>(() => {
    const approachAction: RadialAction = {
      id: "approach",
      icon: "approach",
      iconTone: "teal",
      label: t("theWorld.radial.approach"),
      run: () => {
        requestApproachActor(actor.id);
        onStatusBanner(t("theWorld.radial.approachToast", { name: actor.name }));
      },
    };

    if (actor.role === "commodore") {
      return [
        {
          id: "talk",
          icon: "chat",
          iconTone: "amber",
          label: t("theWorld.radial.talk"),
          tone: "primary",
          run: () => openActorDialogue(actor.id),
        },
        {
          id: "companion",
          icon: isCompanion ? "close" : "approach",
          iconTone: isCompanion ? "amber" : "teal",
          label: isCompanion ? t("theWorld.companion.endWalk") : t("theWorld.companion.walkTogether"),
          tone: isCompanion ? "primary" : "default",
          run: () => {
            if (isCompanion) {
              removeCompanionActorId(actor.id);
              playDistrictSelect();
              onStatusBanner(t("theWorld.companion.leftToast", { name: actor.name }));
            } else {
              addCompanionActorId(actor.id);
              playCompanionCall();
              onStatusBanner(t("theWorld.companion.joinedToast", { name: actor.name }));
            }
            closeActorInteraction();
          },
        },
        {
          id: "goals",
          icon: "questMap",
          iconTone: "moss",
          label: t("theWorld.radial.goals"),
          run: () => openActorPanel(actor.id, "goals"),
        },
        {
          id: "info",
          icon: "inspect",
          iconTone: "cerulean",
          label: t("theWorld.radial.profile"),
          run: () => openActorPanel(actor.id, "info"),
        },
        {
          id: "settings",
          icon: "settings",
          iconTone: "indigo",
          label: t("theWorld.radial.settings"),
          run: () => openActorPanel(actor.id, "settings"),
        },
        isNear
          ? {
            id: "greet",
            icon: "greet",
            iconTone: "rose",
            label: t("theWorld.radial.greet"),
            run: () => {
              requestActorEmote(actor.id, "greet");
              closeActorInteraction();
              onStatusBanner(t("theWorld.radial.greetToast", { name: actor.name }));
            },
          }
          : approachAction,
      ];
    }

    if (actor.role === "commander") {
      return [
        {
          id: "talk",
          icon: "chat",
          iconTone: "amber",
          label: t("theWorld.radial.talk"),
          tone: "primary",
          run: () => openActorDialogue(actor.id),
        },
        {
          id: "goals",
          icon: "questMap",
          iconTone: "moss",
          label: t("theWorld.radial.goals"),
          run: () => openActorPanel(actor.id, "goals", actor.rootObjectiveId ?? actor.objectiveId),
        },
        {
          id: "crew",
          icon: "crew",
          iconTone: "cerulean",
          label: t("theWorld.radial.crew"),
          run: () => openActorPanel(actor.id, "info", actor.rootObjectiveId ?? actor.objectiveId),
        },
        {
          id: "rally",
          icon: "rally",
          iconTone: "amber",
          label: t("theWorld.radial.rally"),
          run: () => {
            triggerWorldChoreography("delegate", actor.zoneId);
            closeActorInteraction();
            onStatusBanner(t("theWorld.radial.rallyToast", { name: actor.name }));
          },
        },
        isNear
          ? {
            id: "cheer",
            icon: "cheer",
            iconTone: "rose",
            label: t("theWorld.radial.cheer"),
            run: () => {
              requestActorEmote(actor.id, "cheer");
              closeActorInteraction();
              onStatusBanner(t("theWorld.radial.cheerToast", { name: actor.name }));
            },
          }
          : approachAction,
      ];
    }

    return [
      {
        id: "talk",
        icon: "chat",
        iconTone: "amber",
        label: t("theWorld.radial.talk"),
        tone: "primary",
        run: () => openActorDialogue(actor.id),
      },
      {
        id: "crew",
        icon: "inspect",
        iconTone: "cerulean",
        label: t("theWorld.radial.crew"),
        run: () => openActorPanel(actor.id, "info", actor.rootObjectiveId ?? actor.objectiveId),
      },
      {
        id: "goals",
        icon: "questMap",
        iconTone: "moss",
        label: t("theWorld.radial.goals"),
        run: () => openActorPanel(actor.id, "goals", actor.rootObjectiveId ?? actor.objectiveId),
      },
      isNear
        ? {
          id: "highfive",
          icon: "highfive",
          iconTone: "rose",
          label: t("theWorld.radial.highfive"),
          run: () => {
            requestActorEmote(actor.id, "highfive");
            closeActorInteraction();
            onStatusBanner(t("theWorld.radial.highfiveToast", { name: actor.name }));
          },
        }
        : approachAction,
    ];
  }, [actor, isCompanion, isNear, onStatusBanner, t]);

  useEffect(() => {
    setActiveIndex(0);
  }, [actor.id]);

  // 숫자키(1~6) · 방향키 · Tab · Enter 키보드 빠른 선택
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || event.target.isContentEditable) return;
      }
      if (event.key >= "1" && event.key <= "9") {
        const idx = Number(event.key) - 1;
        const chosen = actions[idx];
        if (chosen) {
          event.preventDefault();
          event.stopPropagation();
          chosen.run();
        }
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % actions.length);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
        event.preventDefault();
        setActiveIndex((prev) => (prev - 1 + actions.length) % actions.length);
        return;
      }
      if (event.key === "Enter" || event.code === "Space") {
        const chosen = actions[activeIndex];
        if (chosen) {
          event.preventDefault();
          event.stopPropagation();
          chosen.run();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, activeIndex]);

  // 화면 경계 밖으로 페탈이 잘리지 않도록 중심 좌표를 안전 영역으로 클램프
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const rawX = anchorLabel ? anchorLabel.hitX : vw * 0.5;
  const rawY = anchorLabel ? anchorLabel.hitY : vh * 0.5;
  const cx = Math.max(240, Math.min(vw - 240, rawX));
  const cy = Math.max(195, Math.min(vh - 195, rawY));

  const rx = actions.length >= 6 ? 172 : 158;
  const ry = actions.length >= 6 ? 126 : 114;

  const petalCoords = actions.map((_, index) => {
    const angle = -Math.PI * 0.5 + (index / actions.length) * Math.PI * 2;
    return {
      x: Math.cos(angle) * rx,
      y: Math.sin(angle) * ry,
    };
  });

  return (
    <div
      className="the-world-radial-backdrop"
      role="dialog"
      aria-label={t("theWorld.radial.aria", { name: actor.name })}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          closeActorInteraction();
        }
      }}
    >
      <div className="the-world-radial-root" style={{ left: `${cx}px`, top: `${cy}px` }}>
        <svg className="the-world-radial-svg" viewBox="-220 -180 440 360" aria-hidden="true">
          <ellipse className="the-world-radial-ring" cx="0" cy="0" rx={rx * 0.68} ry={ry * 0.68} />
          {petalCoords.map((pt, idx) => (
            <line
              key={actions[idx]!.id}
              className={`the-world-radial-spoke${activeIndex === idx ? " is-active" : ""}`}
              x1={pt.x * 0.34}
              y1={pt.y * 0.34}
              x2={pt.x * 0.78}
              y2={pt.y * 0.78}
            />
          ))}
        </svg>

        <button
          type="button"
          className="the-world-radial-aperture"
          data-tone={actor.tone}
          aria-label={t("theWorld.radial.closeAria")}
          onClick={closeActorInteraction}
        >
          <span className="the-world-radial-hub-pill">
            <MongleAvatar
              base={actor.baseId}
              tone={actor.tone}
              role={actor.role}
              state={actor.state}
              activity={actor.activity}
              size={20}
              label={actor.name}
              decorative
            />
            <span className="the-world-radial-hub-name">{actor.name}</span>
            <span className="the-world-radial-hub-meta">
              {t(ROLE_LABEL_KEY[actor.role])} · {t(STATE_LABEL_KEY[actor.state])}
            </span>
          </span>
        </button>

        {actions.map((action, idx) => {
          const pt = petalCoords[idx]!;
          const isHighlighted = activeIndex === idx;
          return (
            <button
              key={action.id}
              type="button"
              className={`the-world-radial-petal${isHighlighted ? " is-highlighted" : ""}${action.tone === "primary" ? " is-primary" : ""}`}
              style={{
                left: `${pt.x.toFixed(1)}px`,
                top: `${pt.y.toFixed(1)}px`,
                animationDelay: `${idx * 28}ms`,
              }}
              onMouseEnter={() => setActiveIndex(idx)}
              onFocus={() => setActiveIndex(idx)}
              onClick={action.run}
            >
              <span className="the-world-radial-key">{idx + 1}</span>
              <span className={`the-world-radial-icon-badge is-tone-${action.iconTone}`} aria-hidden="true">
                <WorldIcon name={action.icon} size={14} tone={isHighlighted ? "inherit" : action.iconTone} />
              </span>
              <span className="the-world-radial-label">{action.label}</span>
            </button>
          );
        })}

        <div className="the-world-radial-footnote" aria-hidden="true">
          {t("theWorld.radial.footnote", { count: actions.length })}
        </div>
      </div>
    </div>
  );
}
