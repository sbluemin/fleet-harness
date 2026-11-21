import { memo, useState } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type {
  WorldActorSpec,
  WorldQuestBoardData,
  WorldQuestMissionSummary,
} from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT } from "../i18n/index.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

type QuestBoardTab = "urgent" | "active" | "completed";

export interface WorldQuestBoardModalProps {
  readonly data: WorldQuestBoardData;
  readonly actors: readonly WorldActorSpec[];
  readonly deps: TheWorldClientDeps;
  readonly onClose: () => void;
  readonly onVisitCommodore: (actorId: string) => void;
  readonly onOpenDialogue: (actorId: string) => void;
  readonly onInspectObjective: (commodoreActorId: string, objectiveId: string) => void;
}

/**
 * 다크 크리스탈 스타일 「제독 퀘스트 게시판」 모달 (`React.memo`).
 *
 * 중앙 광장의 3D 길드 게시판 또는 우측 상단 HUD 버튼으로 열리며,
 * 사령관 질문(`renderCommodoreAsks` 인라인 즉시 응답) · 권한 승인 대기 · 진행/검토/완료 작전을 한곳에서 관리한다.
 */
export const WorldQuestBoardModal = memo(function WorldQuestBoardModal({
  data,
  actors,
  deps,
  onClose,
  onVisitCommodore,
  onOpenDialogue,
  onInspectObjective,
}: WorldQuestBoardModalProps) {
  const t = getWorldT(deps.commodore.language());
  const [tab, setTab] = useState<QuestBoardTab>(() =>
    data.totalUrgentCount > 0 ? "urgent" : data.activeMissions.length > 0 ? "active" : "urgent",
  );

  // 질문이 있는 사령관 목록(중복 제거) — 인라인 `renderCommodoreAsks` 렌더링용
  const askCommodores = (() => {
    const seen = new Set<string>();
    const list: {
      readonly commodoreId: string;
      readonly actorId: string;
      readonly name: string;
      readonly actor: WorldActorSpec | null;
      readonly count: number;
    }[] = [];
    for (const ask of data.asks) {
      if (seen.has(ask.commodoreId)) continue;
      seen.add(ask.commodoreId);
      const actor = actors.find((a) => a.id === ask.commodoreActorId) ?? null;
      const count = data.asks.filter((item) => item.commodoreId === ask.commodoreId).length;
      list.push({
        commodoreId: ask.commodoreId,
        actorId: ask.commodoreActorId,
        name: ask.commodoreName,
        actor,
        count,
      });
    }
    return list;
  })();

  const tabs: readonly {
    readonly id: QuestBoardTab;
    readonly label: string;
    readonly icon: WorldIconName;
    readonly tone: WorldIconTone;
    readonly count: number;
    readonly urgent?: boolean;
  }[] = [
    {
      id: "urgent",
      label: t("theWorld.questBoard.tabUrgent"),
      icon: "bell",
      tone: "amber",
      count: data.totalUrgentCount,
      urgent: data.totalUrgentCount > 0,
    },
    {
      id: "active",
      label: t("theWorld.questBoard.tabActive"),
      icon: "questMap",
      tone: "cerulean",
      count: data.activeMissions.length,
    },
    {
      id: "completed",
      label: t("theWorld.questBoard.tabCompleted"),
      icon: "trophy",
      tone: "moss",
      count: data.completedMissions.length,
    },
  ];

  const renderMissionCard = (mission: WorldQuestMissionSummary, kind: "review" | "active" | "completed") => {
    const pct = mission.progressTotal > 0
      ? Math.round((mission.progressDone / mission.progressTotal) * 100)
      : kind === "completed" ? 100 : 0;
    return (
      <article
        key={mission.id}
        className={`the-world-qb-card is-${kind}`}
        data-tone={mission.commodoreTone}
      >
        <div className="the-world-qb-card-main">
          <div className="the-world-qb-card-title-row">
            <span className="the-world-tone-dot" data-tone={mission.commodoreTone} />
            <span className="the-world-qb-card-title">{mission.title}</span>
          </div>
          <div className="the-world-qb-card-meta">
            <span>{mission.commodoreName}</span>
            {mission.progressTotal > 0 ? (
              <span className="the-world-qb-progress-pill">
                {mission.progressDone}/{mission.progressTotal} ({pct}%)
              </span>
            ) : null}
          </div>
        </div>
        <div className="the-world-qb-card-actions">
          {mission.commodoreActorId ? (
            <button
              type="button"
              className="the-world-btn"
              aria-label={t("theWorld.questBoard.visitAria", { name: mission.commodoreName })}
              onClick={() => onVisitCommodore(mission.commodoreActorId!)}
            >
              <WorldIcon name="approach" size={13} tone="cerulean" />
              <span>{t("theWorld.questBoard.visitCommodore")}</span>
            </button>
          ) : null}
          {mission.commodoreActorId && mission.objectiveId ? (
            <button
              type="button"
              className="the-world-btn is-active"
              aria-label={t("theWorld.questBoard.inspectAria", { title: mission.title })}
              onClick={() => onInspectObjective(mission.commodoreActorId!, mission.objectiveId!)}
            >
              <WorldIcon name="inspect" size={13} tone="amber" />
              <span>{t("theWorld.questBoard.openMission")}</span>
            </button>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <div
      className="the-world-panel-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      <section
        className="the-world-panel the-world-quest-board"
        role="dialog"
        aria-modal="true"
        aria-label={t("theWorld.questBoard.aria")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />

        <header className="the-world-panel-head">
          <div className="the-world-dialogue-speaker">
            <div className="the-world-qb-emblem" aria-hidden="true">
              <WorldIcon name="questBoard" size={22} tone="amber" />
            </div>
            <div className="the-world-dialogue-meta">
              <div className="the-world-dialogue-name-row">
                <h2 className="the-world-dialogue-name">{t("theWorld.questBoard.title")}</h2>
                {data.totalUrgentCount > 0 ? (
                  <span className="the-world-dialogue-badge is-attention">
                    {t("theWorld.noticeBoard.urgentBadge", { count: data.totalUrgentCount })}
                  </span>
                ) : null}
              </div>
              <div className="the-world-dialogue-sub">{t("theWorld.questBoard.subtitle")}</div>
            </div>
          </div>

          <div className="the-world-dialogue-controls">
            <button
              type="button"
              className="the-world-btn"
              aria-label={t("theWorld.questBoard.closeAria")}
              onClick={onClose}
            >
              <WorldIcon name="close" size={14} />
            </button>
          </div>
        </header>

        <div className="the-world-panel-tabs" role="tablist" aria-label={t("theWorld.questBoard.tabsAria")}>
          {tabs.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`the-world-panel-tab${active ? " is-active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                <WorldIcon name={item.icon} size={14} tone={active ? "inherit" : item.tone} />
                <span>{item.label}</span>
                <span className={`the-world-qb-tab-count${item.urgent ? " is-urgent" : ""}`}>
                  {item.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="the-world-panel-body the-world-qb-body">
          {tab === "urgent" ? (
            data.totalUrgentCount === 0 ? (
              <div className="the-world-qb-empty">
                <WorldIcon name="trophy" size={24} tone="moss" />
                <span>{t("theWorld.questBoard.urgentEmpty")}</span>
              </div>
            ) : (
              <>
                {data.pendingApprovalsCount > 0 ? (
                  <div className="the-world-qb-section">
                    <h3 className="the-world-qb-section-title">
                      <WorldIcon name="warning" size={13} tone="warn" />
                      <span>{t("theWorld.questBoard.approvalsHeading")}</span>
                    </h3>
                    <div className="the-world-qb-approval-banner">
                      <span>
                        {t("theWorld.questBoard.approvalsDesc", { count: data.pendingApprovalsCount })}
                      </span>
                      <button
                        type="button"
                        className="the-world-btn is-attention"
                        onClick={deps.openApprovals}
                      >
                        <WorldIcon name="bell" size={13} tone="amber" />
                        <span>{t("theWorld.questBoard.openMission")}</span>
                      </button>
                    </div>
                  </div>
                ) : null}

                {askCommodores.length > 0 ? (
                  <div className="the-world-qb-section">
                    <h3 className="the-world-qb-section-title">
                      <WorldIcon name="question" size={13} tone="amber" />
                      <span>{t("theWorld.questBoard.asksHeading")}</span>
                    </h3>
                    <div className="the-world-qb-stack">
                      {askCommodores.map((entry) => (
                        <div key={entry.commodoreId} className="the-world-qb-ask-group">
                          <div className="the-world-qb-ask-head">
                            <div className="the-world-qb-ask-owner">
                              {entry.actor ? (
                                <MongleAvatar
                                  base={entry.actor.baseId}
                                  tone={entry.actor.tone}
                                  role={entry.actor.role}
                                  state={entry.actor.state}
                                  activity={entry.actor.activity}
                                  size={22}
                                  label={entry.name}
                                  decorative
                                />
                              ) : null}
                              <span className="the-world-qb-ask-name">{entry.name}</span>
                              <span className="the-world-qb-tab-count is-urgent">{entry.count}</span>
                            </div>
                            <div className="the-world-qb-card-actions">
                              <button
                                type="button"
                                className="the-world-btn"
                                aria-label={t("theWorld.questBoard.visitAria", { name: entry.name })}
                                onClick={() => onVisitCommodore(entry.actorId)}
                              >
                                <WorldIcon name="approach" size={12} tone="cerulean" />
                                <span>{t("theWorld.questBoard.visitCommodore")}</span>
                              </button>
                              <button
                                type="button"
                                className="the-world-btn"
                                onClick={() => onOpenDialogue(entry.actorId)}
                              >
                                <WorldIcon name="chat" size={12} tone="amber" />
                                <span>{t("theWorld.questBoard.openDialogue")}</span>
                              </button>
                            </div>
                          </div>
                          <div className="the-world-qb-ask-inline">
                            {deps.renderCommodoreAsks(entry.commodoreId)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {data.reviewMissions.length > 0 ? (
                  <div className="the-world-qb-section">
                    <h3 className="the-world-qb-section-title">
                      <WorldIcon name="inspect" size={13} tone="cerulean" />
                      <span>{t("theWorld.questBoard.reviewHeading")}</span>
                    </h3>
                    <div className="the-world-qb-stack">
                      {data.reviewMissions.map((m) => renderMissionCard(m, "review"))}
                    </div>
                  </div>
                ) : null}
              </>
            )
          ) : tab === "active" ? (
            data.activeMissions.length === 0 ? (
              <div className="the-world-qb-empty">
                <WorldIcon name="questMap" size={24} tone="cerulean" />
                <span>{t("theWorld.questBoard.activeEmpty")}</span>
              </div>
            ) : (
              <div className="the-world-qb-stack">
                {data.activeMissions.map((m) => renderMissionCard(m, "active"))}
              </div>
            )
          ) : data.completedMissions.length === 0 ? (
            <div className="the-world-qb-empty">
              <WorldIcon name="trophy" size={24} tone="amber" />
              <span>{t("theWorld.questBoard.completedEmpty")}</span>
            </div>
          ) : (
            <div className="the-world-qb-stack">
              {data.completedMissions.map((m) => renderMissionCard(m, "completed"))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
});
