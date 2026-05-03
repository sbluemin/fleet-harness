/**
 * shipyard/carrier/status-renderer.ts — carrier 상태 렌더링
 *
 * 패널 하단 상태 표시줄의 각 carrier 세그먼트를 렌더링합니다.
 * 순수 렌더 함수로 구성되어 있으며 상태에 대한 직접 의존이 없습니다.
 */

import {
  ANSI_RESET,
  PANEL_COLOR,
  PANEL_DIM_COLOR,
  SPINNER_FRAMES,
  SQUADRON_BADGE_COLOR,
  SYM_INDICATOR,
  TASKFORCE_BADGE_COLOR,
} from "@sbluemin/fleet-core/constants";
import { getConfiguredTaskForceBackends } from "@sbluemin/fleet-core/admiral/store";
import type { Theme } from "@mariozechner/pi-coding-agent";

import {
  resolveCarrierColor,
  resolveCarrierDisplayName,
  resolveCarrierRgb,
  isCarrierOnline,
  isSquadronCarrierEnabled,
} from "../tools.js";
import type { AssistantMessage } from "../provider.js";
import { waveText } from "../panel/panel-render.js";
import { getActiveJobs } from "../panel/state.js";
import type { AgentCol } from "../panel/types.js";
import type { PanelJob } from "../panel/types.js";
import type { ColorScheme, HudCoreConfig, SegmentContext, SegmentStateProvider } from "../hud/types.js";
import { getPreset, getDefaultColors } from "../hud/theme.js";
import { getGitStatus } from "../hud/git-status.js";

/** renderCarrierStatus에 필요한 최소 상태 */
interface CarrierStatusRenderInput {
  cols: AgentCol[];
  streaming: boolean;
  frame: number;
}

/** sortie 비활성 캐리어용 dim 색상 */
const DISABLED_COLOR = "\x1b[38;2;100;100;100m";

// ─── 메인 렌더 함수 ─────────────────────────────────────

/**
 * carrier 상태 문자열을 렌더링합니다.
 * 상태 객체를 파라미터로 받아 순수 함수로 동작합니다.
 */
export function renderCarrierStatus(input: CarrierStatusRenderInput): string | undefined {
  const activeJobs = getActiveJobs();
  const segments = input.cols.map((col) => {
    const hasActiveJob = hasActiveJobForCarrier(activeJobs, col.cli);
    const footerCol = toFooterCol(col, input.streaming, hasActiveJob);
    const disabled = !isCarrierOnline(col.cli);
    const name = resolveCarrierDisplayName(col.cli);
    const taskForceBackendCount = getConfiguredTaskForceBackends(col.cli).length;
    const tfBadgeColor = disabled ? DISABLED_COLOR : TASKFORCE_BADGE_COLOR;
    const sqBadgeColor = disabled ? DISABLED_COLOR : SQUADRON_BADGE_COLOR;
    const tfBadge = taskForceBackendCount >= 2
      ? ` ${tfBadgeColor}[TF:${taskForceBackendCount}]${ANSI_RESET}`
      : "";
    const sqBadge = isSquadronCarrierEnabled(col.cli)
      ? ` ${sqBadgeColor}[SQ]${ANSI_RESET}`
      : "";
    const badges = `${tfBadge}${sqBadge}`;

    // sortie 비활성 캐리어: 아이콘·이름·배지 모두 dim 처리
    if (disabled) {
      return `${statusIcon(footerCol, input.frame, true)} ${DISABLED_COLOR}${name}${ANSI_RESET}${badges}`;
    }
    const cliColor = resolveCarrierColor(col.cli) || PANEL_COLOR;
    const isStreaming = isAnimatedStatus(footerCol.status);
    // 스트리밍 중: 아이콘 유지 + 이름에 파도 그라데이션
    return isStreaming
      ? `${statusIcon(footerCol, input.frame, false)} ${waveText(name, resolveCarrierRgb(col.cli), input.frame)}${badges}${ANSI_RESET}`
      : `${statusIcon(footerCol, input.frame, false)} ${cliColor}${name}${badges}${ANSI_RESET}`;
  });

  if (segments.length === 0) return undefined;
  return segments.join(`${PANEL_DIM_COLOR} │ ${ANSI_RESET}`);
}

// ─── 내부 헬퍼 ────────────────────────────────────────────

function statusIcon(col: AgentCol, frame: number, disabled: boolean): string {
  // sortie 비활성 캐리어: dim 아이콘으로 표시
  if (disabled) {
    return `${DISABLED_COLOR}○${ANSI_RESET}`;
  }
  const cliColor = resolveCarrierColor(col.cli) || PANEL_COLOR;
  const icon = col.status === "done"
    ? SYM_INDICATOR
    : col.status === "err"
      ? SYM_INDICATOR
      : isAnimatedStatus(col.status)
        ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
        : "○";
  return `${cliColor}${icon}${ANSI_RESET}`;
}

function toFooterCol(col: AgentCol, streaming: boolean, hasActiveJob: boolean): AgentCol {
  if (!streaming) return { ...col, status: "wait" };
  if (isAnimatedStatus(col.status) || !hasActiveJob) return col;
  return { ...col, status: "stream" };
}

function hasActiveJobForCarrier(
  activeJobs: PanelJob[],
  carrierId: AgentCol["cli"],
): boolean {
  return activeJobs.some((job) => (
    job.ownerCarrierId === carrierId ||
    job.tracks.some((track) => track.displayCli === carrierId)
  ));
}

function isAnimatedStatus(status: AgentCol["status"]): boolean {
  return status === "conn" || status === "stream";
}

export function buildSegmentContext(
  ctx: any,
  theme: Theme,
  provider: SegmentStateProvider,
  config: HudCoreConfig,
): SegmentContext {
  const presetDef = getPreset(config.preset);
  const colors: ColorScheme = presetDef.colors ?? getDefaultColors();
  const selectedModel = provider.selectedModel ?? ctx?.model;

  let input = 0, output = 0, cost = 0;
  let thinkingLevelFromSession = "off";
  let sessionId: string | undefined;
  let usingSubscription = false;

  try {
    const sessionEvents = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      if (e.type === "thinking_level_change" && e.thinkingLevel) {
        thinkingLevelFromSession = e.thinkingLevel;
      }
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          continue;
        }
        input += m.usage.input;
        output += m.usage.output;
        cost += m.usage.cost.total;
      }
    }
    sessionId = ctx?.sessionManager?.getSessionId?.();
    usingSubscription = selectedModel
      ? ctx?.modelRegistry?.isUsingOAuth?.(selectedModel) ?? false
      : false;
  } catch {
    // stale ctx — 사용량/세션 데이터는 이전 값 유지, selectedModel은 정상 반환
  }

  const gitBranch = provider.footerDataRef?.getGitBranch() ?? null;
  const gitStatus = getGitStatus(gitBranch);

  return {
    model: selectedModel,
    thinkingLevel: thinkingLevelFromSession || provider.getThinkingLevelFn?.() || "off",
    sessionId,
    usageStats: { input, output, cost },
    usingSubscription,
    sessionStartTime: provider.sessionStartTime,
    git: gitStatus,
    extensionStatuses: provider.footerDataRef?.getExtensionStatuses() ?? new Map(),
    options: presetDef.segmentOptions ?? {},
    theme,
    colors,
  };
}
