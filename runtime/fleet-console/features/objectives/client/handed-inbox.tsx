/**
 * 사령관 대기함에서 펼친 기준·검토 — 지휘관 채팅 카드가 하던 제자리 처리. 후속은 `HandedFollowupCard`가 그대로 그린다.
 * 넘긴 이유와 목표 이름은 대기함 줄이 보이므로 여기에는 답하는 단추만 둔다.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { livePersonHold } from "../shared/board-state.js";
import type { Objective, PersonHoldTarget } from "../shared/types.js";
import { bandReason } from "./board-actions.js";
import { FollowupCandidateList, FollowupDiscardedTrace } from "./followups-view.js";
import { discardedFollowups, isFollowupSelectable, newBatchId, openFollowups, steeredEdits } from "./followups.js";
import { getT } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { applyObjectiveResponse, findAnyObjective, objectivesApi, post, returnPersonHold, subscribeObjectiveOrFinished } from "./objectives-state.js";

export function HandedInboxDetail({ objectiveId, kind, language, phone }: {
  readonly objectiveId: string;
  readonly kind: Exclude<PersonHoldTarget, "followup">;
  readonly language: ConsoleLocale;
  readonly phone: boolean;
}) {
  const read = () => findAnyObjective(objectiveId);
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, read, read);
  if (!objective || objective.removed || !livePersonHold(objective, kind)) return null;
  return kind === "criteria"
    ? <CriteriaDetail objective={objective} language={language} phone={phone} />
    : <ReviewDetail objective={objective} language={language} phone={phone} />;
}

async function holdPost(objectiveId: string, language: ConsoleLocale, path: string, body: Record<string, unknown>): Promise<void> {
  const api = objectivesApi();
  if (!api) throw new Error("objectives_unavailable");
  const result = await post<{ objective?: Objective }>(api, path, { objectiveId, language, ...body });
  if (result?.objective) applyObjectiveResponse(result.objective);
}

/**
 * 한 줄 결정의 빠른 답 — 한 번에 끝나는 경우만 단추를 세운다. 기준은 모두 승인(제안이 하나면 그 승인), 검토는 후속 후보가 없고
 * 막힘이 없을 때의 완료다. 개별 승인·거절·메모·돌려주기와 후속 고르기는 펼친 카드(`HandedInboxDetail`)가 맡는다.
 */
export function HandedInboxQuick({ objectiveId, kind, language, phone, onFailed }: {
  readonly objectiveId: string;
  readonly kind: Exclude<PersonHoldTarget, "followup">;
  readonly language: ConsoleLocale;
  readonly phone: boolean;
  readonly onFailed: (error: unknown) => void;
}) {
  const read = () => findAnyObjective(objectiveId);
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, read, read);
  const t = getT(language, phone);
  const [busy, setBusy] = useState(false);
  if (!objective || objective.removed || !livePersonHold(objective, kind)) return null;
  let label: string;
  let path: string;
  let body: Record<string, unknown> = {};
  if (kind === "criteria") {
    const proposals = objective.criteriaProposals;
    if (objective.done || proposals.length === 0) return null;
    if (proposals.length === 1) { label = t("objectives.proposal.approve"); path = "/criterion/approve"; body = { proposalId: proposals[0]!.id }; }
    else { label = t("objectives.criteria.approveAll"); path = "/criterion/approve-all"; }
  } else {
    const hasCandidates = isFollowupSelectable(objective) && openFollowups(objective).length > 0;
    if (hasCandidates || objective.criteriaProposals.length > 0 || steeredEdits(objective)) return null;
    label = t("objectives.review.complete");
    path = "/objective/complete";
  }
  const run = () => {
    if (busy) return;
    setBusy(true);
    void holdPost(objectiveId, language, path, body).catch(onFailed).finally(() => setBusy(false));
  };
  return <button type="button" className="commodore-decision-quick is-primary" disabled={busy} aria-busy={busy || undefined} onClick={run}>{label}</button>;
}

function useHoldActions(objectiveId: string, language: ConsoleLocale, phone: boolean, target: Exclude<PersonHoldTarget, "followup">) {
  const t = getT(language, phone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [objectiveId, target]);
  const run = async (path: string, body: Record<string, unknown>) => {
    await holdPost(objectiveId, language, path, body);
  };
  const guarded = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void work()
      .catch((failure: unknown) => setError(t("objectives.band.failedAction", { reason: bandReason(t, failure) })))
      .finally(() => setBusy(false));
  };
  return { t, busy, error, run, guarded };
}

function GiveBack({ objectiveId, target, busy, label, onRun }: {
  readonly objectiveId: string;
  readonly target: Exclude<PersonHoldTarget, "followup">;
  readonly busy: boolean;
  readonly label: string;
  readonly onRun: (work: () => Promise<void>) => void;
}) {
  return <button type="button" className="group-card-send is-quiet" disabled={busy} onClick={() => onRun(() => returnPersonHold(objectiveId, target))}>{label}</button>;
}

function CriteriaDetail({ objective, language, phone }: { readonly objective: Objective; readonly language: ConsoleLocale; readonly phone: boolean }) {
  const { t, busy, error, run, guarded } = useHoldActions(objective.id, language, phone, "criteria");
  const [noteId, setNoteId] = useState<string | null>(null);
  const proposals = objective.criteriaProposals;
  const touchable = !objective.done;
  return (
    <div className="commodore-person-inbox-detail">
      {proposals.map((proposal) => {
        const index = proposal.target ? objective.criteria.findIndex((criterion) => criterion.id === proposal.target) : -1;
        const target = index >= 0 ? objective.criteria[index]! : null;
        const n = index + 1;
        const label = proposal.kind === "add" ? t("objectives.proposal.add") : t(proposal.kind === "revise" ? "objectives.proposal.revise" : proposal.kind === "recheck" ? "objectives.proposal.recheck" : "objectives.proposal.retire", { n });
        return (
          <div key={proposal.id} className="commodore-person-inbox-proposal" role="group" aria-label={label}>
            <p className="commodore-person-inbox-kindline">{label}</p>
            {proposal.kind === "revise" && target ? <del><LinkText text={target.text} /></del> : null}
            {proposal.kind === "retire" ? <del><LinkText text={target?.text ?? ""} /></del>
              : proposal.kind === "recheck" ? <p><LinkText text={target?.text ?? ""} /></p>
                : <p><LinkText text={proposal.text ?? ""} /></p>}
            {proposal.reason && (proposal.kind === "retire" || proposal.kind === "recheck") ? <p className="commodore-person-inbox-sub"><LinkText text={t("objectives.proposal.reason", { reason: proposal.reason })} /></p> : null}
            {touchable ? (
              <div className="commodore-person-inbox-acts">
                <button type="button" className="group-card-send is-quiet" disabled={busy} onClick={() => guarded(() => run("/criterion/reject", { proposalId: proposal.id }))}>{t("objectives.proposal.reject")}</button>
                <button type="button" className="group-card-send" disabled={busy} onClick={() => guarded(() => run("/criterion/approve", { proposalId: proposal.id }))}>{t("objectives.proposal.approve")}</button>
                <button type="button" className="group-card-send is-quiet" disabled={busy} aria-expanded={noteId === proposal.id} onClick={() => setNoteId((current) => current === proposal.id ? null : proposal.id)}>{t(proposal.annotation ? "objectives.proposal.annotateEdit" : "objectives.proposal.annotate")}</button>
              </div>
            ) : null}
            {noteId === proposal.id ? (
              <textarea
                className="commodore-person-inbox-note"
                rows={2}
                maxLength={300}
                defaultValue={proposal.annotation ?? ""}
                aria-label={t("objectives.proposal.annotationAria")}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== (proposal.annotation ?? "")) guarded(() => run("/criterion/annotate", { proposalId: proposal.id, annotation: value }));
                }}
              />
            ) : null}
          </div>
        );
      })}
      <div className="group-card-foot">
        {error ? <span className="group-card-error" role="alert">{error}</span> : <span />}
        <GiveBack objectiveId={objective.id} target="criteria" busy={busy} label={t("objectives.decision.giveBack")} onRun={guarded} />
        {touchable && proposals.length > 1 ? <button type="button" className="group-card-send" disabled={busy} onClick={() => guarded(() => run("/criterion/approve-all", {}))}>{t("objectives.criteria.approveAll")}</button> : null}
      </div>
    </div>
  );
}

function ReviewDetail({ objective, language, phone }: { readonly objective: Objective; readonly language: ConsoleLocale; readonly phone: boolean }) {
  const { t, busy, error, run, guarded } = useHoldActions(objective.id, language, phone, "review");
  const candidates = openFollowups(objective);
  const selectable = isFollowupSelectable(objective);
  const [picks, setPicks] = useState<ReadonlyMap<string, number>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { setPicks(new Map()); setOpenId(null); }, [objective.id]);
  const chosen = candidates.filter((candidate) => picks.get(candidate.id) === candidate.rev);
  const blocked = objective.criteriaProposals.length > 0 || steeredEdits(objective);
  const complete = () => {
    if (blocked) return;
    guarded(async () => {
      if (!selectable || chosen.length === 0) await run("/objective/complete", {});
      else await run("/objective/complete", { batchId: newBatchId(), followups: chosen.map(({ id, rev }) => ({ id, rev })) });
      setPicks(new Map());
    });
  };
  return (
    <div className="commodore-person-inbox-detail">
      {selectable && candidates.length > 0 ? (
        <>
          <FollowupCandidateList
            candidates={candidates}
            selectable
            rowDiscard={false}
            selection={new Set(chosen.map((candidate) => candidate.id))}
            t={t}
            idPrefix={`inbox-review-${objective.id}`}
            openId={openId}
            onOpenChange={setOpenId}
            onToggleCheck={(candidateId, checked) => {
              const rev = candidates.find((candidate) => candidate.id === candidateId)?.rev ?? 1;
              setPicks((current) => { const next = new Map(current); if (checked) next.set(candidateId, rev); else next.delete(candidateId); return next; });
            }}
          />
          <FollowupDiscardedTrace discarded={discardedFollowups(objective)} t={t} />
        </>
      ) : null}
      <div className="group-card-foot">
        {error ? <span className="group-card-error" role="alert">{error}</span>
          : <span className="group-card-route">{blocked
            ? t(objective.criteriaProposals.length > 0 ? "objectives.followup.bodyGated" : "objectives.followup.bodyEdited")
            : selectable && chosen.length > 0 ? t("objectives.followup.sendSome", { k: chosen.length }) : t("objectives.review.sub")}</span>}
        <GiveBack objectiveId={objective.id} target="review" busy={busy} label={t("objectives.decision.giveBack")} onRun={guarded} />
        <button type="button" className="group-card-send" disabled={busy || blocked} aria-busy={busy || undefined} onClick={complete}>{t("objectives.review.complete")}</button>
      </div>
    </div>
  );
}
