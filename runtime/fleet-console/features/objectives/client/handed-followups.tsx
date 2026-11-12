/**
 * 사령관이 사람에게 넘긴 후속 후보 — 사령관 대화에 서는 카드. 넘긴 결정 카드처럼 목표 이름을 머리에 싣고, 후보를 이 자리에서
 * 채택(후속 목표로 만들기)·폐기하거나 사령관에게 돌려준다. 채택은 목표를 완료하지 않으므로 검토 대기와 완료 뒤가 같은 길이다.
 * 열린 후보가 없어지면 넘김이 「사람이 답함」으로 끝나 카드가 내려간다.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";

import { livePersonHold } from "../shared/board-state.js";
import type { Objective } from "../shared/types.js";
import { bandReason } from "./board-actions.js";
import { FollowupCandidateList, FollowupDiscardedTrace } from "./followups-view.js";
import { discardedFollowups, newBatchId, openFollowups } from "./followups.js";
import { getT } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { applyObjectiveResponse, findAnyObjective, objectivesApi, post, returnPersonHold, subscribeObjectiveOrFinished } from "./objectives-state.js";

export function HandedFollowupCard({ objectiveId, language, phone, open }: {
  readonly objectiveId: string;
  readonly language: ConsoleLocale;
  readonly phone: boolean;
  readonly open: () => void;
}) {
  const read = () => findAnyObjective(objectiveId);
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, read, read);
  const t = getT(language, phone);
  /** 고른 후보와 고른 순간의 rev — 그새 고쳐진 후보는 선택에서 빠져 다시 읽고 고른다. */
  const [picks, setPicks] = useState<ReadonlyMap<string, number>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPicks(new Map()); setOpenId(null); setError(null); }, [objectiveId]);
  const hold = objective && !objective.removed ? livePersonHold(objective, "followup") : null;
  if (!objective || !hold) return null;
  const candidates = openFollowups(objective);
  const chosen = candidates.filter((candidate) => picks.get(candidate.id) === candidate.rev);
  const run = async (path: string, body: Record<string, unknown>) => {
    const api = objectivesApi();
    if (!api) throw new Error("objectives_unavailable");
    const result = await post<{ objective?: Objective }>(api, path, { objectiveId, language, ...body });
    if (result?.objective) applyObjectiveResponse(result.objective);
  };
  const guarded = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void work()
      .catch((failure: unknown) => setError(t("objectives.band.failedAction", { reason: bandReason(t, failure) })))
      .finally(() => setBusy(false));
  };
  const adopt = () => {
    if (chosen.length === 0) return;
    guarded(async () => {
      await run("/followup/adopt", { batchId: newBatchId(), followups: chosen.map(({ id, rev }) => ({ id, rev })) });
      setPicks(new Map());
    });
  };
  return (
    <section className="group-card is-decision objectives-handed-followup" aria-label={`${objective.title} — ${t("objectives.followup.title")}`}>
      <div className="group-card-head">
        <span className="group-card-who">{`${objective.title} · ${t("objectives.followup.title")}`}</span>
        <button type="button" className="group-chat-link" onClick={open}>{t("objectives.composer.reveal")}</button>
      </div>
      <div className="group-card-handed"><span className="group-card-handed-label">{t("objectives.decision.handed")}</span><LinkText text={hold.reason} /></div>
      <FollowupCandidateList
        candidates={candidates}
        selectable
        rowDiscard
        selection={new Set(chosen.map((candidate) => candidate.id))}
        t={t}
        idPrefix={`handed-${objectiveId}`}
        openId={openId}
        onOpenChange={setOpenId}
        onToggleCheck={(candidateId, checked) => {
          const rev = candidates.find((candidate) => candidate.id === candidateId)?.rev ?? 1;
          setPicks((current) => { const next = new Map(current); if (checked) next.set(candidateId, rev); else next.delete(candidateId); return next; });
          setError(null);
        }}
        onDiscard={(candidateId) => guarded(() => run("/followup/discard", { candidateId }))}
      />
      <FollowupDiscardedTrace discarded={discardedFollowups(objective)} t={t} />
      <div className="group-card-foot">
        {error ? <span className="group-card-error" role="alert">{error}</span>
          : <span className="group-card-route">{t(chosen.length === 0 ? "objectives.followup.adoptEmpty" : "objectives.followup.adoptSome", { k: chosen.length, n: candidates.length })}</span>}
        <button type="button" className="group-card-send is-quiet" disabled={busy} onClick={() => guarded(() => returnPersonHold(objectiveId, "followup"))}>{t("objectives.decision.giveBack")}</button>
        <button type="button" className="group-card-send" disabled={busy || chosen.length === 0} aria-busy={busy || undefined} onClick={adopt}>{t("objectives.followup.adopt")}</button>
      </div>
    </section>
  );
}
