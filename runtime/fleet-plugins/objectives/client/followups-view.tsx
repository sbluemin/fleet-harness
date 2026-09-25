/**
 * 후속 후보 공용 행·상세 — 띠 comp 와 본문 구획이 같은 줄·상세를 쓴다(selectable 로만 가른다).
 * 후보 본문은 생성 전 고치지 않는다(읽기·선택·폐기만). 근거는 서버가 정리한 안전한 표시만 그린다.
 */

import { useEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { FollowupBatch, FollowupCandidate, FollowupEvidence } from "./followups.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

type T = Translate<ObjectiveMessageKey>;

export const FollowupForkGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="4" cy="4" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="4" r="1.6" /><path d="M4 5.6V8a4 4 0 0 0 4 4h2.4M5.6 4h4.8" /></svg>;
const FollowupChevGlyph = () => <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>;

function evidenceKindLabel(t: T, evidence: FollowupEvidence): string {
  return evidence.kind === "file" ? t("objectives.followup.ev.file") : evidence.kind === "command" ? t("objectives.followup.ev.command") : t("objectives.followup.ev.artifact");
}

/** 배치 결과의 오류 — 내부 코드를 그대로 두지 않고 사람의 말로 바꾸며, 모르는 코드는 뺀다. */
const RESULT_ERRORS: Readonly<Record<string, ObjectiveMessageKey>> = {
  launch_failed: "objectives.followup.err.launchFailed",
  launch_unavailable: "objectives.followup.err.unavailable",
  request_timeout: "objectives.followup.err.timeout",
};

function resultError(t: T, error: string | null): string | null {
  if (!error) return null;
  const key = RESULT_ERRORS[error];
  return key ? t(key) : null;
}

function FollowupEvidenceList({ evidence, t }: { readonly evidence: readonly FollowupEvidence[]; readonly t: T }) {
  return (
    <ul className="objectives-followup-ev">
      {evidence.map((entry, at) => (
        <li key={at}>
          <b>{evidenceKindLabel(t, entry)}</b>
          <span>
            <code>{entry.kind === "file" ? `${entry.path ?? ""}${entry.line !== null ? `:${entry.line}` : ""}` : entry.kind === "command" ? (entry.text ?? "") : (entry.path ?? "")}</code>
            {entry.note ? ` · ${entry.note}` : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 폐기 — 두 번 눌러 확정(첫 누름 뒤 3초 안). 키 반복 입력은 확정으로 치지 않는다. */
function DiscardButton({ candidateId, t, onDiscard }: { readonly candidateId: string; readonly t: T; readonly onDiscard: (candidateId: string) => void }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  // 다른 후보를 펼치면 무장은 풀린다 — 오래된 무장이 엉뚱한 확정이 되지 않게.
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, [candidateId]);
  return (
    <button
      type="button"
      className={`objectives-btn objectives-followup-discard${armed ? " is-armed" : ""}`}
      onKeyDown={(event) => { if (event.repeat) { suppressClick.current = true; event.preventDefault(); event.stopPropagation(); } }}
      onKeyUp={(event) => { if (event.repeat) { suppressClick.current = true; event.preventDefault(); event.stopPropagation(); } }}
      onBlur={() => { suppressClick.current = false; }}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        if (!armed) {
          setArmed(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setArmed(false), 3000);
          return;
        }
        if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
        setArmed(false);
        onDiscard(candidateId);
      }}
    >
      {t(armed ? "objectives.followup.discardArmed" : "objectives.followup.discard")}
    </button>
  );
}

function FollowupCandidateItem({ candidate, selectable, checked, open, t, idPrefix, onToggleCheck, onToggleOpen, onDiscard }: {
  readonly candidate: FollowupCandidate;
  readonly selectable: boolean;
  readonly checked: boolean;
  readonly open: boolean;
  readonly t: T;
  readonly idPrefix: string;
  readonly onToggleCheck: (candidateId: string, checked: boolean) => void;
  readonly onToggleOpen: (candidateId: string) => void;
  readonly onDiscard: (candidateId: string) => void;
}) {
  const [briefAll, setBriefAll] = useState(false);
  useEffect(() => { setBriefAll(false); }, [candidate.id, candidate.rev]);
  const detailId = `${idPrefix}-det-${candidate.id}`;
  return (
    <div className={`objectives-followup-item${open ? " is-open" : ""}`}>
      <div className={`objectives-followup-row${selectable ? "" : " is-readonly"}`}>
        {selectable ? (
          <input
            type="checkbox"
            className="objectives-followup-sel"
            data-followup-sel={candidate.id}
            checked={checked}
            aria-label={`${candidate.title} — ${t("objectives.followup.make")}`}
            onChange={(event) => onToggleCheck(candidate.id, event.target.checked)}
          />
        ) : null}
        <button type="button" className="objectives-followup-main" aria-expanded={open} aria-controls={detailId} onClick={() => onToggleOpen(candidate.id)}>
          <span className="objectives-followup-title">{candidate.title}</span>
          <span className="objectives-followup-summary">{candidate.summary}</span>
        </button>
        <span className="objectives-followup-meta">{t("objectives.followup.evidence", { n: candidate.evidence.length })}<FollowupChevGlyph /></span>
      </div>
      {open ? (
        <div className="objectives-followup-detail" id={detailId}>
          <div>
            <div className="objectives-followup-lab">{t("objectives.followup.brief")}</div>
            <p className={`objectives-followup-brief${briefAll ? " is-all" : ""}`}>{candidate.brief}</p>
            {candidate.brief.length > 90 ? <button type="button" className="objectives-followup-more" onClick={() => setBriefAll((value) => !value)}>{t(briefAll ? "objectives.brief.less" : "objectives.brief.more")}</button> : null}
          </div>
          {candidate.criteria.length ? (
            <div>
              <div className="objectives-followup-lab">{t("objectives.followup.criteria", { n: candidate.criteria.length })}</div>
              <ol className="objectives-followup-crit">
                {candidate.criteria.map((criterion, at) => <li key={at}>{criterion}</li>)}
              </ol>
            </div>
          ) : null}
          {candidate.evidence.length ? (
            <div>
              <div className="objectives-followup-lab">{t("objectives.followup.evidence", { n: candidate.evidence.length })}</div>
              <FollowupEvidenceList evidence={candidate.evidence} t={t} />
            </div>
          ) : null}
          <div className="objectives-followup-foot">
            <span className="objectives-followup-hint">{t("objectives.followup.noEdit")}</span>
            <DiscardButton candidateId={candidate.id} t={t} onDiscard={onDiscard} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 후보 목록 — 한 번에 하나만 펼친다. 줄 본문 클릭은 펼침만 하고 선택하지 않는다. */
export function FollowupCandidateList({ candidates, selectable, selection, t, idPrefix, openId, onOpenChange, onToggleCheck, onDiscard }: {
  readonly candidates: readonly FollowupCandidate[];
  readonly selectable: boolean;
  readonly selection: ReadonlySet<string>;
  readonly t: T;
  readonly idPrefix: string;
  readonly openId: string | null;
  readonly onOpenChange: (candidateId: string | null) => void;
  readonly onToggleCheck: (candidateId: string, checked: boolean) => void;
  readonly onDiscard: (candidateId: string) => void;
}) {
  return (
    <div className="objectives-followup-list">
      {candidates.map((candidate) => (
        <FollowupCandidateItem
          key={candidate.id}
          candidate={candidate}
          selectable={selectable}
          checked={selection.has(candidate.id)}
          open={openId === candidate.id}
          t={t}
          idPrefix={idPrefix}
          onToggleCheck={onToggleCheck}
          onToggleOpen={(id) => onOpenChange(openId === id ? null : id)}
          onDiscard={onDiscard}
        />
      ))}
    </div>
  );
}

/** 폐기 흔적 — 목록 끝의 흐린 한 줄로 접혀 남고, 펼치면 제목과 누가 폐기했는지만 보인다. 되돌리기는 없다. */
export function FollowupDiscardedTrace({ discarded, t }: { readonly discarded: readonly FollowupCandidate[]; readonly t: T }) {
  const [open, setOpen] = useState(false);
  if (discarded.length === 0) return null;
  return (
    <div className="objectives-followup-trace">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <FollowupChevGlyph />{t("objectives.followup.discarded", { n: discarded.length })}
      </button>
      {open ? (
        <ul>
          {discarded.map((candidate) => (
            <li key={candidate.id}><s>{candidate.title}</s><span> · {t("objectives.followup.discardedMark")}</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 묶음 캡션의 완료 시각 — 오늘이면 시:분, 아니면 월·일과 시:분(기록 시각과 같은 문법). */
function batchTime(at: number, language: "en" | "ko"): string {
  const date = new Date(at);
  const locale = language === "ko" ? "ko-KR" : "en-US";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date)} ${time}`;
}

/**
 * 완료 뒤 결과 — 머리 아래에 영속한다. 요약(선택·생성·실패)과 줄 상태(생성 중·생성됨·실패·확인 중·삭제됨),
 * 남긴 후보는 결과 아래 접힌 줄로 읽기만 한다. 묶음이 여러 개면 최신이 위로 온다.
 */
export function FollowupBatchResults({ batches, leftover, historyTotal, language, t, onRetry, onOpenObjective }: {
  readonly batches: readonly FollowupBatch[];
  /** 고르지 않아 원본에 남은 open 후보. */
  readonly leftover: readonly FollowupCandidate[];
  readonly historyTotal: { readonly batches: number; readonly created: number; readonly deleted: number; readonly abandoned: number } | null;
  readonly language: "en" | "ko";
  readonly t: T;
  readonly onRetry: (batchId: string, candidateId: string) => void;
  readonly onOpenObjective: (operationId: string) => void;
}) {
  const [leftoverOpen, setLeftoverOpen] = useState(false);
  if (batches.length === 0 && leftover.length === 0 && !historyTotal) return null;
  const ordered = [...batches].sort((a, b) => b.at - a.at);
  return (
    <div className="objectives-followup-results">
      {ordered.map((batch) => {
        const picked = batch.items.length;
        const made = batch.items.filter((entry) => entry.state === "created" || entry.state === "deleted").length;
        const failed = batch.items.filter((entry) => entry.state === "failed").length;
        return (
          <div key={batch.id} className="objectives-followup-batch">
            <p className="objectives-followup-batchat">{batchTime(batch.at, language)}</p>
            <p className="objectives-followup-sum">{t("objectives.followup.summary", { n: picked, k: made, f: failed })}</p>
            <div className="objectives-followup-res">
              {batch.items.map((entry) => {
                const why = resultError(t, entry.error);
                return (
                <div key={entry.candidateId} className="objectives-followup-rrow">
                  <span className="objectives-followup-rt">{entry.snapshot.title}</span>
                  {entry.state === "creating" ? <span className="objectives-followup-rstat is-wait"><i className="objectives-followup-spin" aria-hidden="true" />{t("objectives.followup.creating")}</span> : null}
                  {entry.state === "confirming" ? <span className="objectives-followup-rstat is-wait">{t("objectives.followup.confirming")}{why ? ` · ${why}` : ""} · <button type="button" onClick={() => onRetry(batch.id, entry.candidateId)}>{t("objectives.followup.recheck")}</button></span> : null}
                  {entry.state === "created" ? <span className="objectives-followup-rstat is-ok">{t("objectives.followup.created")} · <button type="button" onClick={() => entry.operationId && onOpenObjective(entry.operationId)}>{t("objectives.followup.openTarget")}</button></span> : null}
                  {entry.state === "failed" ? <span className="objectives-followup-rstat is-fail">{t("objectives.followup.failed")}{why ? ` · ${why}` : ""} · <button type="button" onClick={() => onRetry(batch.id, entry.candidateId)}>{t("objectives.followup.retry")}</button></span> : null}
                  {entry.state === "deleted" ? <span className="objectives-followup-rstat is-gone">{t("objectives.followup.deleted")}</span> : null}
                  {entry.state === "abandoned" ? <span className="objectives-followup-rstat is-gone">{t("objectives.followup.abandoned")}</span> : null}
                </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {leftover.length ? (
        <div className="objectives-followup-trace">
          <button type="button" aria-expanded={leftoverOpen} onClick={() => setLeftoverOpen((value) => !value)}>
            <FollowupChevGlyph />{t("objectives.followup.leftover", { n: leftover.length })}
          </button>
          {leftoverOpen ? (
            <ul>
              {leftover.map((candidate) => (
                <li key={candidate.id}>{candidate.title}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {historyTotal && historyTotal.batches > batches.length ? (
        <p className="objectives-followup-history">{t("objectives.followup.history", { b: historyTotal.batches, c: historyTotal.created, d: historyTotal.deleted, a: historyTotal.abandoned })}</p>
      ) : null}
    </div>
  );
}
