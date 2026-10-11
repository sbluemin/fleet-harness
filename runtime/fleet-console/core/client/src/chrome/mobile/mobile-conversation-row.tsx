import { useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { MongleState } from "@fleet-console/sdk/avatars";

import { OperationAvatar, clusterFaceFacts, clusterWorkingMembers, mongleStateOfMark, type ClusterWorkingMember } from "../../../../../features/workspace/client/avatars.js";
import { useClusterIndex, useOperationClusters } from "../../../../../features/workspace/client/operation-clusters.js";
import { resolveOperationActivity, resolveOperationMarkVisual } from "../../../../../features/execution/client/operation-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../../../features/execution/client/operation-marks.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import type { ConsoleState, OperationNode } from "../../integration/types.js";
import { operationHarnessLabel } from "./mobile-operation-label.js";

/**
 * 대화 목록의 한 행이 읽는 사실. 대화의 단위는 지휘관 묶음이다 — 최상위 Operation 하나가 행 하나이고, 묶음의 구성원은 행으로 서지 않고
 * 지휘관 아바타 옆 미니 아바타로만 선다. 아바타 얼굴·구성원 셈법은 데스크톱 대화 중심 화면 사이드바와 같은 원천(`features/workspace`)이다.
 */
export interface MobileConversation {
  readonly operation: OperationNode;
  /** 지휘관의 얼굴 — 사이드바와 같은 기준(`mongleStateOf`)을 지난다. */
  readonly face: MongleState;
  /** 지금 일하는 구성원(최대 3). 묶음이 아니면 비어 있다. */
  readonly minis: readonly ClusterWorkingMember[];
  /** 묶음의 구성원 수(자리표시 제외). 묶음이 아니면 0이다. */
  readonly memberCount: number;
  /** 목표(묶음)의 뿌리인가 — 검색 결과의 종류 라벨이 읽는다. */
  readonly isCluster: boolean;
}

/**
 * Operation 하나를 대화로 읽는 함수 — 목록 행·검색 결과·Operation 화면 머리·정보 화면이 같은 셈법을 쓴다. 구성원 Operation도 읽을 수 있고
 * (묶음의 뿌리가 아니라 미니 아바타 없이 자기 얼굴만 가진다), 상태가 바뀌면 새 함수가 선다.
 */
export function useMobileConversationOf(state: Pick<ConsoleState, "operations" | "nestedOperations" | "operationRuntime">): (operation: OperationNode) => MobileConversation {
  const index = useClusterIndex();
  const clusters = useOperationClusters();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const { operations, nestedOperations, operationRuntime } = state;
  return useMemo(() => (operation: OperationNode): MobileConversation => {
    const mark = resolveOperationMarkVisual({ activity: resolveOperationActivity(operation, operationRuntime), operationId: operation.id, idleArrivalIds });
    const layout = index.rootOf.get(operation.id);
    const members = layout ? layout.cluster.members.filter((member) => !member.pending && member.operationId !== operation.id) : [];
    return {
      operation,
      face: mongleStateOfMark(mark, clusterFaceFacts(clusters, operation.id)),
      minis: layout ? clusterWorkingMembers(layout.cluster, operation.id, { operations, nestedOperations, operationRuntime }) : [],
      memberCount: members.length,
      isCluster: layout !== undefined,
    };
  }, [clusters, idleArrivalIds, index, nestedOperations, operationRuntime, operations]);
}

/** 모든 Theater의 최상위 Operation을 대화로 읽는다 — 호출부가 Theater로 거른다. */
export function useMobileConversations(state: Pick<ConsoleState, "operations" | "nestedOperations" | "operationRuntime">): readonly MobileConversation[] {
  const conversationOf = useMobileConversationOf(state);
  return useMemo(() => state.operations.map(conversationOf), [conversationOf, state.operations]);
}

/** 대화 행의 아바타 — 지휘관 얼굴 하나와, 일하는 구성원이 있으면 오른쪽 아래에 겹친 미니 아바타. */
export function ConversationAvatar({ conversation, size = 52 }: { readonly conversation: MobileConversation; readonly size?: number }) {
  const { operation, face, minis } = conversation;
  const main = minis.length > 0 ? Math.round(size * 0.86) : size;
  return (
    // 미니 아바타 상자와 겹침 간격은 아바타 크기에 비례한다 — 목록 행(52)·머리 pill(36)·정보 화면(110)이 같은 모양이다.
    <span className="mobile-conv-avatar" style={{ width: size, height: size, ["--conv-mini" as string]: `${Math.round(size * 0.38)}px`, ["--conv-mini-overlap" as string]: `${Math.round(size * 0.13)}px`, ["--conv-mini-offset" as string]: `${Math.round(size * 0.07)}px` }}>
      <OperationAvatar operation={operation} state={face} size={main} label="" decorative />
      {minis.length > 0 ? (
        <span className="mobile-conv-avatar-stack" aria-hidden="true">
          {minis.map((entry) => (
            <span className="mobile-conv-avatar-mini" key={entry.operation.id}>
              <OperationAvatar operation={entry.operation} role="member" state={mongleStateOfMark(entry.mark)} size={Math.round(size * 0.34)} label="" decorative />
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** 얼굴 상태를 말하는 낱말 — 대화 행 둘째 줄과 검색 결과 보조 줄이 같은 말을 쓴다. */
export function conversationStateWord(face: MongleState, t: ReturnType<typeof useT>): string {
  switch (face) {
    case "decision": return t("mobile.list.state.decision");
    case "awaiting": return t("mobile.search.state.awaiting");
    case "running": return t("mobile.search.state.running");
    case "unseen": return t("mobile.search.state.unseen");
    case "ended": return t("mobile.search.state.ended");
    case "fresh": return t("mobile.search.state.fresh");
    case "review": return t("mobile.search.state.review");
    case "done": return t("mobile.search.state.done");
    default: return t("mobile.search.state.idle");
  }
}

/** 상태 요약 — 상태 낱말(색이 상태를 말한다)에 구성원 수나 하네스·보는 방식을 잇는다. 이미 클라이언트에 있는 사실만 쓴다. */
export function ConversationSummary({ conversation }: { readonly conversation: MobileConversation }) {
  const t = useT();
  const { face, memberCount, operation } = conversation;
  const word = conversationStateWord(face, t);
  const detail = memberCount > 0 ? t("mobile.list.members", { count: memberCount }) : operationHarnessLabel(operation, t);
  return (
    <>
      <span className={`mobile-conv-state is-${face}`}>{word}</span>
      {detail ? ` · ${detail}` : null}
    </>
  );
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
function timeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let format = timeFormats.get(key);
  if (!format) { format = new Intl.DateTimeFormat(locale, options); timeFormats.set(key, format); }
  return format;
}

/** 오늘이면 시각, 어제면 「어제」, 그 밖에는 월·일 — 행 오른쪽의 마지막 갱신 시각. */
export function useConversationTime(): (timestamp: number) => string {
  const locale = useConsoleLocale() === "ko" ? "ko-KR" : "en-US";
  const t = useT();
  return (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (timestamp >= startOfToday) return timeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
    if (timestamp >= startOfToday - 86_400_000) return t("mobile.list.yesterday");
    return timeFormat(locale, { month: "short", day: "numeric" }).format(date);
  };
}

/** 대화 행 한 줄 — 아바타 · 제목 · (시각 또는 종류 라벨) · 둘째 줄. 둘째 줄은 호출부가 정한다. */
export function ConversationRow({ conversation, sub, trailing, onOpen }: {
  readonly conversation: MobileConversation;
  readonly sub: ReactNode;
  /** 오른쪽 위 칸 — 생략하면 마지막 갱신 시각. */
  readonly trailing?: ReactNode;
  readonly onOpen: () => void;
}) {
  const time = useConversationTime();
  return (
    <button type="button" data-press="r1" className="mobile-conv-row" onClick={onOpen}>
      <span className="mobile-conv-row-av"><ConversationAvatar conversation={conversation} /></span>
      <span className="mobile-conv-row-copy">
        <span className="mobile-conv-row-top">
          <span className="mobile-conv-row-title">{conversation.operation.title}</span>
          <span className="mobile-conv-row-aside">{trailing ?? time(conversation.operation.ts.updatedAt)}</span>
        </span>
        <span className="mobile-conv-row-sub">{sub}</span>
      </span>
    </button>
  );
}
