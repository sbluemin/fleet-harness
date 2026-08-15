import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { getT } from "./i18n/index.js";
import type { OperationNode } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

// 표시 어휘는 다섯 값 하나로 남는다 — 칩은 한 번에 한 모습만 그리므로 여기서는 수명주기와 활동이
// 상호배타적 시각 상태로 합류해도 된다. 두 축을 갈라놓아야 하는 곳은 권위 계산(런타임 상태) 쪽이다.
export type OperationActivityVisual = "running" | "background" | "awaiting" | "dormant" | "idle";

// 런타임 맵에 항목이 없는 Operation의 분류 폭백. 플러그인이 아직 런타임 축을 심지 않은 복원 Operation은
// doctrine상 "dormant until explicitly relaunched"이다. providerSession 자체는 브라우저 DTO에서
// 제거되므로, host가 DTO 시점에 심는 비민감 파생 마커 resumeAvailable로 dormant를 판별한다.
// 사이드바 STATUS 축, Operation 검색, 팔레트 뱃지가 같은 원천 활동 분류를 공유하도록 이 함수가 단일 기준이다.
// idle-arrival의 화면상 awaiting 승격은 아래 display resolver만 소유한다. Alt+←/→ 순환은 상태를
// 해석하지 않으므로(캔버스 배치 순서 전용) 이 기준의 소비자가 아니다.
export function resolveOperationActivity(
  operation: OperationNode,
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
): OperationActivityVisual {
  const live = operationRuntime[operation.id];
  if (live) return runtimeStateVisual(live);
  return operation.payload?.resumeAvailable === true ? "dormant" : "idle";
}

// 런타임 상태 → 표시 어휘. 휴면은 활동값을 가지지 않으므로 여기서만 두 축이 만난다.
export function runtimeStateVisual(state: OperationRuntimeState): OperationActivityVisual {
  return state.lifecycle === "dormant" ? "dormant" : state.activity;
}

// 미관측(맵에 항목 없음)은 표시 어휘로도 미관측이다 — 폭백 분류가 필요한 소비처는
// resolveOperationActivity를 쓰고, 여기서는 "모른다"를 유휴로 접지 않는다.
export function operationRuntimeVisual(state: OperationRuntimeState | undefined): OperationActivityVisual | undefined {
  return state ? runtimeStateVisual(state) : undefined;
}

// 플러그인이 실은 실행 표면 표식. 휴면 상태에는 표면이 없다.
export function operationRuntimeSurface(state: OperationRuntimeState | undefined): string | undefined {
  return state?.lifecycle === "live" ? state.surface : undefined;
}

// 표시 어휘 하나에서 런타임 상태를 되짚는다. 표시 축은 두 축이 합류한 뒤라 일반적으로 역함수가
// 없지만, 휴면만 수명주기로 갈라지고 나머지는 그대로 활동이므로 이 방향은 유일하게 결정된다.
export function runtimeStateOfVisual(visual: OperationActivityVisual): OperationRuntimeState {
  return visual === "dormant" ? { lifecycle: "dormant" } : { lifecycle: "live", activity: visual };
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

export function operationActivityVisual(status: OperationActivityVisual | undefined): OperationActivityVisual {
  if (status === "running") return "running";
  if (status === "background") return "background";
  if (status === "awaiting") return "awaiting";
  if (status === "dormant") return "dormant";
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

export function operationActivityLabel(status: OperationActivityVisual | undefined): string {
  const t = getT(resolveActiveLocale());
  const visual = operationActivityVisual(status);
  if (visual === "running") return t("activity.running");
  if (visual === "background") return t("activity.background");
  if (visual === "awaiting") return t("activity.awaiting");
  if (visual === "dormant") return t("activity.dormant");
  return t("activity.idle");
}
