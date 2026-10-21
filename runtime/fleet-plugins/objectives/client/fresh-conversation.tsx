import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import { operationAvatarKey } from "@fleet-console/sdk/avatars";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "@fleet-console/sdk/plugin";

import type { Objective } from "../server/types.js";
import { getT } from "./i18n/index.js";
import { FRESH_SURFACE_ID, ensureFinishedObjectives, findAnyObjective, findFinishedObjective, subscribeFinishedObjectivesStore, finishedObjectivesFailed, finishedObjectivesLoaded, finishedObjectivesLoading, loadFinishedObjectives, focusOperation, listedOperationSummaries, openObjectiveFromCluster, patchObjectiveView, revealObjective, subscribeObjective, subscribeObjectiveOrFinished } from "./objectives-state.js";

/**
 * 대화 중심 화면의 「시작 전」 목표 — 지휘관 Operation 이 아직 없는 목표를 첫 메시지가 없는 대화처럼 가운데 칸에 세운다.
 * 완료해 지휘관이 보관된 목표도 같은 칸에 「완료」로 선다 — 입력창의 말은 지휘관에게 가고(범위 넓히기는 고르는 칩), 보내면 서버가 지휘관을 휴면으로 복원한다.
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
 * `theaterId` 를 주면 보관된 완료 목표를 찾을 Theater 도 된다 — 읽어 둔 끝난 목표에 없으면(그 뒤에 완료로 보관됐다) 다시 읽고, 다 읽기 전에는 칸이 서 있다.
 */
export function openFreshConversation(objectiveId: string, theaterId?: string): boolean {
  if (!port || !port.isActive()) return false;
  if (theaterId) refreshFinishedFor(objectiveId, theaterId);
  const target = theaterId ?? findObjective(objectiveId)?.theaterId;
  return port.open(FRESH_SURFACE_ID, { objectiveId, ...(target ? { theaterId: target } : {}) });
}

/** 살아 있는 목록에도 읽어 둔 끝난 목표에도 없으면 그 Theater 의 끝난 목표를 다시 읽는다 — 끝난 목표 캐시는 완료로 보관되기 전에 읽혔을 수 있다. */
function refreshFinishedFor(objectiveId: string, theaterId: string): void {
  if (findAnyObjective(objectiveId) === null) loadFinishedObjectives(theaterId);
  else ensureFinishedObjectives(theaterId);
}

/**
 * 목표의 가운데 칸을 연다 — 지휘관 Operation 이 목록에 있으면 그 대화로, 없으면 복원하지 않고 가운데 칸에 시작 화면(시작 전 목표)이나
 * 완료 화면(보관된 끝난 목표)을 세운다. 범위 넓히기는 완료 화면의 입력창이 받는다. 대화 중심 화면이 꺼져 있으면 false.
 */
export function openObjectiveConversation(objectiveId: string, theaterId: string): boolean {
  if (commanderLive(objectiveId)) { focusOperation(objectiveId); return true; }
  return openFreshConversation(objectiveId, theaterId);
}

/**
 * 데스크톱에서 한 목표로 간다 — 가운데 칸에 그 목표의 대화(지휘관 대화, 없으면 시작·완료 화면)를 세우고 레일의 목표 패널을 연다. 레일만
 * 바꾸면 가운데 칸과 입력창이 앞 목표에 남는다. 완료로 보관된 목표(`done`)는 살아 있는 목록에 없으므로, 보드가 reveal 대신 가운데 완료 화면이
 * 읽은 끝난 목표 레코드를 고르게 한다. 대화를 세웠으면 Theater 를 따로 옮기지 않는다(옮기기는 가운데 대화를 걷는다). 팔레트의 목표 결과와
 * 사령관 기록의 참조 토큰이 이 하나로 연다.
 */
export function goToObjective(objectiveId: string, theaterId: string, done: boolean): void {
  const shown = openObjectiveConversation(objectiveId, theaterId);
  if (done && shown) patchObjectiveView(theaterId, () => ({ selected: objectiveId, externalSelectionId: null }));
  else revealObjective({ objectiveId });
  if (shown) openObjectiveFromCluster();
  else openObjectiveFromCluster(theaterId, objectiveId);
}

/** 지금 가운데 칸에 시작 화면이 선 목표. 없으면 null. */
export function freshConversationObjectiveId(): string | null {
  const current = port?.current() ?? null;
  if (current?.surfaceId !== FRESH_SURFACE_ID) return null;
  const objectiveId = current.params.objectiveId;
  return typeof objectiveId === "string" ? objectiveId : null;
}

/**
 * 가운데 완료 화면이 세운 보관된 완료 목표 — 살아 있는 목록에 없고 읽어 둔 끝난 목표에만 있는 레코드. 레일의 보드가 같은 레코드를 보인다.
 * 없으면 null. 같은 상태면 같은 참조다.
 */
export function shownFinishedObjective(): Objective | null {
  const objectiveId = freshConversationObjectiveId();
  if (!objectiveId) return null;
  const finished = findFinishedObjective(objectiveId);
  return finished !== null && findAnyObjective(objectiveId) === finished ? finished : null;
}

/** 가운데 칸이나 끝난 목표가 바뀌면 깨운다. */
export function subscribeShownFinished(listener: () => void): () => void {
  const offFresh = subscribeFreshConversation(listener);
  const offFinished = subscribeFinishedObjectivesStore(listener);
  return () => { offFresh(); offFinished(); };
}

/** 대화 배치·가운데 칸이 바뀌면 깨운다 — 사이드바 줄의 선택 표시가 가운데 칸을 따른다. */
export function subscribeFreshConversation(listener: () => void): () => void {
  return port?.subscribe(listener) ?? (() => {});
}

const objectiveIdOf = (params: Readonly<Record<string, unknown>>): string | null => (typeof params.objectiveId === "string" ? params.objectiveId : null);
/** 살아 있는 목록에서, 없으면 읽어 둔 끝난 목표(보관)에서 — 완료 화면과 그 입력창의 보드 동작이 같은 레코드를 읽는다. */
const findObjective = (objectiveId: string | null): Objective | null => (objectiveId === null ? null : findAnyObjective(objectiveId));
const theaterIdOf = (params: Readonly<Record<string, unknown>>): string | null => (typeof params.theaterId === "string" ? params.theaterId : null);
/** 지휘관 Operation 이 목록에 섰다 — 보관 describe 요약(완료로 보관된 지휘관)은 세지 않는다. */
const commanderLive = (objectiveId: string): boolean => listedOperationSummaries().some((summary) => summary.id === objectiveId);

function FreshObjectiveBody({ objectiveId, theaterId, language, onClose, composer }: { readonly objectiveId: string; readonly theaterId: string | null; readonly language: "en" | "ko"; readonly onClose: () => void; readonly composer: (() => ReactNode) | undefined }) {
  const t = getT(language);
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, () => findObjective(objectiveId), () => findObjective(objectiveId));
  const live = useSyncExternalStore(subscribeObjective, () => commanderLive(objectiveId), () => commanderLive(objectiveId));
  // 보관된 완료 목표는 그 Theater 의 끝난 목표를 (다시) 읽은 뒤에야 찾는다 — 읽는 동안에는 칸을 걷지 않고, 읽기가 실패하면 오류와 다시 시도를 보인다.
  const failedNow = () => theaterId !== null && finishedObjectivesFailed(theaterId);
  const waiting = () => theaterId !== null && (finishedObjectivesLoading(theaterId) || (!finishedObjectivesLoaded(theaterId) && !failedNow()));
  const pending = useSyncExternalStore(subscribeObjectiveOrFinished, waiting, () => false);
  const failed = useSyncExternalStore(subscribeObjectiveOrFinished, failedNow, () => false);
  useEffect(() => { if (theaterId) refreshFinishedFor(objectiveId, theaterId); }, [objectiveId, theaterId]);
  // 개시·범위 넓히기·완료 뒤 메시지로 지휘관 Operation 이 서면 그 대화로 넘긴다. 목표가 사라지면(정리) 칸을 걷어 직전 대화로 돌아간다.
  // 읽는 중인지는 렌더 값이 아니라 지금 값으로 본다 — 바로 위 효과가 같은 커밋에서 다시 읽기를 시작했을 수 있다.
  useEffect(() => {
    if (live) focusOperation(objectiveId);
    else if ((objective === null && !waiting() && !failedNow()) || objective?.removed) onClose();
  }, [live, objective, objectiveId, onClose, pending, failed]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!objective) {
    if (!failed || theaterId === null) return null;
    return (
      <div className="objectives-fresh-conversation">
        <div className="objectives-fresh-start">
          <p className="objectives-fresh-brief is-empty" role="alert">{t("objectives.fresh.loadFailed")}</p>
          <button type="button" className="objectives-btn is-small" onClick={() => loadFinishedObjectives(theaterId)}>{t("objectives.followup.retry")}</button>
        </div>
      </div>
    );
  }
  const met = objective.criteria.filter((criterion) => !!criterion.met).length;
  return (
    <div className="objectives-fresh-conversation">
      <div className="objectives-fresh-start">
        <span className="objectives-fresh-label">{objective.done ? t("objectives.graph.state.done") : <><span className="objectives-fresh-ring" aria-hidden="true" />{t("objectives.state.fresh")}</>}</span>
        <h2 className="objectives-fresh-title">{objective.title}</h2>
        {objective.note.trim()
          ? <p className="objectives-fresh-brief">{objective.note}</p>
          : <p className="objectives-fresh-brief is-empty">{t("objectives.fresh.noBrief")}</p>}
        {objective.criteria.length > 0
          ? <p className="objectives-fresh-meta">{t("objectives.criteria.title")} · {t("objectives.criteria.count", { met, total: objective.criteria.length })}</p>
          : null}
      </div>
      {/* 입력창은 호스트의 그룹 입력창이다 — 시작 전에는 구상·개시, 완료한 목표는 지휘관에게 가는 말과 범위 넓히기 칩을 받는다(보드 동작 계약). */}
      {composer ? composer() : (
        <footer className="objectives-fresh-foot">
          <div className="objectives-fresh-composer" aria-disabled="true">{t("objectives.fresh.composer")}</div>
        </footer>
      )}
    </div>
  );
}

/** Console 이 가운데 칸·오른쪽 패널 머리에 세우는 시작 전 목표. 오른쪽 패널의 「목표」는 목표 레일 패널이, 「구성원」은 Console 이 명부로 진다. */
export const freshConversationSurface: ConversationSurfaceDescriptor = {
  id: FRESH_SURFACE_ID,
  title: (ctx) => findObjective(objectiveIdOf(ctx.params))?.title ?? getT(ctx.language)("objectives.state.fresh"),
  subtitle: (ctx) => getT(ctx.language)(findObjective(objectiveIdOf(ctx.params))?.done ? "objectives.graph.state.done" : "objectives.state.fresh"),
  // 얼굴은 사이드바 줄의 표식과 같은 지휘관 아바타다(줄이 `avatarOperationId` 로 고르는 키).
  avatar: (ctx) => {
    const objectiveId = objectiveIdOf(ctx.params);
    const objective = findObjective(objectiveId);
    return objectiveId && objective ? { key: operationAvatarKey(objectiveId), role: "commander", label: objective.title, state: objective.done ? "done" : "fresh" } : null;
  },
  subscribe: (listener) => subscribeObjectiveOrFinished(listener),
  // 개시하면 이 목표 id 로 지휘관 Operation 이 선다 — 오른쪽 패널은 진행 중 Operation 과 같은 머리(「목표 | 구성원」 글자 탭)로 선다.
  standInOperationId: (ctx) => objectiveIdOf(ctx.params),
  render: (ctx) => {
    const objectiveId = objectiveIdOf(ctx.params);
    return objectiveId ? <FreshObjectiveBody objectiveId={objectiveId} theaterId={theaterIdOf(ctx.params)} language={ctx.language} onClose={ctx.close} composer={ctx.composer} /> : null;
  },
};
