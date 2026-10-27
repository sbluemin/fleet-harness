import type { QuotaWindow } from "../../quota/types.js";
import { HOUR_MS, WEEK_MS, object, percent, safeTimestamp, titleCase, windowPeriod } from "../../quota/windows.js";

export type ParsedMuseCodeUsage =
  | { readonly status: "inactive" }
  | { readonly status: "ok"; readonly windows: readonly QuotaWindow[]; readonly plan?: string };

function usedPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return percent(value);
}

/** Muse의 5시간 세션. 업스트림이 `window_duration_mins`를 빠뜨릴 때만 catalog로 쓴다. */
const MUSE_SESSION_MS = 5 * HOUR_MS;

/**
 * 구독 사용량 블록 `{window, weekly, tier}`를 window로 옮긴다. key 응답의 `subs_usage`와
 * 추론 스트림의 `response.subscription_usage` 이벤트의 `subscription`이 같은 모양이다(실측 2026-09-26).
 * 읽을 창이 하나도 없으면 `null`. 주간 길이는 업스트림이 말하지 않으므로 Claude와 같이 7일 catalog다.
 * 리셋 시각이 없으면 기간을 붙이지 않는다. 세션 길이는 업스트림 분 값이 있으면 그것을 쓴다.
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
    const statedMs = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined;
    const period = statedMs !== undefined
      ? windowPeriod(statedMs, "upstream", resetsAt)
      : resetsAt !== undefined ? windowPeriod(MUSE_SESSION_MS, "catalog", resetsAt) : undefined;
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
    const period = resetsAt !== undefined ? windowPeriod(WEEK_MS, "catalog", resetsAt) : undefined;
    windows.push({
      id: "weekly",
      usedPercent: weeklyUsed,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(period ? { period } : {}),
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
