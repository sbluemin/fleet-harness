import { useEffect, useState, useSyncExternalStore } from "react";

import { operationAvatarKey } from "@fleet-console/sdk/avatars";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "@fleet-console/sdk/plugin";

import type { Objective } from "../server/types.js";
import { bandChoices, bandFailure } from "./action-band.js";
import { getT } from "./i18n/index.js";
import { FRESH_SURFACE_ID, focusOperation, objectivesApi, openObjectiveFromCluster, operationSummaries, post, readAllTheaters, subscribeObjective } from "./objectives-state.js";

/**
 * 대화 중심 화면의 「시작 전」 목표 — 지휘관 Operation 이 아직 없는 목표를 첫 메시지가 없는 대화처럼 가운데 칸에 세운다.
 * 칸이 서 있는 동안 호스트는 활성 Operation 을 비우므로 가운데 칸·오른쪽 패널 머리·사이드바 하이라이트가 모두 이 목표를 가리킨다.
 * 개시해 지휘관 Operation 이 서면 그 대화로 넘긴다(호스트의 포커스가 이 칸을 걷는다). 여닫기는 SDK 능력(`ctx.conversation`)만 쓴다.
 */

// 표면 id 는 objectives-state 가 갖는다 — 다른 Theater 의 목표를 열 때 그쪽도 시작 화면을 세운다(순환 import 를 피한다).
export { FRESH_SURFACE_ID };

let port: ClientConversationCapability | null = null;

export function connectFreshConversation(next: ClientConversationCapability | undefined): () => void {
  port = next ?? null;
  return () => { if (port === next) port = null; };
}

/**
 * 가운데 칸에 그 목표의 시작 화면을 세운다. 대화 중심 화면이 꺼져 있으면 false — 부르는 쪽이 지금까지의 표면을 연다.
 * 목표의 Theater 를 함께 싣는다 — 호스트는 가운데 대화의 Theater 를 `params.theaterId` 로 읽어 머리 도구모음·오른쪽 패널을 그 Theater 로 연다.
 */
export function openFreshConversation(objectiveId: string): boolean {
  if (!port || !port.isActive()) return false;
  const theaterId = findObjective(objectiveId)?.theaterId;
  return port.open(FRESH_SURFACE_ID, theaterId ? { objectiveId, theaterId } : { objectiveId });
}

/** 지금 가운데 칸에 시작 화면이 선 목표. 없으면 null. */
export function freshConversationObjectiveId(): string | null {
  const current = port?.current() ?? null;
  if (current?.surfaceId !== FRESH_SURFACE_ID) return null;
  const objectiveId = current.params.objectiveId;
  return typeof objectiveId === "string" ? objectiveId : null;
}

/** 대화 배치·가운데 칸이 바뀌면 깨운다 — 사이드바 줄의 선택 표시가 가운데 칸을 따른다. */
export function subscribeFreshConversation(listener: () => void): () => void {
  return port?.subscribe(listener) ?? (() => {});
}

const objectiveIdOf = (params: Readonly<Record<string, unknown>>): string | null => (typeof params.objectiveId === "string" ? params.objectiveId : null);
const findObjective = (objectiveId: string | null): Objective | null =>
  objectiveId === null ? null : readAllTheaters().flatMap((state) => state.objectives).find((objective) => objective.id === objectiveId) ?? null;
const launchAvailableFor = (objectiveId: string): boolean =>
  readAllTheaters().find((state) => state.objectives.some((objective) => objective.id === objectiveId))?.launchAvailable ?? false;
const commanderLive = (objectiveId: string): boolean => operationSummaries().some((summary) => summary.id === objectiveId);

function FreshObjectiveBody({ objectiveId, language, onClose }: { readonly objectiveId: string; readonly language: "en" | "ko"; readonly onClose: () => void }) {
  const t = getT(language);
  const objective = useSyncExternalStore(subscribeObjective, () => findObjective(objectiveId), () => findObjective(objectiveId));
  const live = useSyncExternalStore(subscribeObjective, () => commanderLive(objectiveId), () => commanderLive(objectiveId));
  const launchAvailable = useSyncExternalStore(subscribeObjective, () => launchAvailableFor(objectiveId), () => launchAvailableFor(objectiveId));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // 개시로 지휘관 Operation 이 서면 그 대화로 넘긴다. 목표가 사라지면(정리·완료) 칸을 걷어 직전 대화로 돌아간다.
  useEffect(() => {
    if (live) focusOperation(objectiveId);
    else if (objective === null || objective.removed || objective.done) onClose();
  }, [live, objective, objectiveId, onClose]);
  if (!objective) return null;
  const choices = bandChoices({ objective, working: false, commanderAwaiting: false, memberAwaiting: null, commanderExists: false, recipientCount: 0 });
  const startable = choices.primary === "start" || choices.alts.includes("start");
  // 데스크톱 띠·모바일 개시 카드와 같은 판정 — 라우팅 확인이 걸리면 확인 시트가 있는 오른쪽 패널의 띠로 보낸다.
  const review = objective.routingConfirm ? objective.members.filter((member) => member.launch.mode === "route") : [];
  const reason = choices.gated ? t("objectives.band.gated", { count: objective.criteriaProposals.length })
    : !startable ? null
      : !launchAvailable ? t("objectives.band.reason.unavailable") : null;
  const members = objective.members.length;
  const routed = review.length ? t("objectives.start.routeConfirm", { count: review.length }) : "";
  const desc = reason ?? (members ? `${t("objectives.start.members", { count: members })}${routed}` : objective.missions.length ? t("objectives.start.direct") : t("objectives.band.start.bare"));
  const met = objective.criteria.filter((criterion) => !!criterion.met).length;
  const start = () => {
    if (busy || reason || !startable) return;
    if (review.length > 0) {
      openObjectiveFromCluster(objective.theaterId);
      setFailure(t("objectives.fresh.review"));
      return;
    }
    const api = objectivesApi();
    if (!api) return;
    setBusy(true);
    setFailure(null);
    void post<{ failed?: readonly { role: string }[] }>(api, "/commander/start", { objectiveId, language })
      .then((result) => {
        const failed = result?.failed ?? [];
        if (failed.length) setFailure(t("objectives.start.failedMembers", { count: failed.length, roles: failed.map((entry) => entry.role).join(", ") }));
      })
      .catch((error: unknown) => setFailure(bandFailure(t, error, { message: false, talk: false })))
      .finally(() => setBusy(false));
  };
  return (
    <div className="objectives-fresh-conversation">
      <div className="objectives-fresh-start">
        <span className="objectives-fresh-label"><span className="objectives-fresh-ring" aria-hidden="true" />{t("objectives.state.fresh")}</span>
        <h2 className="objectives-fresh-title">{objective.title}</h2>
        {objective.note.trim()
          ? <p className="objectives-fresh-brief">{objective.note}</p>
          : <p className="objectives-fresh-brief is-empty">{t("objectives.fresh.noBrief")}</p>}
        {objective.criteria.length > 0
          ? <p className="objectives-fresh-meta">{t("objectives.criteria.title")} · {t("objectives.criteria.count", { met, total: objective.criteria.length })}</p>
          : null}
        {startable || choices.gated ? (
          <div className="objectives-fresh-commence">
            <button type="button" className="objectives-fresh-start-button" disabled={busy || !!reason} aria-busy={busy || undefined} onClick={start}>{t("objectives.commander.start")}</button>
            <span className="objectives-fresh-desc">{desc}</span>
          </div>
        ) : null}
        {failure ? <p className="objectives-fresh-failure" role="alert">{failure}</p> : null}
      </div>
      <footer className="objectives-fresh-foot">
        <div className="objectives-fresh-composer" aria-disabled="true">{t("objectives.fresh.composer")}</div>
      </footer>
    </div>
  );
}

/** Console 이 가운데 칸·오른쪽 패널 머리에 세우는 시작 전 목표. 오른쪽 패널의 「목표」는 목표 레일 패널이, 「구성원」은 Console 이 명부로 진다. */
export const freshConversationSurface: ConversationSurfaceDescriptor = {
  id: FRESH_SURFACE_ID,
  title: (ctx) => findObjective(objectiveIdOf(ctx.params))?.title ?? getT(ctx.language)("objectives.state.fresh"),
  subtitle: (ctx) => getT(ctx.language)("objectives.state.fresh"),
  // 얼굴은 사이드바 줄의 표식과 같은 지휘관 아바타다(줄이 `avatarOperationId` 로 고르는 키).
  avatar: (ctx) => {
    const objectiveId = objectiveIdOf(ctx.params);
    const objective = findObjective(objectiveId);
    return objectiveId && objective ? { key: operationAvatarKey(objectiveId), role: "commander", label: objective.title, state: "fresh" } : null;
  },
  subscribe: (listener) => subscribeObjective(listener),
  // 개시하면 이 목표 id 로 지휘관 Operation 이 선다 — 오른쪽 패널은 진행 중 Operation 과 같은 머리(「목표 | 구성원」 글자 탭)로 선다.
  standInOperationId: (ctx) => objectiveIdOf(ctx.params),
  render: (ctx) => {
    const objectiveId = objectiveIdOf(ctx.params);
    return objectiveId ? <FreshObjectiveBody objectiveId={objectiveId} language={ctx.language} onClose={ctx.close} /> : null;
  },
};
