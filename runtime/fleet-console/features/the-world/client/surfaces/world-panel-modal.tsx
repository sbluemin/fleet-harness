import { useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldActorPanelMode, WorldActorSpec } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT } from "../i18n/index.js";
import {
  closeActorInteraction,
  openActorDialogue,
  openActorPanel,
  openActorRadialMenu,
  setInspectedObjectiveId,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

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

const COMMODORE_TABS: readonly {
  readonly id: WorldActorPanelMode;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
  readonly label: string;
}[] = [
  { id: "goals", icon: "questMap", tone: "moss", label: "목표·루틴" },
  { id: "info", icon: "inspect", tone: "cerulean", label: "상태·정보" },
  { id: "settings", icon: "settings", tone: "indigo", label: "설정" },
];

/**
 * 더 월드 내부 게임 작전 창(목표 보드 · 상태/설명/정보/기억 · 사령관 설정 · 목표 상세).
 *
 * 2D 콘솔로 이탈하지 않고 3D 초원 위에서 사령관/지휘관/구성원의 모든 콘솔 기능을 그대로 다룬다.
 */
export function WorldPanelModal({
  actor,
  mode,
  inspectedObjectiveId,
  deps,
}: {
  readonly actor: WorldActorSpec;
  readonly mode: WorldActorPanelMode;
  readonly inspectedObjectiveId: string | null;
  readonly deps: TheWorldClientDeps;
}) {
  const t = getWorldT(deps.commodore.language());
  const [objectiveTab, setObjectiveTab] = useState<"goal" | "crew">(mode === "info" ? "crew" : "goal");

  const activeObjectiveId = inspectedObjectiveId
    ?? (actor.role !== "commodore" ? (actor.rootObjectiveId ?? actor.objectiveId ?? null) : null);

  return (
    <div
      className="the-world-panel-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeActorInteraction();
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      <section
        className="the-world-panel"
        role="dialog"
        aria-label={t("theWorld.panel.aria", { name: actor.name })}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />
        <header className="the-world-panel-head">
          <div className="the-world-dialogue-speaker">
            <div className="the-world-dialogue-portrait" data-tone={actor.tone}>
              <MongleAvatar
                base={actor.baseId}
                tone={actor.tone}
                role={actor.role}
                state={actor.state}
                activity={actor.activity}
                size={38}
                label={actor.name}
                decorative
              />
            </div>
            <div className="the-world-dialogue-meta">
              <div className="the-world-dialogue-name-row">
                <span className="the-world-dialogue-name">{actor.name}</span>
                <span className="the-world-dialogue-badge">{ROLE_LABEL[actor.role]}</span>
                <span className={`the-world-dialogue-badge${actor.needsAttention ? " is-attention" : ""}`}>
                  {STATE_LABEL[actor.state]}
                </span>
                {actor.modelLabel ? (
                  <span className="the-world-dialogue-badge is-code">{actor.modelLabel}</span>
                ) : null}
              </div>
              {actor.subtitle !== ROLE_LABEL[actor.role] ? (
                <div className="the-world-dialogue-sub">{actor.subtitle}</div>
              ) : null}
            </div>
          </div>

          <div className="the-world-dialogue-controls">
            <button
              type="button"
              className="the-world-btn"
              onClick={() => openActorDialogue(actor.id)}
            >
              <WorldIcon name="chat" size={14} tone="amber" />
              <span>대화</span>
            </button>
            <button
              type="button"
              className="the-world-btn"
              aria-label={t("theWorld.panel.backAria")}
              onClick={() => openActorRadialMenu(actor.id)}
            >
              <WorldIcon name="wheelBack" size={14} />
              <span>휠</span>
            </button>
            <button
              type="button"
              className="the-world-btn"
              aria-label={t("theWorld.panel.closeAria")}
              onClick={closeActorInteraction}
            >
              <WorldIcon name="close" size={14} />
            </button>
          </div>
        </header>

        {actor.role === "commodore" && actor.commodoreId ? (
          <div className="the-world-panel-tabs" role="tablist" aria-label={t("theWorld.panel.tabsAria")}>
            {COMMODORE_TABS.map((tab) => {
              const active = !inspectedObjectiveId && mode === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`the-world-panel-tab${active ? " is-active" : ""}`}
                  onClick={() => openActorPanel(actor.id, tab.id, null)}
                >
                  <WorldIcon name={tab.icon} size={14} tone={active ? "inherit" : tab.tone} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
            {inspectedObjectiveId ? (
              <button
                type="button"
                className="the-world-panel-tab is-active"
                onClick={() => setInspectedObjectiveId(null)}
              >
                <WorldIcon name="wheelBack" size={13} />
                <span>목표 목록으로</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="the-world-panel-tabs" role="tablist" aria-label={t("theWorld.panel.tabsAria")}>
            <button
              type="button"
              role="tab"
              aria-selected={objectiveTab === "goal"}
              className={`the-world-panel-tab${objectiveTab === "goal" ? " is-active" : ""}`}
              onClick={() => setObjectiveTab("goal")}
            >
              <WorldIcon name="questMap" size={14} tone={objectiveTab === "goal" ? "inherit" : "moss"} />
              <span>목표·결정</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={objectiveTab === "crew"}
              className={`the-world-panel-tab${objectiveTab === "crew" ? " is-active" : ""}`}
              onClick={() => setObjectiveTab("crew")}
            >
              <WorldIcon name="crew" size={14} tone={objectiveTab === "crew" ? "inherit" : "cerulean"} />
              <span>구성원·임무</span>
            </button>
          </div>
        )}

        <div className="the-world-panel-body">
          {actor.role === "commodore" && actor.commodoreId ? (
            inspectedObjectiveId ? (
              deps.renderObjectivePanel({
                commodoreId: actor.commodoreId,
                objectiveId: inspectedObjectiveId,
                tab: objectiveTab,
                onSwitchTab: setObjectiveTab,
                onOpenObjective: (nextId) => setInspectedObjectiveId(nextId),
              })
            ) : (
              deps.renderCommodorePanel({
                commodoreId: actor.commodoreId,
                tab: mode,
                onOpenObjective: (objectiveId) => {
                  setObjectiveTab("goal");
                  setInspectedObjectiveId(objectiveId);
                },
              })
            )
          ) : actor.commodoreId && activeObjectiveId ? (
            deps.renderObjectivePanel({
              commodoreId: actor.commodoreId,
              objectiveId: activeObjectiveId,
              tab: objectiveTab,
              onSwitchTab: setObjectiveTab,
              onOpenObjective: (nextId) => setInspectedObjectiveId(nextId),
            })
          ) : (
            <div className="the-world-panel-empty">
              {actor.summaryLines.map((line, i) => (
                <p key={i}>• {line}</p>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
