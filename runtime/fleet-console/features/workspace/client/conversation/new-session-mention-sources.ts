import { useEffect, useMemo, useState } from "react";
import type { ClientFeatureDescriptor } from "../../shared/feature-surfaces.js";

import type { OperationSearchGroup } from "../../../../core/client/src/integration/operation-search.js";
import type { ConsoleState } from "../../../../core/client/src/integration/types.js";
import { useClusterIndex } from "../operation-clusters.js";
import { buildMentionGroups, buildPluginMentionCategories, splitNotStartedGroups, type MentionCategory, type MentionTarget, type PluginMentionRow } from "./new-session-mention.js";

/**
 * 새 세션 컴포저의 '@' 원천 — 데스크톱 화면과 모바일 새 대화 시트가 같은 목록을 읽는다.
 *
 * Operation 행선지는 플러그인이 `messageOperation`과 함께 선언한 타입만, 플러그인 행선지(부관 등)는
 * `mentionTargets`·`messageMentionTarget`을 함께 선언한 플러그인만 선다. 플러그인 로스터는 설정에서 켜고 끈
 * 결과가 그대로 반영되도록 구독한다 — 마운트 시점에 굳히면 "껐는데 아직 보인다"가 나온다.
 */
export interface MentionSources {
  readonly messageableTypesByPlugin: ReadonlyMap<string | null, ReadonlySet<string>>;
  /** 질의 없는 플러그인 행 전체 — 시드 주소(composer.open)와 고른 행의 최신 이름을 찾는 데 쓴다. */
  readonly allPluginRows: readonly PluginMentionRow[];
  readonly operationGroups: readonly OperationSearchGroup[];
  /** 「시작 전」 Operation — 사이드바 「시작 전」과 같은 원천(`splitNotStartedGroups`)으로 Operations 에서 갈라낸 묶음. */
  readonly pendingGroups: readonly OperationSearchGroup[];
  readonly pluginCategories: readonly MentionCategory[];
  /** 고른 행선지를 지금 목록의 같은 행으로 읽는다. 목록에서 사라졌으면 고른 그대로 둔다(보내면 플러그인이 거절한다). */
  readonly latest: (picked: MentionTarget | null) => MentionTarget | null;
}

export function useMentionSources(state: ConsoleState, providers: readonly ClientFeatureDescriptor[], query: string | null): MentionSources {
  const messageableTypesByPlugin = useMemo(() => {
    const map = new Map<string | null, ReadonlySet<string>>();
    for (const plugin of providers) {
      if (plugin.messageOperation && (plugin.messageableOperationTypes?.length ?? 0) > 0) map.set(plugin.id, new Set(plugin.messageableOperationTypes));
    }
    return map;
  }, [providers]);
  const [rosterEpoch, setRosterEpoch] = useState(0);
  useEffect(() => {
    const changed = () => setRosterEpoch((epoch) => epoch + 1);
    const cleanups = providers.flatMap((plugin) => {
      try { return plugin.subscribeMentionTargets ? [plugin.subscribeMentionTargets(changed)] : []; }
      catch { return []; }
    });
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [providers]);
  // 목록이 열릴 때(query가 null에서 바뀔 때)마다 다시 읽는다 — 로스터 구독을 선언하지 않은 플러그인도 따라온다.
  const opened = query !== null;
  const allPluginRows = useMemo(
    () => buildPluginMentionCategories(providers, "").flatMap((category) => category.rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, rosterEpoch, opened],
  );
  const clusterIndex = useClusterIndex();
  const { operationGroups, pendingGroups } = useMemo(
    () => (query === null
      ? { operationGroups: [], pendingGroups: [] }
      : splitNotStartedGroups(buildMentionGroups(state, messageableTypesByPlugin, query), (operationId) => clusterIndex.rowOf.get(operationId)?.cluster.row)),
    [clusterIndex, messageableTypesByPlugin, query, state],
  );
  const pluginCategories = useMemo(
    () => (query === null ? [] : buildPluginMentionCategories(providers, query)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, query, rosterEpoch],
  );
  const latest = useMemo(() => (picked: MentionTarget | null): MentionTarget | null => {
    if (picked?.kind !== "plugin") return picked;
    const row = allPluginRows.find((candidate) => candidate.optionId === picked.row.optionId);
    return row && row !== picked.row ? { kind: "plugin", row } : picked;
  }, [allPluginRows]);
  return { messageableTypesByPlugin, allPluginRows, operationGroups, pendingGroups, pluginCategories, latest };
}
