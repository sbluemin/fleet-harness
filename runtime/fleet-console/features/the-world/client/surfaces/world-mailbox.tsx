import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useMemo, useState } from "react";

import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import type {
  WorldQuestAskSummary,
  WorldQuestBoardData,
  WorldSnapshot,
  WorldVillageSpec,
} from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT } from "../i18n/index.js";
import { markMailboxRead, useMailboxReadKeys } from "../world-store.js";
import { WorldIcon } from "./world-icons.js";

export interface WorldMailboxItem {
  readonly key: string;
  readonly kind: "completed" | "report";
  readonly title: string;
  readonly summary: string;
  readonly commodoreId?: string | undefined;
  readonly commodoreName: string;
  readonly commodoreTone: IdentityTone;
  readonly actorId?: string | undefined;
  readonly villageId?: string | undefined;
  readonly at: number;
}

export interface WorldMailboxProps {
  readonly open: boolean;
  readonly locale: ConsoleLocale | undefined;
  readonly questData: WorldQuestBoardData;
  readonly snapshot: WorldSnapshot;
  readonly deps?: TheWorldClientDeps | undefined;
  readonly reportItems?: readonly WorldMailboxItem[] | undefined;
  readonly onAnswerAsk?: ((ask: WorldQuestAskSummary, answerText: string) => Promise<boolean> | boolean | void) | undefined;
  readonly onWarpToVillage?: ((village: WorldVillageSpec) => void) | undefined;
  readonly onOpenDialogue?: ((actorId: string) => void) | undefined;
  readonly onClose: () => void;
}

export function mailboxMissionKey(missionId: string): string {
  return `mission:${missionId}`;
}

export function mailboxReportKey(reportKey: string): string {
  return `report:${reportKey}`;
}

/**
 * 미확인 우편 개수 계산기 (HUD 배지 · 3D 빨간 깃발 · 우체통 모달 공통 기준).
 * - 결재 대기 질문(`asks`)과 승인 대기(`pendingApprovalsCount`)는 처리 완료 전까지 항상 미확인으로 집계한다.
 * - 완료 작전(`completedMissions`) 및 사령관 보고(`reportItems`)는 `readKeys`에 없을 때만 미확인으로 집계한다.
 */
export function computeMailboxUnreadCount(
  questData: WorldQuestBoardData,
  readKeys: readonly string[],
  reportItems?: readonly WorldMailboxItem[],
): number {
  const readSet = new Set(readKeys);
  let count = questData.asks.length + questData.pendingApprovalsCount;
  for (const mission of questData.completedMissions) {
    if (!readSet.has(mailboxMissionKey(mission.id))) {
      count += 1;
    }
  }
  if (reportItems) {
    for (const item of reportItems) {
      if (!readSet.has(mailboxReportKey(item.key))) {
        count += 1;
      }
    }
  }
  return count;
}

function formatRelativeTime(timestamp: number, isEn: boolean): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return isEn ? "Just now" : "방금 전";
  }
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return isEn ? "Just now" : "방금 전";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return isEn ? `${diffMin}m ago` : `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return isEn ? `${diffHr}h ago` : `${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  return isEn ? `${diffDay}d ago` : `${diffDay}일 전`;
}

/**
 * 다크 크리스탈 Starlight Glass 「함대 우체통」 모달 (`React.memo`).
 *
 * - 섹션 1: 결재 대기 편지 (사령관 Pending Asks 1클릭 응답 + 실행 승인 바로가기)
 * - 섹션 2: 부재중 함대 소식 (완료된 작전 + 사령관 최근 보고, 읽음 처리 · 마을 이동 · 대화)
 */
export const WorldMailbox = memo(function WorldMailbox({
  open,
  locale,
  questData,
  snapshot,
  deps,
  reportItems,
  onAnswerAsk,
  onWarpToVillage,
  onOpenDialogue,
  onClose,
}: WorldMailboxProps) {
  const t = getWorldT(locale);
  const isEn = locale === "en";
  const bi = (ko: string, en: string) => (isEn ? en : ko);
  const readKeys = useMailboxReadKeys();
  const readKeySet = useMemo(() => new Set(readKeys), [readKeys]);
  const [askDrafts, setAskDrafts] = useState<Readonly<Record<string, string>>>({});
  const [sendingAskId, setSendingAskId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  const villageByCommodoreId = useMemo(() => {
    const map = new Map<string, WorldVillageSpec>();
    for (const v of snapshot.villages) {
      map.set(v.commodoreId, v);
    }
    return map;
  }, [snapshot.villages]);

  const villageById = useMemo(() => {
    const map = new Map<string, WorldVillageSpec>();
    for (const v of snapshot.villages) {
      map.set(v.id, v);
    }
    return map;
  }, [snapshot.villages]);

  const askCommodores = useMemo(() => {
    const seen = new Set<string>();
    const groups: {
      readonly commodoreId: string;
      readonly actorId: string;
      readonly name: string;
      readonly tone: IdentityTone;
      readonly asks: readonly WorldQuestAskSummary[];
    }[] = [];
    for (const ask of questData.asks) {
      if (seen.has(ask.commodoreId)) continue;
      seen.add(ask.commodoreId);
      const groupAsks = questData.asks.filter((item) => item.commodoreId === ask.commodoreId);
      groups.push({
        commodoreId: ask.commodoreId,
        actorId: ask.commodoreActorId,
        name: ask.commodoreName,
        tone: ask.commodoreTone,
        asks: groupAsks,
      });
    }
    return groups;
  }, [questData.asks]);

  const newsItems = useMemo<readonly WorldMailboxItem[]>(() => {
    const list: WorldMailboxItem[] = [];
    for (const mission of questData.completedMissions) {
      list.push({
        key: mailboxMissionKey(mission.id),
        kind: "completed",
        title: mission.title,
        summary: mission.progressTotal > 0
          ? bi(
            `작전 완료 (${mission.progressDone}/${mission.progressTotal})`,
            `Mission completed (${mission.progressDone}/${mission.progressTotal})`,
          )
          : bi("작전이 성공적으로 완료되었습니다.", "Operation completed successfully."),
        commodoreId: mission.commodoreId ?? undefined,
        commodoreName: mission.commodoreName,
        commodoreTone: mission.commodoreTone,
        actorId: mission.commodoreActorId ?? undefined,
        at: mission.doneAt ?? mission.activityAt,
      });
    }
    if (reportItems) {
      for (const item of reportItems) {
        list.push({
          ...item,
          key: mailboxReportKey(item.key),
        });
      }
    }
    list.sort((a, b) => b.at - a.at);
    return list;
  }, [questData.completedMissions, reportItems, isEn]);

  const unreadNewsKeys = useMemo(
    () => newsItems.filter((item) => !readKeySet.has(item.key)).map((item) => item.key),
    [newsItems, readKeySet],
  );

  const totalUnread = questData.asks.length + questData.pendingApprovalsCount + unreadNewsKeys.length;
  const isEmpty =
    questData.asks.length === 0
    && questData.pendingApprovalsCount === 0
    && newsItems.length === 0;

  if (!open) return null;

  const findVillage = (commodoreId?: string, villageId?: string): WorldVillageSpec | null => {
    if (villageId) {
      const byId = villageById.get(villageId);
      if (byId) return byId;
    }
    if (commodoreId) {
      return villageByCommodoreId.get(commodoreId) ?? null;
    }
    return null;
  };

  const handleFallbackAskSubmit = async (ask: WorldQuestAskSummary) => {
    const text = (askDrafts[ask.id] ?? "").trim();
    if (!text || sendingAskId) return;
    setSendingAskId(ask.id);
    try {
      let ok = false;
      if (onAnswerAsk) {
        const res = await onAnswerAsk(ask, text);
        ok = res !== false;
      } else if (deps) {
        const res = await deps.sendMessageToCommodore(ask.commodoreId, text);
        ok = res.ok;
      }
      if (ok) {
        setAskDrafts((prev) => ({ ...prev, [ask.id]: "" }));
      }
    } finally {
      setSendingAskId(null);
    }
  };

  const modalAria = bi("함대 우체통", "Fleet Mailbox");
  const markAllLabel = bi("모두 읽음", "Mark all read");
  const warpBtnLabel = bi("마을로 이동", "Warp to village");
  const talkBtnLabel = t("theWorld.questBoard.openDialogue");
  const replyPlaceholder = bi("빠른 답변을 입력하세요...", "Type a quick reply...");

  return (
    <div
      className="the-world-panel-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      <section
        className="the-world-panel the-world-mailbox-modal"
        role="dialog"
        aria-modal="true"
        aria-label={modalAria}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />

        <header className="the-world-panel-head">
          <div className="the-world-dialogue-speaker">
            <div className="the-world-qb-emblem" aria-hidden="true">
              <WorldIcon name="mail" size={22} tone="amber" />
            </div>
            <div className="the-world-dialogue-meta">
              <div className="the-world-dialogue-name-row">
                <h2 className="the-world-dialogue-name">{bi("함대 우체통", "Fleet Mailbox")}</h2>
                {totalUnread > 0 ? (
                  <span className="the-world-dialogue-badge is-attention">
                    {bi(`미확인 ${totalUnread}`, `${totalUnread} unread`)}
                  </span>
                ) : null}
              </div>
              <div className="the-world-dialogue-sub">
                {bi(
                  "부재중 도착한 사령관 보고서와 결재 대기 편지를 확인하세요",
                  "Review Commodore reports, completed ops, and pending decisions",
                )}
              </div>
            </div>
          </div>

          <div className="the-world-dialogue-controls">
            {unreadNewsKeys.length > 0 ? (
              <button
                type="button"
                className="the-world-btn"
                aria-label={markAllLabel}
                onClick={() => {
                  playDistrictSelect();
                  markMailboxRead(unreadNewsKeys);
                }}
              >
                <WorldIcon name="sparkle" size={13} tone="teal" />
                <span>{markAllLabel}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="the-world-btn"
              aria-label={t("theWorld.panel.closeAria")}
              onClick={onClose}
            >
              <WorldIcon name="close" size={14} />
            </button>
          </div>
        </header>

        <div className="the-world-panel-body the-world-mailbox-body">
          {isEmpty ? (
            <div className="the-world-mailbox-empty">
              <div className="the-world-mailbox-empty-icon" aria-hidden="true">
                <WorldIcon name="mail" size={28} tone="teal" />
              </div>
              <p className="the-world-mailbox-empty-title">
                {bi("우체통이 깨끗합니다", "Your mailbox is clear")}
              </p>
              <p className="the-world-mailbox-empty-desc">
                {bi(
                  "결재 대기 편지나 새로운 보고서가 도착하면 중앙 광장 우체통의 빨간 깃발이 올라갑니다.",
                  "When Commodores finish operations or need your decision, the plaza mailbox flag will rise.",
                )}
              </p>
            </div>
          ) : (
            <>
              {/* 섹션 1: 결재 대기 편지 (Pending Asks & Approvals) */}
              {(askCommodores.length > 0 || questData.pendingApprovalsCount > 0) ? (
                <section className="the-world-mailbox-section">
                  <h3 className="the-world-mailbox-section-title">
                    <WorldIcon name="bell" size={13} tone="amber" />
                    <span>{bi("결재 대기 편지", "Pending Decisions")}</span>
                    <span className="the-world-qb-tab-count is-urgent">
                      {questData.asks.length + questData.pendingApprovalsCount}
                    </span>
                  </h3>

                  {questData.pendingApprovalsCount > 0 && deps ? (
                    <div className="the-world-qb-approval-banner">
                      <span>
                        {t("theWorld.questBoard.approvalsDesc", { count: questData.pendingApprovalsCount })}
                      </span>
                      <button
                        type="button"
                        className="the-world-btn is-attention"
                        onClick={() => {
                          onClose();
                          deps.openApprovals();
                        }}
                      >
                        <WorldIcon name="bell" size={13} tone="amber" />
                        <span>{t("theWorld.questBoard.openMission")}</span>
                      </button>
                    </div>
                  ) : null}

                  <div className="the-world-mailbox-list">
                    {askCommodores.map((group) => {
                      const village = findVillage(group.commodoreId);
                      return (
                        <article key={group.commodoreId} className="the-world-mailbox-card is-urgent">
                          <div className="the-world-mailbox-card-head">
                            <div className="the-world-mailbox-card-owner">
                              <span className="the-world-tone-dot" data-tone={group.tone} />
                              <span className="the-world-mailbox-card-name">{group.name}</span>
                              <span className="the-world-qb-tab-count is-urgent">{group.asks.length}</span>
                            </div>
                            <div className="the-world-mailbox-card-actions">
                              {village && onWarpToVillage ? (
                                <button
                                  type="button"
                                  className="the-world-btn"
                                  onClick={() => {
                                    playDistrictSelect();
                                    onClose();
                                    onWarpToVillage(village);
                                  }}
                                >
                                  <WorldIcon name="compass" size={12} tone="cerulean" />
                                  <span>{warpBtnLabel}</span>
                                </button>
                              ) : null}
                              {onOpenDialogue ? (
                                <button
                                  type="button"
                                  className="the-world-btn"
                                  onClick={() => {
                                    playDistrictSelect();
                                    onClose();
                                    onOpenDialogue(group.actorId);
                                  }}
                                >
                                  <WorldIcon name="chat" size={12} tone="amber" />
                                  <span>{talkBtnLabel}</span>
                                </button>
                              ) : null}
                            </div>
                          </div>

                          {deps ? (
                            <div className="the-world-qb-ask-inline">
                              {deps.renderCommodoreAsks(group.commodoreId)}
                            </div>
                          ) : (
                            <div className="the-world-mailbox-ask-fallbacks">
                              {group.asks.map((ask) => (
                                <div key={ask.id} className="the-world-mailbox-ask-row">
                                  <p className="the-world-mailbox-ask-text">
                                    {ask.firstQuestion || ask.reason}
                                  </p>
                                  <form
                                    className="the-world-mailbox-ask-form"
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      void handleFallbackAskSubmit(ask);
                                    }}
                                  >
                                    <input
                                      type="text"
                                      className="the-world-input"
                                      value={askDrafts[ask.id] ?? ""}
                                      placeholder={replyPlaceholder}
                                      disabled={sendingAskId === ask.id}
                                      onChange={(e) =>
                                        setAskDrafts((prev) => ({ ...prev, [ask.id]: e.target.value }))
                                      }
                                    />
                                    <button
                                      type="submit"
                                      className="the-world-btn is-active"
                                      disabled={sendingAskId === ask.id || !(askDrafts[ask.id] ?? "").trim()}
                                    >
                                      {t("theWorld.rpg.send")}
                                    </button>
                                  </form>
                                </div>
                              ))}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {/* 섹션 2: 부재중 함대 소식 (완료된 작전 + 최근 보고) */}
              {newsItems.length > 0 ? (
                <section className="the-world-mailbox-section">
                  <h3 className="the-world-mailbox-section-title">
                    <WorldIcon name="scroll" size={13} tone="teal" />
                    <span>{bi("부재중 함대 소식", "Fleet Reports & Completed Ops")}</span>
                    <span className="the-world-qb-tab-count">{newsItems.length}</span>
                  </h3>

                  <div className="the-world-mailbox-list">
                    {newsItems.map((item) => {
                      const unread = !readKeySet.has(item.key);
                      const village = findVillage(item.commodoreId, item.villageId);
                      return (
                        <article
                          key={item.key}
                          className={`the-world-mailbox-item${unread ? " is-unread" : ""}`}
                          onClick={() => {
                            if (unread) markMailboxRead([item.key]);
                          }}
                        >
                          <div className="the-world-mailbox-item-main">
                            <div className="the-world-mailbox-item-head">
                              {unread ? <span className="the-world-mailbox-unread-dot" aria-hidden="true" /> : null}
                              <span className="the-world-tone-dot" data-tone={item.commodoreTone} />
                              <span className="the-world-mailbox-item-title">{item.title}</span>
                              <span className="the-world-mailbox-item-time">
                                {formatRelativeTime(item.at, isEn)}
                              </span>
                            </div>
                            <p className="the-world-mailbox-item-summary">
                              <strong className="the-world-mailbox-item-sender">{item.commodoreName}</strong>
                              {" · "}
                              {item.summary}
                            </p>
                          </div>

                          <div className="the-world-mailbox-item-actions">
                            {village && onWarpToVillage ? (
                              <button
                                type="button"
                                className="the-world-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (unread) markMailboxRead([item.key]);
                                  playDistrictSelect();
                                  onClose();
                                  onWarpToVillage(village);
                                }}
                              >
                                <WorldIcon name="compass" size={12} tone="cerulean" />
                                <span>{warpBtnLabel}</span>
                              </button>
                            ) : null}
                            {item.actorId && onOpenDialogue ? (
                              <button
                                type="button"
                                className="the-world-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (unread) markMailboxRead([item.key]);
                                  playDistrictSelect();
                                  onClose();
                                  onOpenDialogue(item.actorId!);
                                }}
                              >
                                <WorldIcon name="chat" size={12} tone="amber" />
                                <span>{talkBtnLabel}</span>
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
});
