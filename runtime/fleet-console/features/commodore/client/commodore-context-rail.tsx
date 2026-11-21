import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { useAvatarAccent } from "../../workspace/client/avatar-accent.js";
import { openCommanderConversation } from "../../workspace/client/commander-tab/commander-navigation.js";
import { registerContextRailProvider, type ContextRailProvider } from "../../workspace/client/conversation/context-rail/registry.js";
import type { ContextRailExtraItem, ContextRailMeasure } from "../../workspace/shared/context-rail.js";
import { commodoreAvatarKey, type MongleState } from "../../workspace/shared/avatars.js";
import type { CommodoreRunStatus } from "../shared/contracts/types.js";
import { finishedObjectives, isRunningObjective, useObjectiveTheater } from "./board.js";
import { CommodoreAvatar } from "./commodore-avatar.js";
import { COMMODORE_SURFACE_ID } from "./commodore-conversation.js";
import { nextRoutineWord } from "./commodore-header.js";
import { useCommodoreName, commodoreName } from "./commodore-name.js";
import { CommodoreRoutines } from "./commodore-routines.js";
import { commodoreTasksList, loadCommodore, readCommodore, subscribeCommodore, useCommodore } from "./commodore-state.js";
import { TASKFORCE_SURFACE_ID } from "./taskforce/taskforce.js";
import { useTaskforce } from "./taskforce/state.js";
import { getT } from "./i18n/index.js";

const GoalsChipGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.3" />
  </svg>
);

const RoutinesChipGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.45-3.55" />
    <path d="M13 3.2v2.7h-2.7" />
  </svg>
);

/**
 * 사령관 대화의 우측 부유 엣지 스택 제공자. 컨텍스트 창 링 칩 아래에 목표·루틴 미니 칩을 세로로 적층한다.
 * 사령관의 75% 요약·이어 가기 같은 내부 정책은 호스트가 그대로 쥐고 있고, 여기는 보이는 방식만 통일한다.
 * 사령관 기록을 읽기 전용으로 보는 목표 화면에서는 그리지 않는다.
 */
const CommodoreContextRail: ContextRailProvider = ({ scope, children }) => {
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const t = getT(language);
  const commodoreId = scope.kind === "surface" && scope.surfaceId === COMMODORE_SURFACE_ID && scope.params.readOnly !== true && typeof scope.params.commodoreId === "string"
    ? scope.params.commodoreId
    : null;
  const { view } = useCommodore(commodoreId);
  const board = useObjectiveTheater(commodoreId);
  const name = useCommodoreName(commodoreId ?? "", t);
  const accent = useAvatarAccent(commodoreId ? commodoreAvatarKey(commodoreId) : null);
  const tasks = commodoreTasksList();
  if (commodoreId === null) return null;

  const measure = measureOf(view?.run?.context);
  // 사령관은 대화가 창의 일정 비율에 닿으면 요약해 같은 세션에서 이어 간다 — 그 정책은 그대로이고 꼬리 문구가 말한다.
  const footnote = measure?.compactAt !== undefined ? t("commodore.context.foot", { percent: Math.round((measure.compactAt / measure.max) * 100) }) : undefined;

  const openGoals = board.objectives.filter((objective) => objective.removed === null && objective.done === null);
  const activeGoals = openGoals.filter((objective) => objective.commenced || isRunningObjective(objective));
  const leadGoal = activeGoals[0] ?? null;
  const leadProgress = leadGoal && leadGoal.missions.length > 0
    ? ` (${leadGoal.missions.filter((mission) => mission.done !== null).length}/${leadGoal.missions.length})`
    : "";
  const goalsValue = activeGoals.length > 0 && activeGoals.length < openGoals.length
    ? `${activeGoals.length}/${openGoals.length}`
    : String(openGoals.length);
  const goalsBubbleTitle = openGoals.length > 0 ? t("commodore.edge.goalsCount", { n: openGoals.length }) : t("commodore.tasks.goals");
  const goalsBubbleDetail = leadGoal
    ? t("commodore.edge.goalsRunning", { title: `${leadGoal.title}${leadProgress}` })
    : openGoals.length > 0
      ? t("commodore.edge.goalsIdle")
      : t("commodore.edge.goalsEmpty");
  const hasAnyGoals = openGoals.length > 0 || finishedObjectives(commodoreId).length > 0 || !board.loaded;

  const routines = view?.state.routines ?? [];
  const enabledRoutines = routines.filter((routine) => routine.enabled).length;
  const nextRoutine = nextRoutineWord(t, view);
  const routinesBubbleTitle = routines.length > 0
    ? t("commodore.routines.count", { n: enabledRoutines, total: routines.length })
    : t("commodore.tasks.routines");
  const routinesBubbleDetail = nextRoutine ?? t("commodore.edge.routinesEmpty");

  const extras: ContextRailExtraItem[] = [];
  if (tasks !== null) {
    extras.push({
      id: "goals",
      label: t("commodore.edge.goalsAria", { summary: goalsBubbleTitle }),
      icon: <GoalsChipGlyph />,
      value: goalsValue,
      dot: activeGoals.length > 0,
      bubbleTitle: goalsBubbleTitle,
      bubbleDetail: goalsBubbleDetail,
      panelTitle: t("commodore.tasks.goals"),
      panelSubtitle: name,
      render: (close) => (
        <div className="commodore-edge-panel workspace-avatar-panel" style={accent ?? undefined}>
          {hasAnyGoals ? (
            <tasks.List
              commodoreId={commodoreId}
              selectedId={null}
              heading={null}
              onSelect={({ objectiveId, open }) => {
                close();
                if (objectiveId !== null) openCommanderConversation(commodoreId, objectiveId);
                else open?.();
              }}
            />
          ) : (
            <p className="commodore-edge-empty">{t("commodore.edge.goalsEmptyBody")}</p>
          )}
        </div>
      ),
    });
  }
  extras.push({
    id: "routines",
    label: t("commodore.edge.routinesAria", { summary: routinesBubbleTitle }),
    icon: <RoutinesChipGlyph />,
    value: String(enabledRoutines),
    dot: enabledRoutines > 0,
    bubbleTitle: routinesBubbleTitle,
    bubbleDetail: routinesBubbleDetail,
    panelTitle: t("commodore.tasks.routines"),
    panelSubtitle: name,
    render: () => (
      <div className="commodore-edge-panel workspace-avatar-panel" style={accent ?? undefined}>
        <CommodoreRoutines commodoreId={commodoreId} language={language} />
      </div>
    ),
  });

  return <>{children([{
    id: commodoreId,
    name,
    role: "commodore",
    measure,
    focus: true,
    avatar: <CommodoreAvatar commodoreId={commodoreId} state={railMongleState(view)} size={26} label="" decorative />,
    ...(footnote ? { footnote } : {}),
  }], extras)}</>;
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
    return (members ?? []).map((id) => {
      const view = readCommodore(id).view;
      return {
        id,
        name: commodoreName(id, t),
        role: "commodore" as const,
        measure: measureOf(view?.run?.context),
        focus: false,
        avatar: <CommodoreAvatar commodoreId={id} state={railMongleState(view)} size={26} label="" decorative />,
      };
    });
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

/** 칩 얼굴의 상태. 턴이면 작업 중, 실패·재시도면 오류, 아니면 쉼이다. */
function railMongleState(view: { readonly run: { readonly phase: string } } | null | undefined): MongleState {
  if (!view) return "idle";
  if (view.run.phase === "error" || view.run.phase === "retrying") return "error";
  if (view.run.phase === "turn") return "running";
  return "idle";
}

/** 호스트가 알려 준 컨텍스트를 레일 카드의 측정으로. 내역을 얻지 못한 세션(창을 모르는 Gateway 모델 등)은 총량만 그린다. */
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
    skills: detail?.skills ?? [],
  };
}

export function registerCommodoreContextRail(): () => void {
  const offs = [registerContextRailProvider(CommodoreContextRail), registerContextRailProvider(TaskforceContextRail)];
  return () => { for (const off of offs) off(); };
}
