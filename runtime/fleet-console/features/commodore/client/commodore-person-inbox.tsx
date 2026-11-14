/**
 * 사람 대기함 — 넘긴 기준·검토·후속과 사령관 질문을 입력창 위에 겹쳐 둔다.
 * 로그 안에도, 높이를 재는 독 안에도 두지 않는다. 나타나거나 펼쳐져도 대화의 scrollTop은 그대로다.
 * 항목이 없으면 아무것도 그리지 않는다.
 */

import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { CommodoreInboxKind } from "../../objectives/shared/commodore-board-client.js";
import type { CommodoreAsk } from "../shared/contracts/types.js";
import { finishedObjectives, finishedObjectivesLoaded, loadFinishedObjectives, openObjectiveFromCluster, openObjectiveOnPhone, renderHandedFollowup, renderInboxDetail, renderObjectiveAvatar, subscribeFinishedObjectivesStore, useObjectiveTheater } from "./board.js";
import { CommodoreAskCard } from "./commodore-ask.js";
import { useCommodoreName } from "./commodore-name.js";
import { getT } from "./i18n/index.js";
import { openAsks } from "./commodore-state.js";

type Kind = CommodoreInboxKind | "ask";
const KIND_ORDER: Record<Kind, number> = { criteria: 0, review: 1, followup: 2, ask: 3 };
const KIND_KEY = {
  criteria: "commodore.inbox.kind.criteria",
  review: "commodore.inbox.kind.review",
  followup: "commodore.inbox.kind.followup",
  ask: "commodore.inbox.kind.ask",
} as const;

interface InboxItem {
  readonly id: string;
  readonly kind: Kind;
  readonly at: number;
  readonly reason: string;
  readonly title: string;
  readonly objectiveId: string | null;
  readonly theaterId: string;
  readonly ask?: CommodoreAsk;
}

export function CommodorePersonInbox({ theaterId, contextTheaterId = "", language, phone = false, anchor = false, leave, onEnded }: {
  readonly theaterId: string;
  readonly contextTheaterId?: string;
  readonly language: "en" | "ko";
  readonly phone?: boolean;
  readonly anchor?: boolean;
  readonly leave?: (run: () => void) => void;
  readonly onEnded?: (error: unknown) => void;
}) {
  const t = getT(language);
  const name = useCommodoreName(theaterId, t);
  const board = useObjectiveTheater(theaterId);
  const asks = openAsks(theaterId);
  const finished = useSyncExternalStore(subscribeFinishedObjectivesStore, () => finishedObjectives(theaterId), () => finishedObjectives(theaterId));
  useEffect(() => { if (theaterId && !finishedObjectivesLoaded(theaterId)) loadFinishedObjectives(theaterId); }, [theaterId]);
  const [answered, setAnswered] = useState<readonly string[]>([]);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [sheet, setSheet] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [heldSole, setHeldSole] = useState<string | null>(null);
  useEffect(() => { setAnswered([]); setFilter("all"); setSheet(false); setOpenId(null); setHeldSole(null); }, [theaterId]);

  const objectives = useMemo(() => {
    const seen = new Set(board.objectives.map((objective) => objective.id));
    return [...board.objectives, ...finished.filter((objective) => !seen.has(objective.id))];
  }, [board.objectives, finished]);
  const items = useMemo(() => {
    const rows: InboxItem[] = [];
    for (const objective of objectives) {
      for (const hold of objective.inboxHolds) {
        rows.push({ id: `${objective.id}:${hold.kind}`, kind: hold.kind, at: hold.at, reason: hold.reason, title: objective.title, objectiveId: objective.id, theaterId: objective.theaterId });
      }
    }
    for (const ask of asks) {
      if (answered.includes(ask.id)) continue;
      const objective = ask.objectiveId ? objectives.find((row) => row.id === ask.objectiveId) : undefined;
      rows.push({
        id: `ask:${ask.id}`,
        kind: "ask",
        at: ask.at,
        reason: ask.reason,
        title: objective?.title ?? name,
        objectiveId: objective?.id ?? null,
        theaterId: objective?.theaterId ?? contextTheaterId,
        ask,
      });
    }
    rows.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }, [objectives, asks, answered, name, contextTheaterId]);
  const counts = useMemo(() => {
    const tally: Record<Kind, number> = { criteria: 0, review: 0, followup: 0, ask: 0 };
    for (const item of items) tally[item.kind] += 1;
    return tally;
  }, [items]);
  const filtered = filter === "all" ? items : items.filter((item) => item.kind === filter);
  useEffect(() => {
    if (filter !== "all" && counts[filter] === 0) setFilter("all");
  }, [filter, counts]);
  const soleId = filtered.length === 1 ? filtered[0]!.id : null;
  useEffect(() => {
    if (!soleId) { setHeldSole(null); return; }
    if (heldSole === soleId) return;
    setSheet(true);
    setOpenId(soleId);
    setHeldSole(soleId);
  }, [soleId, heldSole]);
  if (items.length === 0) return null;

  const oldest = items[0]!;
  const openObjective = (item: InboxItem) => {
    if (!item.objectiveId) return;
    const run = () => {
      if (phone) openObjectiveOnPhone(item.objectiveId!, item.theaterId);
      else openObjectiveFromCluster(item.theaterId, item.objectiveId!);
    };
    if (phone && leave) leave(run);
    else run();
  };
  const kinds = (["criteria", "review", "followup", "ask"] as const).filter((kind) => counts[kind] > 0);

  return (
    <div className={`commodore-person-inbox${phone ? " is-phone" : ""}${anchor ? " is-anchored" : ""}`}>
      <div className="commodore-person-inbox-panel">
        <button
          type="button"
          className="commodore-person-inbox-bar"
          aria-expanded={sheet}
          onClick={() => setSheet((open) => !open)}
        >
          <span className="commodore-person-inbox-count">{t("commodore.inbox.waiting", { n: items.length })}</span>
          {!sheet ? (
            <>
              <span className="commodore-person-inbox-oldest">{`${oldest.title} · ${t(KIND_KEY[oldest.kind])} · ${oldest.reason}`}</span>
              <span className="commodore-person-inbox-age">{waitLabel(t, oldest.at)}</span>
            </>
          ) : null}
        </button>
        {sheet ? (
          <>
            <div className="commodore-person-inbox-filters" role="toolbar" aria-label={t("commodore.inbox.filter")}>
              <FilterChip label={t("commodore.inbox.kind.all", { n: items.length })} pressed={filter === "all"} onClick={() => setFilter("all")} />
              {kinds.map((kind) => <FilterChip key={kind} label={t("commodore.inbox.kind.count", { kind: t(KIND_KEY[kind]), n: counts[kind] })} pressed={filter === kind} onClick={() => setFilter(kind)} />)}
            </div>
            <div className="commodore-person-inbox-list">
              {filtered.map((item) => {
                const open = openId === item.id;
                return (
                  <Fragment key={item.id}>
                    <div className={`commodore-person-inbox-row${open ? " is-open" : ""}`}>
                      <button type="button" className="commodore-person-inbox-row-main" aria-expanded={open} onClick={() => setOpenId(open ? null : item.id)}>
                        <span className="commodore-person-inbox-lead">
                          {item.objectiveId ? <span className="commodore-person-inbox-avatar">{renderObjectiveAvatar(theaterId, item.objectiveId, 18)}</span> : null}
                          <span className="commodore-person-inbox-title">{item.title}</span>
                          <span className="commodore-person-inbox-age">{waitLabel(t, item.at)}</span>
                        </span>
                        <span className="commodore-person-inbox-meta">
                          <span className={`commodore-person-inbox-kind is-${item.kind}`}>{t(KIND_KEY[item.kind])}</span>
                          <span className="commodore-person-inbox-reason">{item.reason}</span>
                        </span>
                      </button>
                      {item.objectiveId ? <button type="button" className="group-chat-link commodore-person-inbox-open" onClick={() => openObjective(item)}>{t("commodore.inbox.open")}</button> : null}
                    </div>
                    {open ? <InboxBody item={item} theaterId={theaterId} contextTheaterId={contextTheaterId} language={language} phone={phone} leave={leave} onEnded={onEnded} onAnswered={(id) => setAnswered((current) => current.includes(id) ? current : [...current, id])} openObjective={() => openObjective(item)} /> : null}
                  </Fragment>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function FilterChip({ label, pressed, onClick }: { readonly label: string; readonly pressed: boolean; readonly onClick: () => void }) {
  return <button type="button" className={`commodore-person-inbox-chip${pressed ? " is-on" : ""}`} aria-pressed={pressed} onClick={onClick}>{label}</button>;
}

function InboxBody({ item, theaterId, contextTheaterId, language, phone, leave, onEnded, onAnswered, openObjective }: {
  readonly item: InboxItem;
  readonly theaterId: string;
  readonly contextTheaterId: string;
  readonly language: "en" | "ko";
  readonly phone: boolean;
  readonly leave: ((run: () => void) => void) | undefined;
  readonly onEnded: ((error: unknown) => void) | undefined;
  readonly onAnswered: (id: string) => void;
  readonly openObjective: () => void;
}) {
  const t = getT(language);
  if (item.kind === "ask" && item.ask) {
    return <CommodoreAskCard ask={item.ask} theaterId={theaterId} contextTheaterId={contextTheaterId} t={t} language={language} phone={phone} leave={leave} onEnded={onEnded} onAnswered={onAnswered} />;
  }
  if (!item.objectiveId || item.kind === "ask") return null;
  if (item.kind === "followup") return <>{renderHandedFollowup(item.objectiveId, { language, phone, open: openObjective })}</>;
  return <>{renderInboxDetail(item.objectiveId, item.kind, { language, phone })}</>;
}

function waitLabel(t: ReturnType<typeof getT>, at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return t("commodore.inbox.wait.now");
  if (minutes < 60) return t("commodore.inbox.wait.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("commodore.inbox.wait.hours", { n: hours });
  return t("commodore.inbox.wait.days", { n: Math.round(hours / 24) });
}
