import { useEffect, useState, useSyncExternalStore } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { loadCommodore, useCommodore } from "../../../commodore/client/commodore-state.js";
import { readCommodoreList, subscribeCommodoreList } from "../../../commodore/client/commodore-list.js";
import { focusObjective, readAllTheaters, subscribeObjective } from "../../../objectives/client/objectives-state.js";

import "./approval.css";
import { ApprovalActions, ApprovalCardFrame, ApprovalComputerCard, ApprovalDiff, DescriptionGlyph, IntelGlyph, LifeRing, announceText, approvalSecondsLeft, formatApprovalTime, toastText, useApprovalAnswer } from "./cards.js";
import { approvalAnnounce, approvalItems, approvalOpen, approvalToasts, closeApprovalList, installApprovals, subscribeApprovals, toggleApprovalList, type ApprovalItem } from "./store.js";

/** 데스크톱 오른쪽 위 캡슐. 새 요청이 와도 초점을 가져가지 않는다. */
export function ApprovalCapsule() {
  const t = useT();
  const open = useSyncExternalStore(subscribeApprovals, approvalOpen, approvalOpen);
  const items = useSyncExternalStore(subscribeApprovals, approvalItems, approvalItems);
  const clock = useClock(items.some((item) => item.expiresAt !== undefined));
  const urgent = items.filter((item) => item.expiresAt !== undefined).sort((a, b) => a.expiresAt! - b.expiresAt!)[0];
  const left = urgent ? approvalSecondsLeft(urgent.expiresAt, clock) : undefined;
  const low = left !== undefined && left <= 30;
  return (
    <button
      type="button"
      className={`approval-entry${items.length === 0 ? " is-idle" : ""}${urgent ? " is-urgent" : ""}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={t("approval.open")}
      onClick={() => toggleApprovalList()}
    >
      <BellGlyph />
      {items.length > 0 ? <span className="approval-count num">{items.length}</span> : null}
      {urgent && left !== undefined ? <><span className="approval-entry-sep" /><span className={`approval-entry-urgent${low ? " is-low" : ""}`}><LifeRing seconds={left} /><span className="num">{formatApprovalTime(left)}</span></span></> : null}
    </button>
  );
}

/** 목록·알림·낭독. 앱이 살아있는 동안 한 번 붙는다. */
export function ApprovalHost() {
  const t = useT();
  const open = useSyncExternalStore(subscribeApprovals, approvalOpen, approvalOpen);
  const toasts = useSyncExternalStore(subscribeApprovals, approvalToasts, approvalToasts);
  const announce = useSyncExternalStore(subscribeApprovals, approvalAnnounce, approvalAnnounce);
  useEffect(() => installApprovals(), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeApprovalList(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const live = announce.startsWith("notice:") ? "" : announce ? announceText(t, announce) : "";
  const toastLive = toasts.map((toast) => toastText(t, toast)).join(" ");
  return (
    <>
      <div className="approval-live" aria-live="polite">{live || toastLive}</div>
      {open ? <ApprovalList /> : null}
      {toasts.length > 0 ? <div className="approval-toasts" role="status">{toasts.map((toast) => <p key={toast.key}>{toastText(t, toast)}</p>)}</div> : null}
    </>
  );
}

function ApprovalList() {
  const t = useT();
  const items = useSyncExternalStore(subscribeApprovals, approvalItems, approvalItems);
  const now = useClock(items.some((item) => item.expiresAt !== undefined));
  const decisions = useSyncExternalStore(subscribeObjective, decisionRows, decisionRows);
  const urgent = items.filter((item) => item.type === "computer.use" && item.expiresAt !== undefined).sort((a, b) => a.expiresAt! - b.expiresAt!);
  const waiting = items.filter((item) => item.type !== "computer.use").sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="approval-surface" role="dialog" aria-modal="false" aria-labelledby="approval-surface-title">
      <header className="approval-surface-head">
        <h2 id="approval-surface-title">{t("approval.title")}</h2>
        <button type="button" className="approval-close" aria-label={t("approval.close")} onClick={() => closeApprovalList()}>✕</button>
      </header>
      <div className="approval-surface-scroll">
        {urgent.length === 0 && waiting.length === 0 ? <p className="approval-empty">{t("approval.empty")}</p> : null}
        {urgent.length > 0 ? (
          <section>
            <h3 className="approval-group">{t("approval.now")}<span>{t("approval.nowNote")}</span></h3>
            <div className="approval-stack">{urgent.map((item) => <ComputerRow key={item.id} item={item} now={now} />)}</div>
          </section>
        ) : null}
        {waiting.length > 0 ? (
          <section>
            <h3 className="approval-group">{t("approval.waiting")}<span>{t("approval.waitingNote")}</span></h3>
            <div className="approval-stack">{waiting.map((item) => item.type === "commodore.intel" ? <IntelRow key={item.id} item={item} /> : <DescriptionRow key={item.id} item={item} />)}</div>
          </section>
        ) : null}
        {decisions.length > 0 ? (
          <section>
            <h3 className="approval-group">{t("approval.decisions")}</h3>
            <div className="approval-stack">
              {decisions.map((row) => (
                <div className="approval-link" key={row.id}>
                  <span>{row.title}</span>
                  <button type="button" onClick={() => { closeApprovalList(); focusObjective(row.id); }}>{t("approval.decisionLink")}</button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ComputerRow({ item, now }: { readonly item: ApprovalItem; readonly now: number }) {
  const state = useConsoleState();
  const objectiveId = text(item.payload.objectiveId);
  const title = state.objectiveRecords.find((record) => record.id === objectiveId)?.title;
  if (item.expiresAt === undefined) return null;
  return <ApprovalComputerCard id={item.id} expiresAt={item.expiresAt} now={now} from={title} />;
}

function DescriptionRow({ item }: { readonly item: ApprovalItem }) {
  const t = useT();
  const targetId = text(item.payload.targetId);
  const proposed = text(item.payload.text);
  const commodore = useCommodore(targetId);
  const names = useSyncExternalStore(subscribeCommodoreList, readCommodoreList, readCommodoreList);
  useEffect(() => { if (targetId) void loadCommodore(targetId); }, [targetId]);
  const current = commodore.view?.state.description.text ?? "";
  const { pending, error, answer } = useApprovalAnswer(item.id);
  return (
    <ApprovalCardFrame
      titleId={`approval-desc-${item.id}`}
      glyph={<DescriptionGlyph />}
      title={t("approval.descTitle")}
      from={nameOf(names, text(item.payload.proposerId), targetId)}
      life={<span className="approval-card-life"><LifeRing /><span>{t("approval.until")}</span></span>}
      replaced={item.payload.replaced === true}
    >
      <ApprovalDiff now={current} after={proposed} nowLabel={t("approval.nowLabel")} afterLabel={t("approval.afterLabel")} none={t("approval.none")} />
      <ApprovalActions pending={pending} error={error} primary secondaryLabel={t("approval.reject")} primaryLabel={t("approval.approve")} onSecondary={answer("reject")} onPrimary={answer("approve")} effect={t("approval.descEffect")} />
    </ApprovalCardFrame>
  );
}

function IntelRow({ item }: { readonly item: ApprovalItem }) {
  const t = useT();
  const kind = item.payload.kind === "edit" || item.payload.kind === "remove" ? item.payload.kind : "add";
  const targetId = text(item.payload.targetId);
  const intelId = text(item.payload.intelId);
  const proposed = text(item.payload.text);
  const commodore = useCommodore(targetId);
  const names = useSyncExternalStore(subscribeCommodoreList, readCommodoreList, readCommodoreList);
  useEffect(() => { if (targetId) void loadCommodore(targetId); }, [targetId]);
  const current = commodore.view?.state.intel.find((entry) => entry.id === intelId)?.text ?? null;
  const { pending, error, answer } = useApprovalAnswer(item.id);
  const label = t(kind === "add" ? "approval.intelAdd" : kind === "edit" ? "approval.intelEdit" : "approval.intelRemove");
  return (
    <ApprovalCardFrame
      titleId={`approval-intel-${item.id}`}
      glyph={<IntelGlyph />}
      title={<>{t("approval.intelTitle")}<span className="approval-op">{label}</span></>}
      from={nameOf(names, text(item.payload.proposerId), targetId)}
      life={<span className="approval-card-life"><LifeRing /><span>{t("approval.until")}</span></span>}
      replaced={item.payload.replaced === true}
    >
      <ApprovalDiff
        now={kind === "add" ? null : current}
        after={kind === "remove" ? null : proposed}
        nowLabel={t("approval.nowLabel")}
        afterLabel={t("approval.afterLabel")}
        none={t("approval.none")}
      />
      <ApprovalActions
        pending={pending}
        error={error}
        primary={kind !== "remove"}
        secondaryLabel={t("approval.reject")}
        primaryLabel={t(kind === "remove" ? "approval.remove" : "approval.approve")}
        onSecondary={answer("reject")}
        onPrimary={answer("approve")}
        effect={t(kind === "add" ? "approval.intelAddEffect" : kind === "edit" ? "approval.intelEditEffect" : "approval.intelRemoveEffect")}
      />
    </ApprovalCardFrame>
  );
}

const NO_DECISIONS: readonly { readonly id: string; readonly title: string }[] = [];
let decisionSnapshot: readonly { readonly id: string; readonly title: string }[] = NO_DECISIONS;
let decisionKey = "";

/**
 * `useSyncExternalStore` 의 스냅숏은 내용이 같으면 같은 참조여야 한다.
 * 부를 때마다 새 배열을 돌려주면 렌더가 끝나지 않는다.
 */
function decisionRows(): readonly { readonly id: string; readonly title: string }[] {
  const rows: { id: string; title: string }[] = [];
  let key = "";
  for (const board of readAllTheaters()) {
    for (const objective of board.objectives) {
      if (!objective.decisionRequest || objective.done || objective.removed) continue;
      rows.push({ id: objective.id, title: objective.title });
      key += `${objective.id}\0${objective.title}\n`;
    }
  }
  if (key === decisionKey) return decisionSnapshot;
  decisionKey = key;
  decisionSnapshot = rows.length === 0 ? NO_DECISIONS : rows;
  return decisionSnapshot;
}

function nameOf(rows: readonly { readonly commodoreId: string; readonly alias?: string; readonly label: string }[], proposerId: string, targetId: string): string {
  const name = (id: string) => rows.find((row) => row.commodoreId === id)?.alias || rows.find((row) => row.commodoreId === id)?.label || id.slice(0, 8);
  return proposerId && targetId && proposerId !== targetId ? `${name(proposerId)} · ${name(targetId)}` : name(proposerId || targetId);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function BellGlyph() {
  return <svg className="approval-bell" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z" /><path d="M6.5 14h3" /></svg>;
}
