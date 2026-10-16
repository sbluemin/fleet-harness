import type { QuotaWindow } from "../../quota/types.js";
import { object, percent, safeTimestamp, titleCase, windowPeriod } from "../../quota/windows.js";

export type ParsedMuseCodeUsage =
  | { readonly status: "inactive" }
  | { readonly status: "ok"; readonly windows: readonly QuotaWindow[]; readonly plan?: string };

function usedPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return percent(value);
}

/**
 * 구독 사용량 블록 `{window, weekly, tier}`를 window로 옮긴다. key 응답의 `subs_usage`와
 * 추론 스트림의 `response.subscription_usage` 이벤트의 `subscription`이 같은 모양이다(실측 2026-09-26).
 * 읽을 창이 하나도 없으면 `null`. `weekly`는 기간을 밝히지 않으므로 period를 꾸며 붙이지 않는다.
 */
export function parseMuseCodeSubscriptionUsage(value: unknown): readonly QuotaWindow[] | null {
  const usage = object(value);
  if (!usage) return null;
  const windows: QuotaWindow[] = [];
  const session = object(usage.window);
  const sessionUsed = usedPercent(session?.used_percent);
  if (session && sessionUsed !== undefined) {
    const resetsAt = safeTimestamp(session.resets_at);
    const minutes = session.window_duration_mins;
    const period = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
      ? windowPeriod(minutes * 60_000, "upstream", resetsAt)
      : undefined;
    windows.push({
      id: "session",
      usedPercent: sessionUsed,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(period ? { period } : {}),
    });
  }
  const weekly = object(usage.weekly);
  const weeklyUsed = usedPercent(weekly?.used_percent);
  if (weekly && weeklyUsed !== undefined) {
    const resetsAt = safeTimestamp(weekly.resets_at);
    windows.push({
      id: "weekly",
      usedPercent: weeklyUsed,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  return windows.length > 0 ? windows : null;
}

/**
 * key 응답을 window로 옮긴다. 응답에는 API 키와 계정 정보도 실려 오므로 아래에서 읽는
 * 필드만 밖으로 내보낸다 — DTO·캐시·로그 어디에도 원본이 남아서는 안 된다.
 *
 * 진행 중인 5시간 창이 없으면 활성 구독이어도 `subs_usage`가 통째로 빠진다(주간 값도 함께).
 * 첫 요청이 창을 열면 다시 실린다(실측 2026-09-26). 이때는 창 없이 성공으로 돌려준다.
 */
export function parseMuseCodeUsage(payload: unknown): ParsedMuseCodeUsage | null {
  const root = object(payload);
  if (!root) return null;
  if (root.is_subs_active === false) return { status: "inactive" };
  const plan = titleCase(root.subs_tier_name);
  const withPlan = plan ? { plan } : {};
  if (root.subs_usage === undefined || root.subs_usage === null) {
    return root.is_subs_active === true ? { status: "ok", windows: [], ...withPlan } : null;
  }
  const windows = parseMuseCodeSubscriptionUsage(root.subs_usage);
  if (!windows) return null;
  return { status: "ok", windows, ...withPlan };
}
