/**
 * fleet/reporter.ts — 작전 보고 모듈
 *
 * Admiral (제독) 인스턴스의 작전 결과를 구조화하여 Admiralty에 mission.report를 전송한다.
 */
import { infra } from "@sbluemin/fleet-core";
import {
  buildCompleteReport,
  buildMissionReportPayload,
  type MissionReportData,
} from "@sbluemin/fleet-core/admiralty";
import type { FleetClient } from "./client.js";
import type {
  FileStats,
  FleetId,
  MissionId,
  PhaseRecord,
} from "@sbluemin/fleet-core/admiralty";

const LOG_SOURCE = "grand-fleet";

/** 작전 보고 전송 */
export function sendMissionReport(
  client: FleetClient,
  report: MissionReportData,
): void {
  infra.log.getLogAPI().info(
    LOG_SOURCE,
    `보고 전송: ${report.type} (missionId=${report.missionId})`,
  );
  client.sendNotification(
    "mission.report",
    { ...buildMissionReportPayload(report) },
  );
}

/** 완료 보고 */
export function sendCompleteReport(
  client: FleetClient,
  fleetId: FleetId,
  missionId: MissionId,
  summary: string,
  phases?: PhaseRecord,
  fileStats?: FileStats,
): void {
  sendMissionReport(client, buildCompleteReport(fleetId, missionId, summary, phases, fileStats));
}
