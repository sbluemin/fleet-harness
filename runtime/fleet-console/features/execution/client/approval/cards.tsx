import { useState, type KeyboardEvent, type ReactNode } from "react";

import type { ApprovalDecision } from "@fleet-console/approval/contract";
import { useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import type { CoreMessageKey } from "../../../../core/client/src/i18n/messages/index.js";

import { wordDiff } from "./diff.js";
import { answerApproval } from "./store.js";

const HOLD_SECONDS = 240;
const LOW_SECONDS = 30;

export function ignoreApprovalRepeat(event: KeyboardEvent<HTMLElement>): void {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}

export function useApprovalAnswer(id: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"failed" | "experiment_disabled" | null>(null);
  const answer = (decision: ApprovalDecision) => () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void answerApproval(id, decision)
      .catch((caught: unknown) => setError(caught instanceof Error && caught.message === "experiment_disabled" ? "experiment_disabled" : "failed"))
      .finally(() => setPending(false));
  };
  return { pending, error, answer };
}

export function LifeRing({ seconds, total = HOLD_SECONDS }: { readonly seconds?: number; readonly total?: number }) {
  if (seconds === undefined) return <span className="approval-life is-pin" aria-hidden="true" />;
  const low = seconds <= LOW_SECONDS;
  const portion = Math.max(0, Math.min(1, seconds / Math.max(1, total)));
  return (
    <span className={`approval-life${low ? " is-low" : ""}`} style={{ ["--p" as string]: String(portion) }} aria-hidden="true">
      <svg viewBox="0 0 16 16"><circle className="track" cx="8" cy="8" r="6" fill="none" strokeWidth="2" /><circle className="arc" cx="8" cy="8" r="6" fill="none" strokeWidth="2" /></svg>
    </span>
  );
}

export function formatApprovalTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds) % 60).padStart(2, "0")}`;
}

export function approvalSecondsLeft(expiresAt: number | undefined, now: number): number | undefined {
  if (expiresAt === undefined) return undefined;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function Pieces({ pieces }: { readonly pieces: readonly { readonly text: string; readonly mark: "same" | "del" | "ins" }[] }) {
  return <>{pieces.map((piece, index) => piece.mark === "same" ? <span key={index}>{piece.text}</span> : piece.mark === "del" ? <del key={index}>{piece.text}</del> : <ins key={index}>{piece.text}</ins>)}</>;
}

export function ApprovalDiff({ now, after, nowLabel, afterLabel, none, afterNone }: {
  readonly now: string | null;
  readonly after: string | null;
  readonly nowLabel: string;
  readonly afterLabel: string;
  readonly none: string;
  readonly afterNone?: string;
}) {
  const compared = now !== null && after !== null ? wordDiff(now, after) : null;
  return (
    <div className="approval-diff">
      <div className="approval-diff-line">
        <span className="approval-diff-tag">{nowLabel}</span>
        <span className="approval-diff-body">{now === null ? <span className="approval-none">{none}</span> : compared ? <Pieces pieces={compared.before} /> : now}</span>
      </div>
      <div className="approval-diff-line is-after">
        <span className="approval-diff-tag">{afterLabel}</span>
        <span className="approval-diff-body">{after === null ? <span className="approval-none">{afterNone ?? none}</span> : compared ? <Pieces pieces={compared.after} /> : after}</span>
      </div>
    </div>
  );
}

export function ApprovalCardFrame({ titleId, glyph, title, from, life, children, replaced }: {
  readonly titleId: string;
  readonly glyph: ReactNode;
  readonly title: ReactNode;
  readonly from?: string;
  readonly life: ReactNode;
  readonly children: ReactNode;
  readonly replaced?: boolean;
}) {
  const t = useT();
  return (
    <article className="approval-card" role="group" aria-labelledby={titleId} onKeyDown={ignoreApprovalRepeat}>
      <div className="approval-card-top">
        <span className="approval-glyph" aria-hidden="true">{glyph}</span>
        <span className="approval-card-head">
          <span className="approval-card-title" id={titleId}>{title}</span>
          {from ? <span className="approval-card-from">{from}</span> : null}
        </span>
        {life}
      </div>
      {children}
      {replaced ? <p className="approval-replaced">{t("approval.replaced")}</p> : null}
    </article>
  );
}

export function ApprovalActions({ pending, error, primary, primaryLabel, secondaryLabel, onPrimary, onSecondary, effect }: {
  readonly pending: boolean;
  readonly error: "failed" | "experiment_disabled" | null;
  readonly primary: boolean;
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
  readonly onPrimary: () => void;
  readonly onSecondary: () => void;
  readonly effect: string;
}) {
  const t = useT();
  return (
    <>
      <div className="approval-actions">
        <p className="approval-effect">{effect}</p>
        <span className="approval-action-btns">
          <button type="button" className="approval-btn" disabled={pending} onClick={onSecondary}>{secondaryLabel}</button>
          <button type="button" className={`approval-btn${primary ? " is-primary" : ""}`} disabled={pending} onClick={onPrimary}>{primaryLabel}</button>
        </span>
      </div>
      {error ? <p className="approval-error" role="alert">{t(error === "experiment_disabled" ? "approval.experimentOff" : "approval.failed")}</p> : null}
    </>
  );
}

export function ApprovalComputerCard({ id, objectiveId, expiresAt, now, lead }: {
  readonly id: string;
  readonly objectiveId: string;
  readonly expiresAt: number;
  readonly now: number;
  readonly lead?: string;
}) {
  const t = useT();
  const state = useConsoleState();
  const title = state.objectiveRecords.find((record) => record.id === objectiveId)?.title;
  const { pending, error, answer } = useApprovalAnswer(id);
  const left = approvalSecondsLeft(expiresAt, now) ?? 0;
  const low = left <= LOW_SECONDS;
  return (
    <ApprovalCardFrame
      titleId={`approval-computer-${id}`}
      glyph={<ComputerGlyph />}
      title={t("approval.computerTitle")}
      from={title ? t("approval.computerFrom", { title }) : undefined}
      life={<span className={`approval-card-life${low ? " is-low" : ""}`}><LifeRing seconds={left} /><span className="num">{t("approval.remaining", { time: formatApprovalTime(left) })}</span></span>}
    >
      <p className="approval-lead">{lead ?? t("approval.computerLead")}</p>
      <ApprovalActions
        pending={pending}
        error={error}
        primary
        secondaryLabel={t("approval.deny")}
        primaryLabel={t("approval.always")}
        onSecondary={answer("declined")}
        onPrimary={answer("always")}
        effect={t("approval.computerEffect")}
      />
    </ApprovalCardFrame>
  );
}

export function toastText(t: (key: CoreMessageKey) => string, toast: { readonly status: string; readonly reason?: string; readonly type: string }): string {
  if (toast.reason === "item-removed") return t("approval.toast.itemRemoved");
  if (toast.reason === "replaced") return t("approval.toast.replaced");
  if (toast.status === "approved") return t(toast.type === "computer.use" ? "approval.toast.approvedComputer" : toast.type === "commodore.intel" ? "approval.toast.approvedIntel" : "approval.toast.approvedDesc");
  if (toast.status === "rejected") return t("approval.toast.rejected");
  if (toast.status === "expired") return t("approval.toast.expired");
  return t("approval.toast.withdrawn");
}

export function announceText(t: (key: CoreMessageKey) => string, type: string): string {
  if (type === "computer.use") return t("approval.announce.computer");
  if (type === "commodore.intel") return t("approval.announce.intel");
  return t("approval.announce.desc");
}

function ComputerGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 14h4M8 11v3" /></svg>;
}

export function DescriptionGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4h10M3 8h6M3 12h4" /><path d="m10.5 12.5 3-3-1.5-1.5-3 3V12.5z" /></svg>;
}

export function IntelGlyph() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="2.5" width="10" height="11" rx="1.5" /><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" /></svg>;
}
