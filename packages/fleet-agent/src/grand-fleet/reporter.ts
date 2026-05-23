import type {
  FileStats,
  FleetId,
  MissionId,
  PhaseRecord,
  ReportType,
} from "./types.js";

export interface MissionReportData {
  fleetId: FleetId;
  missionId: MissionId;
  type: ReportType;
  summary: string;
  phases?: PhaseRecord;
  fileStats?: FileStats;
  openIssues?: string[];
}

export interface MissionReportPayload {
  fleetId: FleetId;
  missionId: MissionId;
  type: ReportType;
  summary: string;
  phases?: PhaseRecord;
  fileStats?: FileStats;
  openIssues: string[];
  timestamp: string;
}

export function buildMissionReportPayload(
  report: MissionReportData,
  now: () => Date = () => new Date(),
): MissionReportPayload {
  return {
    fleetId: report.fleetId,
    missionId: report.missionId,
    type: report.type,
    summary: report.summary,
    phases: report.phases,
    fileStats: report.fileStats,
    openIssues: report.openIssues ?? [],
    timestamp: now().toISOString(),
  };
}

export function buildProgressReport(
  fleetId: FleetId,
  missionId: MissionId,
  summary: string,
): MissionReportData {
  return {
    fleetId,
    missionId,
    type: "progress",
    summary,
  };
}

export function buildCompleteReport(
  fleetId: FleetId,
  missionId: MissionId,
  summary: string,
  phases?: PhaseRecord,
  fileStats?: FileStats,
): MissionReportData {
  return {
    fleetId,
    missionId,
    type: "complete",
    summary,
    phases,
    fileStats,
  };
}

export function buildFailedReport(
  fleetId: FleetId,
  missionId: MissionId,
  summary: string,
  openIssues?: string[],
): MissionReportData {
  return {
    fleetId,
    missionId,
    type: "failed",
    summary,
    openIssues,
  };
}
