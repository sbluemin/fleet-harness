import { CLI_DISPLAY_NAMES } from "../../constants.js";
import type { CarrierJobStatus, CarrierJobSummary } from "../../infra/job/index.js";
import type { CarrierMetadata } from "../carrier/types.js";
import { validateRequiredRequestBlocks } from "../carrier/request-blocks.js";
import type { TaskForceCliType, TaskForceResult } from "./types.js";

export function assertTaskForceBackendCount(carrierId: string, backends: readonly TaskForceCliType[]): readonly TaskForceCliType[] {
  if (backends.length >= 2) return backends;
  throw new Error(
    `Carrier ${formatCarrierIdForMessage(carrierId)} needs ≥2 configured Task Force backends, got ${backends.length}. ` +
    `Open Carrier Status (Alt+O), select ${formatCarrierIdForMessage(carrierId)}, press T to add a backend.`,
  );
}

export function buildTaskForceRequestKey(carrierId: string, request: string): string {
  return JSON.stringify([carrierId, request.replace(/\r\n?/g, "\n").trim()]);
}

export function buildTaskForceRunId(carrierId: string, cliType: TaskForceCliType): string {
  const encodedCarrierId = Buffer.from(carrierId, "utf-8").toString("base64url");
  return `taskforce:${cliType}:${encodedCarrierId}`;
}

export function computeTaskForceFinalStatus(results: readonly TaskForceResult[]): CarrierJobStatus {
  if (results.some((result) => result.status === "aborted")) return "aborted";
  if (results.some((result) => result.status === "error")) return "error";
  return "done";
}

export function buildTaskForceErrorResult(cliType: TaskForceCliType, reason: unknown): TaskForceResult {
  const errorMessage = sanitizeTaskForceChunk(
    reason instanceof Error
      ? reason.message
      : String(reason),
  );

  return {
    cliType,
    displayName: CLI_DISPLAY_NAMES[cliType] ?? cliType,
    status: "error",
    responseText: `Error: ${errorMessage}`,
    error: errorMessage,
  };
}

export function buildTaskForceSummaryText(
  status: CarrierJobStatus,
  successCount: number,
  failureCount: number,
  error?: string,
): string {
  if (status === "aborted") return `carrier_taskforce aborted: ${successCount} done, ${failureCount} failed`;
  if (error) return `carrier_taskforce failed: ${error}`;
  return `carrier_taskforce completed: ${successCount} done, ${failureCount} failed`;
}

export function buildTaskForceJobSummary(
  jobId: string,
  startedAt: number,
  finishedAt: number,
  carrierId: string,
  results: readonly TaskForceResult[],
  status: CarrierJobStatus,
  error?: string,
): CarrierJobSummary {
  const successCount = results.filter((result) => result.status === "done").length;
  const failureCount = results.length - successCount;
  return {
    jobId,
    tool: "carrier_taskforce",
    status,
    summary: buildTaskForceSummaryText(status, successCount, failureCount, error),
    startedAt,
    finishedAt,
    carriers: [carrierId],
    error,
  };
}

export function sanitizeTaskForceChunk(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\x1b\[\d*[ABCDEFGHJKST]/g, "")
    .replace(/\x1b\[\d*;\d*[Hf]/g, "")
    .replace(/\x1b\[(?:\??\d+[hl]|2J|K)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function sanitizeTaskForceToolLabel(text: string): string {
  return sanitizeTaskForceChunk(text).replace(/\s+/g, " ").trim() || "(unnamed)";
}

function formatCarrierIdForMessage(carrierId: string): string {
  return JSON.stringify(carrierId);
}

/**
 * taskforce request에 대해 필수 request-block 검증을 수행합니다.
 *
 * @returns 검증 실패 결과, 통과하면 null
 */
export function validateTaskForceRequestBlocks(
  carrierId: string,
  meta: CarrierMetadata,
  request: string,
): { error: string; missing: string[] } | null {
  const result = validateRequiredRequestBlocks(meta, request, carrierId);
  if (!result.ok) return { error: result.error, missing: result.missing };
  return null;
}
