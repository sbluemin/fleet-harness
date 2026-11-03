import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { registerContextRailProvider, type ContextRailProvider } from "../../workspace/client/conversation/context-rail/registry.js";
import type { ContextRailMeasure } from "../../workspace/shared/context-rail.js";
import type { CommodoreRunStatus } from "../shared/contracts/types.js";
import { COMMODORE_SURFACE_ID } from "./commodore-conversation.js";
import { useCommodoreName } from "./commodore-name.js";
import { commodoreName } from "./commodore-name.js";
import { loadCommodore, readCommodore, subscribeCommodore, useCommodore } from "./commodore-state.js";
import { TASKFORCE_SURFACE_ID } from "./taskforce/taskforce.js";
import { useTaskforce } from "./taskforce/state.js";
import { getT } from "./i18n/index.js";

/**
 * 사령관 대화의 컨텍스트 레일 제공자. 사령관 상주 세션의 카드 한 장이고, 내용은 지휘관·구성원 원장과 같은 컨텍스트 창이다.
 * 사령관의 75% 요약·이어 가기 같은 내부 정책은 호스트가 그대로 쥐고 있고, 여기는 보이는 방식만 통일한다. 사령관 기록을 읽기 전용으로
 * 보는 목표 화면에서는 그리지 않는다.
 */
const CommodoreContextRail: ContextRailProvider = ({ scope, children }) => {
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const commodoreId = scope.kind === "surface" && scope.surfaceId === COMMODORE_SURFACE_ID && scope.params.readOnly !== true && typeof scope.params.commodoreId === "string"
    ? scope.params.commodoreId
    : null;
  const { view } = useCommodore(commodoreId);
  const name = useCommodoreName(commodoreId ?? "", getT(language));
  if (commodoreId === null) return null;
  const measure = measureOf(view?.run?.context);
  // 사령관은 대화가 창의 일정 비율에 닿으면 요약해 같은 세션에서 이어 간다 — 그 정책은 그대로이고 꼬리 문구가 말한다.
  const footnote = measure?.compactAt !== undefined ? getT(language)("commodore.context.foot", { percent: Math.round((measure.compactAt / measure.max) * 100) }) : undefined;
  return <>{children([{ id: commodoreId, name, role: "commodore", measure, focus: true, ...(footnote ? { footnote } : {}) }])}</>;
};

/**
 * 사령관 합동 채팅(TaskForce)의 컨텍스트 레일 제공자. 참여 사령관마다 카드 한 장이고, 내용은 사령관 대화의 카드와 같다.
 * 참여자 수가 달라지므로 훅을 사령관마다 부를 수 없다 — 사령관 상태의 변화를 한 번호로 구독해 한꺼번에 읽는다.
 */
const TaskforceContextRail: ContextRailProvider = ({ scope, children }) => {
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const taskforceId = scope.kind === "surface" && scope.surfaceId === TASKFORCE_SURFACE_ID && typeof scope.params.taskforceId === "string" ? scope.params.taskforceId : null;
  const members = useTaskforce(taskforceId ?? "").state?.members ?? null;
  // 참여 사령관의 상태가 아직 읽히지 않았으면 읽는다 — 이 대화를 연 사람이 그 사령관들을 따로 연 적이 없을 수 있다.
  useEffect(() => { for (const id of members ?? []) void loadCommodore(id); }, [members]);
  const revision = useSyncExternalStore(subscribeCommodoreRevision, getCommodoreRevision, getCommodoreRevision);
  const sessions = useMemo(() => {
    const t = getT(language);
    return (members ?? []).map((id) => ({
      id,
      name: commodoreName(id, t),
      role: "commodore" as const,
      measure: measureOf(readCommodore(id).view?.run?.context),
      focus: false,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision 이 사령관 상태의 변화를 알린다.
  }, [members, revision, language]);
  if (taskforceId === null || sessions.length === 0) return null;
  return <>{children(sessions)}</>;
};

let commodoreRevision = 0;
const commodoreRevisionListeners = new Set<() => void>();
let stopCommodoreRevision: (() => void) | null = null;
function subscribeCommodoreRevision(listener: () => void): () => void {
  commodoreRevisionListeners.add(listener);
  stopCommodoreRevision ??= subscribeCommodore(() => { commodoreRevision += 1; for (const each of commodoreRevisionListeners) each(); });
  return () => {
    commodoreRevisionListeners.delete(listener);
    if (commodoreRevisionListeners.size === 0) { stopCommodoreRevision?.(); stopCommodoreRevision = null; }
  };
}
const getCommodoreRevision = () => commodoreRevision;

/** 호스트가 알려 준 컨텍스트를 레일 카드의 측정으로. 내역을 얻지 못한 세션(Gateway 모델 등)은 총량만 그린다. */
export function measureOf(context: CommodoreRunStatus["context"]): ContextRailMeasure | null {
  if (!context) return null;
  const detail = context.detail;
  // 내역이 있으면 카드의 합계와 칩·비율이 같은 수여야 한다 — 마지막 호출의 입력은 같은 창을 다른 자로 잰 값이다.
  const occupied = detail ? detail.total : context.inputTokens;
  if (context.window <= 0 || occupied <= 0) return null;
  return {
    occupied,
    max: context.window,
    ...(context.compactAt !== undefined ? { compactAt: context.compactAt } : {}),
    ...(detail?.reserved !== undefined ? { reserved: detail.reserved } : {}),
    slices: detail?.slices ?? [],
    memoryFiles: detail?.memoryFiles ?? [],
    mcpTools: detail?.mcpTools ?? [],
  };
}

export function registerCommodoreContextRail(): () => void {
  const offs = [registerContextRailProvider(CommodoreContextRail), registerContextRailProvider(TaskforceContextRail)];
  return () => { for (const off of offs) off(); };
}
