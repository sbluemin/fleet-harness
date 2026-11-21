import { useEffect, useMemo, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorSpec, WorldScreenLabel } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT } from "../i18n/index.js";
import {
  closeActorInteraction,
  openActorDialogue,
  openActorPanel,
  requestActorEmote,
  requestApproachActor,
  triggerWorldChoreography,
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

const ROLE_LABEL: Record<WorldActorSpec["role"], string> = {
  commodore: "사령관",
  commander: "지휘관",
  member: "구성원",
};

const STATE_LABEL: Record<WorldActorSpec["state"], string> = {
  idle: "대기 중",
  fresh: "준비됨",
  unseen: "새 소식",
  running: "작업 중",
  awaiting: "승인 대기",
  decision: "확인 필요",
  review: "검토 대기",
  done: "완료",
  ended: "종료됨",
  error: "오류",
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
  const [activeIndex, setActiveIndex] = useState(0);

  const actions = useMemo<readonly RadialAction[]>(() => {
    const approachAction: RadialAction = {
      id: "approach",
      icon: "approach",
      iconTone: "teal",
      label: "다가가기",
      run: () => {
        requestApproachActor(actor.id);
        onStatusBanner(`${actor.name} 앞으로 다가갔습니다.`);
      },
    };

    if (actor.role === "commodore") {
      return [
        {
          id: "talk",
          icon: "chat",
          iconTone: "amber",
          label: "말 걸기",
          tone: "primary",
          run: () => openActorDialogue(actor.id),
        },
        {
          id: "goals",
          icon: "questMap",
          iconTone: "moss",
          label: "목표",
          run: () => openActorPanel(actor.id, "goals"),
        },
        {
          id: "info",
          icon: "inspect",
          iconTone: "cerulean",
          label: "프로필",
          run: () => openActorPanel(actor.id, "info"),
        },
        {
          id: "settings",
          icon: "settings",
          iconTone: "indigo",
          label: "설정",
          run: () => openActorPanel(actor.id, "settings"),
        },
        isNear
          ? {
            id: "greet",
            icon: "greet",
            iconTone: "rose",
            label: "인사하기",
            run: () => {
              requestActorEmote(actor.id, "greet");
              closeActorInteraction();
              onStatusBanner(`${actor.name} 사령관에게 반갑게 인사했습니다.`);
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
          label: "말 걸기",
          tone: "primary",
          run: () => openActorDialogue(actor.id),
        },
        {
          id: "goals",
          icon: "questMap",
          iconTone: "moss",
          label: "목표",
          run: () => openActorPanel(actor.id, "goals", actor.rootObjectiveId ?? actor.objectiveId),
        },
        {
          id: "crew",
          icon: "crew",
          iconTone: "cerulean",
          label: "구성원",
          run: () => openActorPanel(actor.id, "info", actor.rootObjectiveId ?? actor.objectiveId),
        },
        {
          id: "rally",
          icon: "rally",
          iconTone: "amber",
          label: "구성원 소집",
          run: () => {
            triggerWorldChoreography("delegate", actor.zoneId);
            closeActorInteraction();
            onStatusBanner(`${actor.name} 지휘관이 캠프 구성원을 브리핑 테이블로 소집합니다.`);
          },
        },
        isNear
          ? {
            id: "cheer",
            icon: "cheer",
            iconTone: "rose",
            label: "격려하기",
            run: () => {
              requestActorEmote(actor.id, "cheer");
              closeActorInteraction();
              onStatusBanner(`${actor.name} 지휘관에게 힘찬 격려를 보냈습니다.`);
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
        label: "말 걸기",
        tone: "primary",
        run: () => openActorDialogue(actor.id),
      },
      {
        id: "crew",
        icon: "inspect",
        iconTone: "cerulean",
        label: "구성원",
        run: () => openActorPanel(actor.id, "info", actor.rootObjectiveId ?? actor.objectiveId),
      },
      {
        id: "goals",
        icon: "questMap",
        iconTone: "moss",
        label: "목표",
        run: () => openActorPanel(actor.id, "goals", actor.rootObjectiveId ?? actor.objectiveId),
      },
      isNear
        ? {
          id: "highfive",
          icon: "highfive",
          iconTone: "rose",
          label: "하이파이브",
          run: () => {
            requestActorEmote(actor.id, "highfive");
            closeActorInteraction();
            onStatusBanner(`${actor.name}와(과) 하이파이브를 나눴습니다.`);
          },
        }
        : approachAction,
    ];
  }, [actor, isNear, onStatusBanner]);

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
              {ROLE_LABEL[actor.role]} · {STATE_LABEL[actor.state]}
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
          1–{actions.length} 빠른 선택 · E / Esc 닫기
        </div>
      </div>
    </div>
  );
}
