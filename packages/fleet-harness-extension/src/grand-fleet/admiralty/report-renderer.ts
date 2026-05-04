/**
 * admiralty/report-renderer.ts — 함대 보고서 TUI 렌더링
 *
 * mission.report 수신 시 Admiralty LLM이
 * Admiral of the Navy (대원수)에게 후속 보고를 이어갈 수 있도록 보고서를 주입한다.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { infra } from "@sbluemin/fleet-core";
import type { FleetId, MissionReportParams } from "@sbluemin/fleet-core/admiralty";

interface ReportRenderOptions {
  designation?: string;
}

const STATUS_ICONS: Record<MissionReportParams["type"], string> = {
  progress: "⏳ 진행중",
  complete: "✅ 완료",
  failed: "❌ 실패",
  blocked: "⚠️ 차단",
};
const LOG_SOURCE = "grand-fleet";

export function renderReport(
  pi: ExtensionAPI,
  params: MissionReportParams,
  options: ReportRenderOptions = {},
): void {
  const fleetLabel = formatFleetLabel(params.fleetId, options.designation);
  infra.log.getLogAPI().debug(
    LOG_SOURCE,
    `보고서 수신: ${fleetLabel}, type=${params.type}`,
  );

  const icon = STATUS_ICONS[params.type] ?? params.type;
  const time = params.timestamp
    ? new Date(params.timestamp).toLocaleTimeString()
    : "";

  let content = `[${fleetLabel} 작전 보고 수신 (${time})]\n`;
  content += `Status: ${icon}\n`;
  content += `\n${params.summary}\n`;

  if (params.phases) {
    content += `\nPhases: ${params.phases.executed.join(" → ")}\n`;
  }
  if (params.fileStats) {
    const { modified, created, deleted } = params.fileStats;
    content += `Files: 변경 ${modified} | 신규 ${created} | 삭제 ${deleted}\n`;
  }
  if (params.openIssues && params.openIssues.length > 0) {
    content += `미해결: ${params.openIssues.join(", ")}\n`;
  }

  pi.sendUserMessage(content, { deliverAs: "followUp" });
}

export function renderFleetEvent(
  pi: ExtensionAPI,
  fleetId: FleetId,
  event: "connected" | "disconnected",
  options: ReportRenderOptions = {},
): void {
  const fleetLabel = formatFleetLabel(fleetId, options.designation);
  infra.log.getLogAPI().debug(LOG_SOURCE, `이벤트 렌더링: ${fleetLabel}, ${event}`);

  const isConnect = event === "connected";
  const color = isConnect ? "\x1b[38;2;80;220;120m" : "\x1b[38;2;255;100;90m";
  const reset = "\x1b[0m";
  const icon = isConnect ? "⚓" : "✖";
  const label = isConnect ? "접속" : "해제";

  pi.sendMessage({
    customType: "grand-fleet-event",
    content: `${color}${icon}${reset} ${fleetLabel} ${color}${label}${reset}`,
    display: true,
  });
}

function formatFleetLabel(fleetId: FleetId, designation?: string): string {
  if (designation && designation.trim()) {
    return `${designation} (${fleetId})`;
  }

  return `Fleet ${fleetId}`;
}
