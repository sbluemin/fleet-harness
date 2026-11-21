import { memo, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type {
  WorldActorPanelMode,
  WorldActorSpec,
  WorldDistrictSpec,
} from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  closeActorInteraction,
  openActorDialogue,
  openActorPanel,
  setInspectedObjectiveId,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

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

interface DrawerTabSpec {
  readonly id: WorldActorPanelMode;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
  readonly labelKey: TheWorldMessageKey;
}

const COMMODORE_TABS: readonly DrawerTabSpec[] = [
  { id: "chat", icon: "chat", tone: "amber", labelKey: "theWorld.drawer.tabChat" },
  { id: "goals", icon: "questMap", tone: "moss", labelKey: "theWorld.drawer.tabGoals" },
  { id: "info", icon: "inspect", tone: "cerulean", labelKey: "theWorld.drawer.tabProfile" },
  { id: "settings", icon: "settings", tone: "indigo", labelKey: "theWorld.drawer.tabSettings" },
];

const OBJECTIVE_ACTOR_TABS: readonly DrawerTabSpec[] = [
  { id: "chat", icon: "chat", tone: "amber", labelKey: "theWorld.drawer.tabChat" },
  { id: "goals", icon: "questMap", tone: "moss", labelKey: "theWorld.drawer.tabGoals" },
  { id: "info", icon: "crew", tone: "cerulean", labelKey: "theWorld.drawer.tabCrew" },
];

export interface WorldPanelModalProps {
  readonly actor: WorldActorSpec;
  readonly mode: WorldActorPanelMode;
  readonly inspectedObjectiveId: string | null;
  readonly deps: TheWorldClientDeps;
  readonly districts?: readonly WorldDistrictSpec[] | undefined;
  readonly onJumpToDistrict?: ((theaterId: string) => void) | undefined;
}

/**
 * 더 월드 우측 플로팅 글래스 「사령관 작전 수첩」 드로어.
 *
 * 좌측 55%+ 초원 시야를 열어 둔 채 우측 슬라이드 시트로 통합해,
 * 실제 콘솔 채팅(`대화`)과 목표·프로필·설정(또는 구성원) 탭을 한 수첩에서 오간다.
 */
export const WorldPanelModal = memo(function WorldPanelModal({
  actor,
  mode,
  inspectedObjectiveId,
  deps,
  districts,
  onJumpToDistrict,
}: WorldPanelModalProps) {
  const t = getWorldT(deps.commodore.language());
  const [subObjectiveTab, setSubObjectiveTab] = useState<"goal" | "crew">("goal");

  const isCommodore = actor.role === "commodore" && Boolean(actor.commodoreId);
  const activeObjectiveId = inspectedObjectiveId
    ?? (!isCommodore ? (actor.rootObjectiveId ?? actor.objectiveId ?? null) : null);

  const isChatMode = mode === "chat" && (!isCommodore || !inspectedObjectiveId);
  const statusKind = actor.state === "error"
    ? "error"
    : actor.needsAttention
      ? "attention"
      : actor.state === "running"
        ? "working"
        : "idle";

  const tabs = isCommodore ? COMMODORE_TABS : OBJECTIVE_ACTOR_TABS;
  const effectiveObjectiveTab: "goal" | "crew" = mode === "info" ? "crew" : "goal";

  const handleOpenObjectiveFromChat = (objectiveId: string) => {
    setSubObjectiveTab("goal");
    openActorPanel(actor.id, "goals", objectiveId);
  };

  return (
    <aside
      className={`the-world-drawer${isChatMode ? " is-chat-mode" : ""}`}
      data-tone={actor.tone}
      role="dialog"
      aria-label={t("theWorld.drawer.aria", { name: actor.name })}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="the-world-drawer-crest" aria-hidden="true" />

      {/* 슬림 1행 헤더 */}
      <header className="the-world-drawer-head">
        <div className="the-world-drawer-identity">
          <div className="the-world-drawer-portrait" data-tone={actor.tone}>
            <MongleAvatar
              base={actor.baseId}
              tone={actor.tone}
              role={actor.role}
              state={actor.state}
              activity={actor.activity}
              size={34}
              label={actor.name}
              decorative
            />
          </div>
          <div className="the-world-drawer-identity-meta">
            <div className="the-world-drawer-title-row">
              <span className="the-world-drawer-name">{actor.name}</span>
              <span className={`the-world-rpg-status is-${statusKind}`}>
                <span className="the-world-rpg-status-dot" aria-hidden="true" />
                <span>{STATE_LABEL[actor.state]}</span>
              </span>
            </div>
            {actor.modelLabel ? (
              <span className="the-world-drawer-model">{actor.modelLabel}</span>
            ) : null}
          </div>
        </div>

        <div className="the-world-drawer-controls">
          <button
            type="button"
            className="the-world-btn"
            aria-label={t("theWorld.drawer.rpgModeAria", { name: actor.name })}
            onClick={() => openActorDialogue(actor.id)}
          >
            <WorldIcon name="greet" size={13} tone="amber" />
            <span>{t("theWorld.drawer.rpgMode")}</span>
          </button>
          <button
            type="button"
            className="the-world-btn is-icon-only"
            aria-label={t("theWorld.panel.closeAria")}
            onClick={closeActorInteraction}
          >
            <WorldIcon name="close" size={14} />
          </button>
        </div>
      </header>

      {/* 통합 세그먼트 탭 바 */}
      <div className="the-world-drawer-tabs" role="tablist" aria-label={t("theWorld.panel.tabsAria")}>
        {tabs.map((tab) => {
          const active = isCommodore
            ? (!inspectedObjectiveId && mode === tab.id)
            : mode === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`the-world-drawer-tab${active ? " is-active" : ""}`}
              onClick={() => openActorPanel(actor.id, tab.id, isCommodore ? null : activeObjectiveId)}
            >
              <WorldIcon name={tab.icon} size={13} tone={active ? "inherit" : tab.tone} />
              <span>{t(tab.labelKey)}</span>
            </button>
          );
        })}
      </div>

      {/* 사령관 드로어 내 목표 상세 드릴다운 복귀 바 */}
      {isCommodore && inspectedObjectiveId ? (
        <div className="the-world-drawer-subbar">
          <button
            type="button"
            className="the-world-drawer-back-btn"
            onClick={() => setInspectedObjectiveId(null)}
          >
            <WorldIcon name="wheelBack" size={12} />
            <span>{t("theWorld.drawer.backToGoals")}</span>
          </button>
        </div>
      ) : null}

      {/* 드로어 본문: 대화 탭은 100% 실제 콘솔 채팅 임베드 */}
      <div className={`the-world-drawer-body${isChatMode ? " is-chat" : ""}`}>
        {isChatMode ? (
          deps.renderActorConversation({
            actor,
            onOpenObjective: handleOpenObjectiveFromChat,
            onClose: closeActorInteraction,
          })
        ) : isCommodore && actor.commodoreId ? (
          inspectedObjectiveId ? (
            deps.renderObjectivePanel({
              commodoreId: actor.commodoreId,
              objectiveId: inspectedObjectiveId,
              tab: subObjectiveTab,
              onSwitchTab: setSubObjectiveTab,
              onOpenObjective: (nextId) => setInspectedObjectiveId(nextId),
            })
          ) : (
            deps.renderCommodorePanel({
              commodoreId: actor.commodoreId,
              tab: mode,
              onOpenObjective: (objectiveId) => {
                setSubObjectiveTab("goal");
                setInspectedObjectiveId(objectiveId);
              },
              onRequestRoutine: () => openActorPanel(actor.id, "chat", null),
              ...(onJumpToDistrict ? { onJumpToDistrict } : {}),
              ...(districts ? { districts } : {}),
            })
          )
        ) : actor.commodoreId && activeObjectiveId ? (
          deps.renderObjectivePanel({
            commodoreId: actor.commodoreId,
            objectiveId: activeObjectiveId,
            tab: effectiveObjectiveTab,
            onSwitchTab: (nextTab) => openActorPanel(
              actor.id,
              nextTab === "crew" ? "info" : "goals",
              activeObjectiveId,
            ),
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
    </aside>
  );
});
