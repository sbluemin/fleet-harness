/**
 * panel/config.ts — 모델/서비스 설정 반영 + 패널 높이 조절
 *
 * 외부에서 모델 설정이나 서비스 상태가 변경될 때
 * 패널 상태를 갱신하는 setter 함수를 제공합니다.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { MIN_BODY_H, MAX_BODY_H, formatPanelMultiColHint } from "@sbluemin/fleet-core/constants";
import { loadModels } from "@sbluemin/fleet-core/admiral/store";
import { getState } from "./state.js";
import type { ServiceSnapshot } from "./state.js";
import { syncCurrentWidget, syncWidget } from "./widget-sync.js";

// ─── 모델 설정 동기화 ──────────────────────────────────────

/**
 * CLI별 모델/추론 설정을 패널 상태에 반영합니다.
 * footer 세그먼트에 모델명과 effort가 표시됩니다.
 */
export function setAgentPanelModelConfig(
  config: Record<string, { model: string; effort?: string }>,
): void {
  const s = getState();
  s.modelConfig = config;
  syncCurrentWidget();
}

/** 모델 설정을 런타임에서 읽어 패널에 반영합니다. */
export function syncModelConfig(): void {
  setAgentPanelModelConfig(loadModels());
}

// ─── 서비스 상태 동기화 ────────────────────────────────────

/**
 * 서비스 상태를 패널 footer 상태에 반영합니다.
 */
export function setAgentPanelServiceStatus(
  snapshots: ServiceSnapshot[],
  lastUpdatedAt: number | null,
): void {
  const s = getState();
  s.serviceSnapshots = snapshots;
  s.serviceLastUpdatedAt = lastUpdatedAt;
  s.serviceLoading = false;
  syncCurrentWidget();
}

/**
 * 서비스 상태 로딩 중 표시를 footer 상태에 반영합니다.
 */
export function setAgentPanelServiceLoading(): void {
  const s = getState();
  s.serviceLoading = true;
  syncCurrentWidget();
}

// ─── 패널 높이 조절 ──────────────────────────────────────

/**
 * 패널 본문 높이를 delta만큼 조절합니다.
 * MIN_BODY_H ~ MAX_BODY_H 범위 내로 클램핑됩니다.
 * @returns 조절 후 높이
 */
export function adjustPanelHeight(ctx: ExtensionContext, delta: number): number {
  const s = getState();
  const prev = s.bodyH;
  s.bodyH = Math.max(MIN_BODY_H, Math.min(MAX_BODY_H, s.bodyH + delta));
  // 높이 변경 시 bottomHint에 현재 높이 표시 (피드백용)
  // 상세 뷰일 때는 상세 힌트를 유지
  if (!s.detailTrackId) {
    s.bottomHint = formatPanelMultiColHint(s.bodyH);
  }
  if (prev !== s.bodyH) {
    // setWidget(undefined) 없이 바로 교체 — 중간 상태 렌더링을 방지
    // (undefined 먼저 호출하면 clearOnShrink=false 환경에서 잔상이 남음)
    syncWidget(ctx);
  }
  return s.bodyH;
}
