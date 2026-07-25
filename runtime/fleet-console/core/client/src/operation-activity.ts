import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { getGlobalSettingsStoreState } from "./global-settings-store.js";
import { getT } from "./i18n/index.js";
import type { OperationNode } from "./types.js";
import { resolveConsoleLanguage } from "./whatsnew-i18n.js";

export type OperationActivityVisual = "running" | "awaiting" | "dormant" | "idle";

// 활동 맵에 항목이 없는 Operation의 분류 폭백. 플러그인이 아직 status를 심지 않은 복원 Operation은
// doctrine상 "dormant until explicitly relaunched"이다. providerSession 자체는 브라우저 DTO에서
// 제거되므로, host가 DTO 시점에 심는 비민감 파생 마커 resumeAvailable로 dormant를 판별한다.
// 사이드바 STATUS 축, Alt 순환, 팔레트 뱃지가 같은 분류를 공유하도록 이 함수가 단일 기준이다.
export function resolveOperationActivity(
  operation: OperationNode,
  operationStatus: Readonly<Record<string, OperationActivity>>,
): OperationActivity {
  const live = operationStatus[operation.id];
  if (live) return live;
  return operation.payload?.resumeAvailable === true ? "dormant" : "idle";
}

export function operationActivityVisual(status: OperationActivity | undefined): OperationActivityVisual {
  if (status === "running") return "running";
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

export function operationActivityLabel(status: OperationActivity | undefined): string {
  const t = getT(resolveActiveLocale());
  const visual = operationActivityVisual(status);
  if (visual === "running") return t("activity.running");
  if (visual === "awaiting") return t("activity.awaiting");
  if (visual === "dormant") return t("activity.dormant");
  return t("activity.idle");
}
