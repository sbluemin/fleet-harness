import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { loadCommodore, useCommodore } from "../../../commodore/client/commodore-state.js";
import { readCommodoreList, subscribeCommodoreList } from "../../../commodore/client/commodore-list.js";

import { NATIVE_VIEW_COVER_ATTRIBUTE } from "@fleet-console/ui/native-view";

import "./approval.css";
import { ApprovalActions, ApprovalCardFrame, ApprovalComputerCard, ApprovalDiff, DescriptionGlyph, IntelGlyph, LifeRing, announceText, approvalSecondsLeft, formatApprovalTime, toastText, useApprovalAnswer } from "./cards.js";
import { approvalAnnounce, approvalArrival, approvalItems, approvalOpen, approvalToasts, closeApprovalList, installApprovals, subscribeApprovals, toggleApprovalList, type ApprovalItem } from "./store.js";

/** 데스크톱 오른쪽 위 캡슐. 새 요청이 와도 초점을 가져가지 않는다. */
export function ApprovalCapsule() {
  const t = useT();
  const open = useSyncExternalStore(subscribeApprovals, approvalOpen, approvalOpen);
  const items = useSyncExternalStore(subscribeApprovals, approvalItems, approvalItems);
  const pending = items.length;
  const clock = useClock(items.some((item) => item.expiresAt !== undefined));
  const urgent = items.filter((item) => item.expiresAt !== undefined).sort((a, b) => a.expiresAt! - b.expiresAt!)[0];
  const left = urgent ? approvalSecondsLeft(urgent.expiresAt, clock) : undefined;
  const low = left !== undefined && left <= 30;
  const arrive = useArrivalSwing(items);
  return (
    <button
      type="button"
      className={`approval-entry${pending === 0 ? " is-idle" : ""}${urgent ? " is-urgent" : ""}${arrive ? " is-arrive" : ""}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={pending === 0
        ? t("approval.capsuleAriaEmpty")
        : left !== undefined
          ? t("approval.capsuleAriaUrgent", { count: String(pending), time: formatApprovalTime(left) })
          : t("approval.capsuleAriaCount", { count: String(pending) })}
      onClick={() => toggleApprovalList()}
    >
      <BellGlyph />
      {pending > 0 ? <span className="approval-count num">{pending}</span> : null}
      {urgent && left !== undefined ? <><span className="approval-entry-sep" /><span className={`approval-entry-urgent${low ? " is-low" : ""}`}><LifeRing seconds={left} /><span>{t("approval.capsuleUrgent")}</span><span className="num">{formatApprovalTime(left)}</span></span></> : null}
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
  const urgent = items.filter((item) => item.type === "computer.use" && item.expiresAt !== undefined).sort((a, b) => a.expiresAt! - b.expiresAt!);
  const waiting = items.filter((item) => item.type !== "computer.use").sort((a, b) => a.createdAt - b.createdAt);
  const panelRef = useRef<HTMLDivElement>(null);
  const nibRef = useRef<HTMLSpanElement>(null);
  useAnchoredApprovalSurface(panelRef, nibRef);
  return (
    <div ref={panelRef} className="approval-surface" role="dialog" aria-modal="false" {...{ [NATIVE_VIEW_COVER_ATTRIBUTE]: "" }} aria-labelledby="approval-surface-title">
      <span ref={nibRef} className="approval-nib" aria-hidden="true" />
      <header className="approval-surface-head">
        <h2 id="approval-surface-title">{t("approval.title")}</h2>
        {items.length > 0 ? <p className="approval-surface-sub">{t("approval.headCount", { count: String(items.length) })}</p> : null}
        <button type="button" className="approval-close" aria-label={t("approval.close")} onClick={() => closeApprovalList()}>✕</button>
      </header>
      <div className="approval-surface-scroll">
        {urgent.length === 0 && waiting.length === 0 ? <div className="approval-empty"><strong>{t("approval.empty")}</strong><p>{t("approval.emptyMore")}</p></div> : null}
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
      </div>
    </div>
  );
}

function ComputerRow({ item, now }: { readonly item: ApprovalItem; readonly now: number }) {
  const objectiveId = text(item.payload.objectiveId);
  if (item.expiresAt === undefined || !objectiveId) return null;
  return <ApprovalComputerCard id={item.id} objectiveId={objectiveId} expiresAt={item.expiresAt} now={now} />;
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
      from={nameOf(t, names, text(item.payload.proposerId), targetId)}
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
      from={nameOf(t, names, text(item.payload.proposerId), targetId)}
      life={<span className="approval-card-life"><LifeRing /><span>{t("approval.until")}</span></span>}
      replaced={item.payload.replaced === true}
    >
      <ApprovalDiff
        now={kind === "add" ? null : current}
        after={kind === "remove" ? null : proposed}
        nowLabel={t("approval.nowLabel")}
        afterLabel={t("approval.afterLabel")}
        none={t("approval.none")}
        afterNone={kind === "remove" ? t("approval.noneRemoved") : undefined}
      />
      <ApprovalActions
        pending={pending}
        error={error}
        primary={kind !== "remove"}
        secondaryLabel={t("approval.reject")}
        primaryLabel={t(kind === "remove" ? "approval.remove" : "approval.approve")}
        onSecondary={answer("reject")}
        onPrimary={answer("approve")}
        effect={t(kind === "add" ? "approval.intelAddEffect" : kind === "edit" ? "approval.intelEditEffect" : "approval.intelRemoveEffect", { name: commodoreName(names, targetId) })}
      />
    </ApprovalCardFrame>
  );
}

function commodoreName(rows: readonly { readonly commodoreId: string; readonly alias?: string; readonly label: string }[], id: string): string {
  return rows.find((row) => row.commodoreId === id)?.alias || rows.find((row) => row.commodoreId === id)?.label || (id ? id.slice(0, 8) : "");
}

function nameOf(t: (key: "approval.proposerTo" | "approval.targetCommodore", values?: { readonly from?: string; readonly to?: string; readonly name?: string }) => string, rows: readonly { readonly commodoreId: string; readonly alias?: string; readonly label: string }[], proposerId: string, targetId: string): string {
  return t("approval.proposerTo", { from: commodoreName(rows, proposerId), to: t("approval.targetCommodore", { name: commodoreName(rows, targetId) }) });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const ANCHOR_EDGE = 8;
const NIB = 10;
const MOBILE_LAYOUT = "(max-width: 420px)";

/**
 * 보이는 `.approval-entry` 중 뷰포트와 가장 많이 겹치는 버튼.
 * 마운트된 버튼이 없으면 null — 패널은 스타일시트의 fixed 위치로 남는다.
 */
function visibleApprovalEntry(): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(".approval-entry");
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const node of nodes) {
    const box = node.getBoundingClientRect();
    const width = Math.min(box.right, window.innerWidth) - Math.max(box.left, 0);
    const height = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
    const area = Math.max(0, width) * Math.max(0, height);
    if (area > bestArea) {
      best = node;
      bestArea = area;
    }
  }
  return best;
}

function clearAnchor(panel: HTMLElement, nib: HTMLElement): void {
  panel.classList.remove("is-anchored");
  panel.style.top = "";
  panel.style.right = "";
  panel.style.left = "";
  nib.style.right = "";
}

/**
 * 패널 오른쪽 끝을 벨 오른쪽 끝에 맞추고, 위는 벨 아래 8px.
 * 왼쪽이 8px보다 좁아지면 안쪽으로 민다. 꼬리는 밀린 뒤에도 벨 가운데를 가리킨다.
 * 사이드바 폭 전환과 창 크기 변화는 열린 동안 매 프레임 다시 읽는다.
 * 420px 이하(모바일 레이아웃)는 손대지 않는다.
 */
function useAnchoredApprovalSurface(panelRef: RefObject<HTMLDivElement | null>, nibRef: RefObject<HTMLSpanElement | null>): void {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const nib = nibRef.current;
    if (!panel || !nib) return;
    const mobile = window.matchMedia(MOBILE_LAYOUT);
    let frame = 0;
    const place = (): void => {
      frame = requestAnimationFrame(place);
      const anchor = mobile.matches ? null : visibleApprovalEntry();
      if (!anchor) {
        if (panel.classList.contains("is-anchored") || panel.style.top !== "" || panel.style.right !== "") clearAnchor(panel, nib);
        return;
      }
      const box = anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      let right = window.innerWidth - box.right;
      if (window.innerWidth - right - width < ANCHOR_EDGE) right = Math.max(ANCHOR_EDGE, window.innerWidth - width - ANCHOR_EDGE);
      if (right < ANCHOR_EDGE) right = ANCHOR_EDGE;
      const nibRight = window.innerWidth - (box.left + box.width / 2) - right - NIB / 2;
      const nibLimit = Math.max(NIB, width - NIB - ANCHOR_EDGE);
      const topText = `${box.bottom + ANCHOR_EDGE}px`;
      const rightText = `${right}px`;
      const nibText = `${Math.min(Math.max(NIB, nibRight), nibLimit)}px`;
      if (panel.style.top !== topText) panel.style.top = topText;
      if (panel.style.right !== rightText) panel.style.right = rightText;
      if (panel.style.left !== "auto") panel.style.left = "auto";
      if (!panel.classList.contains("is-anchored")) panel.classList.add("is-anchored");
      if (nib.style.right !== nibText) nib.style.right = nibText;
    };
    place();
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [panelRef, nibRef]);
}

/**
 * `approvalArrival` 이 마운트 이후 늘었을 때만 0.9초 흔들림.
 * 스토어가 첫 스냅숏은 도착으로 세지 않으므로, 로드 때 이미 있던 요청은 흔들지 않는다.
 * 대기가 0이면 바로 끈다. 진행 중 타이머는 도착이 아닐 때 끊지 않는다.
 */
function useArrivalSwing(items: readonly ApprovalItem[]): boolean {
  const arrival = useSyncExternalStore(subscribeApprovals, approvalArrival, approvalArrival);
  const seen = useRef<number | null>(null);
  const timer = useRef(0);
  const [swing, setSwing] = useState(false);
  useEffect(() => {
    if (items.length === 0) {
      window.clearTimeout(timer.current);
      setSwing(false);
      seen.current = arrival;
      return;
    }
    if (seen.current === null) {
      seen.current = arrival;
      return;
    }
    if (arrival === seen.current) return;
    seen.current = arrival;
    setSwing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSwing(false), 900);
  }, [arrival, items.length]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return swing && items.length > 0;
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
