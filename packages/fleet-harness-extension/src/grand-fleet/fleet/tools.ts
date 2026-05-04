import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  MISSION_REPORT_DESCRIPTION,
  MISSION_REPORT_LABEL,
  MISSION_REPORT_NAME,
  MissionReportParamsSchema,
  type ReportType,
} from "@sbluemin/fleet-core/admiralty";

import { infra } from "@sbluemin/fleet-core";
import { getState } from "../state.js";
import { sendMissionReport } from "./reporter.js";
import { flushFleetStatus, getFleetClient, getFleetRuntime } from "./runtime.js";

const LOG_SOURCE = "grand-fleet";

export function registerFleetPiTools(pi: ExtensionAPI): void {
  const state = getState();
  const fleetId = state?.fleetId ?? "unset";
  const log = infra.log.getLogAPI();

  pi.registerTool({
    name: MISSION_REPORT_NAME,
    label: MISSION_REPORT_LABEL,
    description: MISSION_REPORT_DESCRIPTION,
    parameters: MissionReportParamsSchema as any,
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: ExtensionContext,
    ) {
      const client = getFleetClient();
      if (!state.activeMissionId || !client) {
        throw new Error("활성 임무가 없거나 Admiralty에 연결되지 않았습니다.");
      }

      const runtime = getFleetRuntime();
      const missionId = state.activeMissionId;
      const reportParams = params as { type: ReportType; summary: string };
      const reportType = reportParams.type;
      const accumulated = runtime.missionTexts.join("\n\n---\n\n");
      const fullSummary = accumulated
        ? `${accumulated}\n\n---\n\n${reportParams.summary}`
        : reportParams.summary;

      sendMissionReport(client, {
        fleetId,
        missionId,
        type: reportType,
        summary: fullSummary,
      });

      log.info(LOG_SOURCE, `작전 보고 전송 (tool): type=${reportType}, missionId=${missionId}`);

      state.activeMissionId = null;
      state.activeMissionObjective = null;
      runtime.missionTexts = [];
      flushFleetStatus(state.fleetId ?? fleetId, true);

      return {
        content: [{ type: "text" as const, text: `작전 보고 완료: ${reportType}` }],
      };
    },
  } as any);
}
