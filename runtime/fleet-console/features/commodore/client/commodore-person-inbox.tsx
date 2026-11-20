/**
 * 사람 대기함 — 넘긴 기준·검토·후속과 사령관 질문을 입력창 위 독 안에 세운다(B+).
 *
 * 평소에는 입력창 위 한 줄(쿼터·진행 줄 자리)에 「결정 N · 가장 오래된 목표 · 종류」 칩만 보인다. 칩을 누르면 그 줄이 결정 한 줄이 되고
 * 입력창이 답 칸이 된다 — 한 번에 한 건, ‹ ›로 넘긴다. 제목(⌄)을 누를 때만 그 결정의 내용이 입력창 위 독 흐름 안에서 펼쳐져 독이 그만큼
 * 자라고 대화가 밀린다(대화 칸이 독 높이를 읽는 기존 길 그대로). 결정 요청이 도착하거나 칩·한 줄이 나타날 때는 아무것도 저절로 열리거나 밀리지 않는다.
 *
 * 이 파일은 상태와 조각(칩·줄·카드)을 만들어 주는 훅이다. 조각을 독의 어느 자리에 세울지는 표면이 정한다 — 그룹 대화 독
 * (`GroupConversation`의 `decision`)과 사령관 입력창(`CommodoreComposer`의 `decision`).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronGlyph } from "@fleet-console/ui/react";

import type { CommodoreInboxKind } from "../../objectives/shared/commodore-board-client.js";
import type { CommodoreAsk } from "../shared/contracts/types.js";
import { extendObjective, finishedObjectives, finishedObjectivesLoaded, loadFinishedObjectives, openObjectiveFromCluster, openObjectiveOnPhone, renderHandedFollowup, renderInboxDetail, renderInboxQuick, renderObjectiveAvatar, subscribeFinishedObjectivesStore, useObjectiveTheater } from "./board.js";
import { CommodoreAskCard } from "./commodore-ask.js";
import { sendComposerText } from "./commodore-composer-bridge.js";
import type { CommodoreDecisionTarget } from "./commodore-decision-target.js";
import { useCommodoreName } from "./commodore-name.js";
import { getT } from "./i18n/index.js";
import { answerCommodoreAsk, openAsks } from "./commodore-state.js";

type Kind = CommodoreInboxKind | "ask";
const KIND_ORDER: Record<Kind, number> = { criteria: 0, review: 1, followup: 2, ask: 3 };
const KIND_KEY = {
  criteria: "commodore.inbox.kind.criteria",
  review: "commodore.inbox.kind.review",
  followup: "commodore.inbox.kind.followup",
  ask: "commodore.inbox.kind.ask",
} as const;
/** 펼친 내용이 자라는 상한 — 대화 영역 높이의 몫. */
const CARD_CAP_RATIO = 0.4;
/** 접힘 전환(CSS `--duration-slow`)이 끝나기를 기다려 내용을 내린다. */
const FOLD_MS = 320;
/** 한 줄에 선택지 칩으로 두는 질문의 상한 — 그보다 많으면 펼친 카드에서 고른다. */
const QUICK_OPTION_MAX = 3;
/** 대화 영역을 이루는 칸 — 펼친 내용의 높이 상한은 이 칸의 몫이다. */
const HOST_SELECTOR = ".group-chat, .objectives-cm-fill, [data-decision-host]";

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

/** 표면이 독 안에 세울 조각. `engaged`면 `line`이 쿼터·진행 줄 자리를 차지하고, 아니면 `chip`이 그 줄 안에 선다. */
export interface CommodoreDecisionDock {
  readonly chip: ReactNode;
  readonly line: ReactNode;
  /** 제목을 눌러 펼친 내용 — 입력창 위 독 흐름 안. 접혀 있으면 null이다. */
  readonly card: ReactNode;
  readonly engaged: boolean;
  /** 입력창이 답 칸일 때 그 대상 — 한 줄이 열려 있는 동안만 있다. 같은 표면의 입력창에 넘긴다. */
  readonly target: CommodoreDecisionTarget | null;
}

export function useCommodoreDecisionDock({ theaterId, contextTheaterId = "", language, phone = false, leave, onEnded }: {
  readonly theaterId: string;
  readonly contextTheaterId?: string;
  readonly language: "en" | "ko";
  readonly phone?: boolean;
  readonly leave?: (run: () => void) => void;
  readonly onEnded?: (error: unknown) => void;
}): CommodoreDecisionDock | null {
  const t = getT(language);
  const name = useCommodoreName(theaterId, t);
  const board = useObjectiveTheater(theaterId);
  const asks = openAsks(theaterId);
  const finished = useSyncExternalStore(subscribeFinishedObjectivesStore, () => finishedObjectives(theaterId), () => finishedObjectives(theaterId));
  useEffect(() => { if (theaterId && !finishedObjectivesLoaded(theaterId)) loadFinishedObjectives(theaterId); }, [theaterId]);
  const [answered, setAnswered] = useState<readonly string[]>([]);
  // 기본은 칩이다. 사람이 눌러야 한 줄 결정이 되고, 항목이 하나뿐이어도 저절로 열지 않는다.
  const [engaged, setEngaged] = useState(false);
  const [detail, setDetail] = useState(false);
  const [focus, setFocus] = useState<{ readonly id: string | null; readonly index: number }>({ id: null, index: 0 });
  useEffect(() => { setAnswered([]); setEngaged(false); setDetail(false); setFocus({ id: null, index: 0 }); }, [theaterId]);

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

  // 지금 보는 결정 — 같은 결정을 id로 따라가고, 사라졌으면(답함) 있던 자리의 다음 결정으로 간다. 새 결정이 도착해도 보던 결정은 그대로다.
  const found = items.findIndex((item) => item.id === focus.id);
  const index = items.length === 0 ? 0 : found >= 0 ? found : Math.min(focus.index, items.length - 1);
  const current = items[index] ?? null;
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (currentId !== null && (focus.id !== currentId || focus.index !== index)) setFocus({ id: currentId, index });
  }, [currentId, index, focus.id, focus.index]);
  const empty = items.length === 0;
  useEffect(() => { if (empty) { setEngaged(false); setDetail(false); } }, [empty]);

  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const markAnswered = useCallback((id: string) => setAnswered((list) => list.includes(id) ? list : [...list, id]), []);

  // 입력창이 답 칸이 된다 — 보는 결정이 입력창의 대상이다. 질문 하나면 보낸 글이 그 직접 답, 그 밖은 결정을 인용한 일반 메시지다.
  const live = engaged && current ? current : null;
  const liveAsk = live?.ask ?? null;
  const liveId = live?.id ?? null;
  const liveKind = live?.kind ?? null;
  const liveTitle = live?.title ?? "";
  const liveReason = live?.reason ?? "";
  const liveObjectiveId = live?.objectiveId ?? null;
  const target = useMemo<CommodoreDecisionTarget | null>(() => {
    if (!liveId || !liveKind) return null;
    const kindLabel = t(KIND_KEY[liveKind]);
    // 입력창 글의 뜻은 여기 한 곳이 정한다 — 질문 하나면 직접 답, 그 밖은 결정을 인용한 일반 메시지(결정 상태는 그대로).
    const direct = liveAsk ? directAnswer(theaterId, liveAsk, markAnswered) : null;
    return {
      kindLabel,
      quote: {
        kind: "comment",
        excerpt: liveAsk ? liveAsk.questions.map((question) => question.text).join(" / ") : liveReason,
        source: { label: `${liveTitle} · ${kindLabel}`, ref: liveObjectiveId ? `objective:${liveObjectiveId}` : `ask:${liveAsk?.id ?? liveId}` },
      },
      answer: direct,
      placeholder: t(direct ? "commodore.decision.answerPlaceholder" : "commodore.decision.notePlaceholder"),
    };
  }, [theaterId, liveId, liveKind, liveAsk, liveTitle, liveReason, liveObjectiveId, markAnswered, t]);

  // 펼친 내용은 접힘 전환이 끝날 때까지 남겨 독이 부드럽게 줄어든다.
  const open = engaged && detail && current !== null;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) { setShown(true); return; }
    const timer = window.setTimeout(() => setShown(false), FOLD_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  const foldTimer = useRef<number | null>(null);
  useEffect(() => () => { if (foldTimer.current !== null) window.clearTimeout(foldTimer.current); }, []);

  if (!current) return null;

  const openObjective = (item: InboxItem) => {
    if (!item.objectiveId) return;
    const run = () => {
      if (phone) openObjectiveOnPhone(item.objectiveId!, item.theaterId);
      else openObjectiveFromCluster(item.theaterId, item.objectiveId!);
    };
    if (phone && leave) leave(run);
    else run();
  };
  const go = (step: number) => {
    const next = items[(index + step + items.length) % items.length];
    if (next) setFocus({ id: next.id, index: items.indexOf(next) });
  };
  const fold = () => {
    if (foldTimer.current !== null) window.clearTimeout(foldTimer.current);
    if (!detail) { setEngaged(false); return; }
    // 펼친 내용을 먼저 접어 독이 줄어든 뒤에 칩이 된다.
    setDetail(false);
    foldTimer.current = window.setTimeout(() => { foldTimer.current = null; setEngaged(false); }, FOLD_MS);
  };

  const oldest = items[0]!;
  const chip = engaged ? null : (
    <button type="button" className="commodore-decision-chip" onClick={() => { setEngaged(true); setDetail(false); }}>
      <span className="commodore-decision-chip-n">{t("commodore.decision.chip", { n: items.length })}</span>
      <span className="commodore-decision-chip-text">{`${oldest.title} · ${t(KIND_KEY[oldest.kind])}`}</span>
    </button>
  );

  const title = current.kind === "ask" && !current.objectiveId ? current.reason : `${current.title} · ${current.reason}`;
  const line = !engaged ? null : (
    <div className="commodore-decision-line">
      <span className="commodore-decision-nav">
        <button type="button" disabled={items.length < 2} aria-label={t("commodore.decision.prev")} onClick={() => go(-1)}>‹</button>
        <span>{`${index + 1}/${items.length}`}</span>
        <button type="button" disabled={items.length < 2} aria-label={t("commodore.decision.next")} onClick={() => go(1)}>›</button>
      </span>
      <span className={`commodore-decision-kind is-${current.kind}`}>{t(KIND_KEY[current.kind])}</span>
      <button type="button" className="commodore-decision-title" aria-expanded={open} onClick={() => setDetail((value) => !value)}>
        <span className="commodore-decision-title-text">{title}</span>
        <ChevronGlyph direction="down" className="commodore-decision-title-chev" />
      </button>
      <QuickAnswer key={current.id} item={current} theaterId={theaterId} language={language} phone={phone} onAnswered={markAnswered} onFailed={(error) => onEndedRef.current?.(error)} />
      <ExtendAction key={`extend:${current.id}`} item={current} theaterId={theaterId} language={language} onFailed={(error) => onEndedRef.current?.(error)} />
      <button type="button" className="commodore-decision-fold" aria-label={t("commodore.decision.fold")} onClick={fold}>✕</button>
    </div>
  );

  const card = !engaged ? null : (
    <div className={`commodore-decision-detail${open ? " is-open" : ""}`}>
      <div className="commodore-decision-detail-in">
        {shown ? (
          <DecisionCard item={current} theaterId={theaterId} contextTheaterId={contextTheaterId} language={language} phone={phone} leave={leave} onEnded={onEnded} onAnswered={markAnswered} openObjective={() => openObjective(current)} />
        ) : null}
      </div>
    </div>
  );

  return { chip, line, card, engaged, target };
}

/** 입력창 글이 질문의 직접 답이 되는 경우 — 문항이 하나인 질문뿐이다(서버가 모든 문항을 한 번에 받으므로 여럿이면 글로 답할 문항을 가를 수 없다). */
function directAnswer(theaterId: string, ask: CommodoreAsk, onAnswered: (id: string) => void): ((text: string) => Promise<void>) | null {
  const only = ask.questions.length === 1 ? ask.questions[0]! : null;
  if (!only) return null;
  return async (text) => {
    await answerCommodoreAsk(theaterId, ask.id, [{ questionId: only.id, selectedOptionIds: [], text }]);
    onAnswered(ask.id);
  };
}

/**
 * 한 줄에 두는 빠른 답 — 한 번에 끝나는 경우에만. 그 밖은 아무것도 그리지 않고, 제목을 눌러 펼친 카드에서 지금 동작 그대로 답한다.
 * 질문 선택지는 임의 문구라 아이콘으로 줄일 수 없어, 좁은 폭에서는 접혀(`is-option`) 제목 칸을 돌려주고 펼친 카드에서 답한다.
 */
function QuickAnswer({ item, theaterId, language, phone, onAnswered, onFailed }: {
  readonly item: InboxItem;
  readonly theaterId: string;
  readonly language: "en" | "ko";
  readonly phone: boolean;
  readonly onAnswered: (id: string) => void;
  readonly onFailed: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (item.kind === "ask") {
    const ask = item.ask;
    const question = ask && ask.questions.length === 1 ? ask.questions[0]! : null;
    if (!ask || !question || question.multiSelect || question.options.length < 2 || question.options.length > QUICK_OPTION_MAX) return null;
    const pick = (optionId: string) => {
      if (busy) return;
      setBusy(true);
      void answerCommodoreAsk(theaterId, ask.id, [{ questionId: question.id, selectedOptionIds: [optionId], text: "" }])
        .then(() => onAnswered(ask.id))
        .catch(onFailed)
        .finally(() => setBusy(false));
    };
    return (
      <>
        {question.options.map((option, position) => (
          <button key={option.id} type="button" className={`commodore-decision-quick is-option${position === 0 ? " is-primary" : ""}`} disabled={busy} onClick={() => pick(option.id)}>{option.label}</button>
        ))}
      </>
    );
  }
  if (!item.objectiveId || item.kind === "followup") return null;
  return <>{renderInboxQuick(item.objectiveId, item.kind, { language, phone, onFailed })}</>;
}

/**
 * 넘긴 검토의 「범위 넓히기」 — 입력창(답 칸)에 쓴 글을 한마디로 목표를 넓히고 계속 진행을 전한다. 글이 비어 있으면 아무것도 보내지 않고
 * 입력창으로 초점만 옮긴다. 보내기가 끝나면 입력창을 비우고, 실패는 빠른 답과 같은 길(`onFailed`)로 알린다. 한 줄의 높이는 그대로고,
 * 좁은 폭에서는 제목이 읽히도록 아이콘만 남는다(이름은 `aria-label`·`title`).
 */
export function ExtendAction({ item, theaterId, language, onFailed }: {
  readonly item: Pick<InboxItem, "kind" | "objectiveId">;
  readonly theaterId: string;
  readonly language: "en" | "ko";
  readonly onFailed: (error: unknown) => void;
}) {
  const t = getT(language);
  const [busy, setBusy] = useState(false);
  if (item.kind !== "review" || !item.objectiveId) return null;
  const objectiveId = item.objectiveId;
  const run = () => {
    if (busy) return;
    setBusy(true);
    void sendComposerText(theaterId, (context) => extendObjective(objectiveId, language, context)).catch(onFailed).finally(() => setBusy(false));
  };
  const label = t("commodore.decision.extend");
  return (
    <button type="button" className="commodore-decision-quick has-icon" disabled={busy} aria-busy={busy || undefined} aria-label={label} title={`${label} — ${t("commodore.decision.extendHint")}`} onClick={run}>
      <svg className="commodore-decision-quick-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8h11M5 5.5 2.5 8 5 10.5M11 5.5 13.5 8 11 10.5" /></svg>
      <span className="commodore-decision-quick-label">{label}</span>
    </button>
  );
}

/** 제목을 눌러 펼친 내용 — 머리(목표·대기 시간·목표 열기)와 그 결정의 처리 카드. 대화 영역 높이의 40%까지 자라고 그 안에서 스크롤한다. */
function DecisionCard({ item, theaterId, contextTheaterId, language, phone, leave, onEnded, onAnswered, openObjective }: {
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
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const card = ref.current;
    const host = card?.closest<HTMLElement>(HOST_SELECTOR);
    if (!card || !host) return;
    const measure = () => card.style.setProperty("--decision-cap", `${Math.round(host.clientHeight * CARD_CAP_RATIO)}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="commodore-decision-card">
      <div className="commodore-decision-card-head">
        {item.objectiveId ? <span className="commodore-person-inbox-avatar">{renderObjectiveAvatar(theaterId, item.objectiveId, 18)}</span> : null}
        <span className="commodore-decision-card-title">{item.title}</span>
        <span className="commodore-person-inbox-age">{waitLabel(t, item.at)}</span>
        {item.objectiveId ? <button type="button" className="group-chat-link commodore-person-inbox-open" onClick={openObjective}>{t("commodore.inbox.open")}</button> : null}
      </div>
      <InboxBody item={item} theaterId={theaterId} contextTheaterId={contextTheaterId} language={language} phone={phone} leave={leave} onEnded={onEnded} onAnswered={onAnswered} openObjective={openObjective} />
    </div>
  );
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
