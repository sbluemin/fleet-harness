import type { OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { getT } from "./i18n/index.js";
import type { OperationNode } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

// 표시 어휘는 한 번에 한 모습만 그린다. 수명주기 dormant(프로세스 없음)는 화면에서 ended 로 읽힌다 —
// 복원 Claude/Codex/Shell 이 서로 다른 색·단어를 쓰면 같은 사실이 세 이야기로 갈라진다.
export type OperationActivityVisual = "running" | "background" | "awaiting" | "ended" | "idle";

// 런타임 맵에 항목이 없는 Operation의 분류 폭백. 방금 만든 셸/에이전트는 스냅샷 전에
// 런타임이 비어 있으므로, 복원 마커가 있을 때만 ended 다. resumeAvailable 은 Claude 재개
// 경로이고, restoredDormant 는 부팅 복원 Shell·Agent 공통 마커다.
// 사이드바 STATUS 축, Operation 검색, 팔레트 뱃지가 같은 원천 활동 분류를 공유하도록 이 함수가 단일 기준이다.
export function resolveOperationActivity(
  operation: OperationNode,
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
): OperationActivityVisual {
  const live = operationRuntime[operation.id];
  if (live) return runtimeStateVisual(live);
  return isRestoredAbsentOperation(operation) ? "ended" : "idle";
}

export function isRestoredAbsentOperation(operation: OperationNode): boolean {
  return operation.payload?.restoredDormant === true || operation.payload?.resumeAvailable === true;
}

// 런타임 상태 → 표시 어휘. 프로세스 없음은 활동값을 가지지 않으므로 여기서만 두 축이 만난다.
export function runtimeStateVisual(state: OperationRuntimeState): OperationActivityVisual {
  return state.lifecycle === "dormant" ? "ended" : state.activity;
}

// 미관측(맵에 항목 없음)은 표시 어휘로도 미관측이다 — 폭백 분류가 필요한 소비처는
// resolveOperationActivity를 쓰고, 여기서는 "모른다"를 유휴로 접지 않는다.
export function operationRuntimeVisual(state: OperationRuntimeState | undefined): OperationActivityVisual | undefined {
  return state ? runtimeStateVisual(state) : undefined;
}

// 플러그인 본문에 넘기는 런타임 축. degraded 는 "모른다"는 뜻이므로 마지막으로 알던 값을 지금의
// 사실처럼 넘기지 않는다 — 그러면 패널은 끊긴 축 위에서 계속 작업 중이라고 말한다.
// 칩 쪽은 재가된 대로 배너 하나로만 말하고 마지막 표시를 유지한다(여기와 다른 결정, 다른 표면).
export function pluginRuntimeState(
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
  hydration: OperationRuntimeHydration,
  operationId: string,
): OperationRuntimeState | null {
  if (hydration === "degraded") return null;
  return operationRuntime[operationId] ?? null;
}

// 표시 어휘 하나에서 런타임 상태를 되짚는다. 표시 축은 두 축이 합류한 뒤라 일반적으로 역함수가
// 없지만, 휴면만 수명주기로 갈라지고 나머지는 그대로 활동이므로 이 방향은 유일하게 결정된다.
export function runtimeStateOfVisual(visual: OperationActivityVisual): OperationRuntimeState {
  return visual === "ended" ? { lifecycle: "dormant" } : { lifecycle: "live", activity: visual };
}

export function resolveOperationDisplayActivity({
  activity,
  operationId,
  idleArrivalIds,
}: {
  readonly activity: OperationActivityVisual;
  readonly operationId: string;
  readonly idleArrivalIds: ReadonlySet<string>;
}): OperationActivityVisual {
  return activity === "idle" && idleArrivalIds.has(operationId) ? "awaiting" : activity;
}

// 마크 축 — 상태 마크가 그리는 값. 섹션·선별 축(resolveOperationDisplayActivity)과 갈라진다:
// 그쪽은 미확인 도착을 AWAITING 칸에 세워 사용자가 놓치지 않게 하고, 이쪽은 그것을 자기 값으로
// 남겨 색이 사실을 바꾸지 않게 한다. 사람을 기다리는 중(aurora)과 이미 끝났는데 안 본 것(positive)은
// 다른 일이고, 한 색으로 뭉치면 화면은 둘을 구별해 주지 못한다.
export type OperationMarkVisual = OperationActivityVisual | "unseen";

export function resolveOperationMarkVisual({
  activity,
  operationId,
  idleArrivalIds,
}: {
  readonly activity: OperationActivityVisual;
  readonly operationId: string;
  readonly idleArrivalIds: ReadonlySet<string>;
}): OperationMarkVisual {
  return activity === "idle" && idleArrivalIds.has(operationId) ? "unseen" : activity;
}

export function operationMarkVisual(mark: OperationMarkVisual | undefined): OperationMarkVisual {
  return mark === "unseen" ? "unseen" : operationActivityVisual(mark);
}

export function operationActivityVisual(status: OperationActivityVisual | undefined): OperationActivityVisual {
  if (status === "running") return "running";
  if (status === "background") return "background";
  if (status === "awaiting") return "awaiting";
  if (status === "ended") return "ended";
  return "idle";
}

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

export function operationMarkLabel(mark: OperationMarkVisual | undefined): string {
  if (mark === "unseen") return getT(resolveActiveLocale())("activity.unseen");
  return operationActivityLabel(mark);
}

export function operationActivityLabel(status: OperationActivityVisual | undefined): string {
  const t = getT(resolveActiveLocale());
  const visual = operationActivityVisual(status);
  if (visual === "running") return t("activity.running");
  if (visual === "background") return t("activity.background");
  if (visual === "awaiting") return t("activity.awaiting");
  if (visual === "ended") return t("activity.ended");
  return t("activity.idle");
}
