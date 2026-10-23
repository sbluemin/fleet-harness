export * from "../../objectives/shared/records/archive.js";
export { readObjectiveLaunch, wasObjectiveBornDormant } from "../../objectives/shared/records/types.js";
import * as React from "react";

import { readLaunchVariantGroups } from "../../objectives/shared/records/launch-variants.js";
import type { ObjectiveCatalogPlugin, ObjectiveLaunchKind, ObjectiveLaunchView, ObjectiveRecord } from "../../objectives/shared/records/types.js";

export interface ObjectiveBodyProps {
  readonly children: React.ReactNode;
  readonly className?: string;
}

const OBJECTIVE_BODY_CLASS = "fc-objective-body";

export class ApiError extends Error {
  readonly status: number;
  /** Parsed JSON error payload when the failing response carried one — lets callers surface route-specific error contracts. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export const OBJECTIVE_CATALOG_CHANGED_EVENT = "fleet:objective-catalog-changed";

import type { ObjectiveAccessIntent, ObjectiveAccessResult, ObjectiveArchiveReceipt, ObjectiveArchiveRestoreResult, ObjectiveArchiveSnapshot, ObjectiveDescription, ObjectivePurgeConfirmation, ObjectivePurgeResult } from "../../objectives/shared/records/archive.js";

async function archiveRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/objectives/records${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    signal,
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(response.status, typeof payload?.error === "string" ? payload.error : "Objective archive request failed", payload);
  return payload as T;
}

export function archiveObjective(objectiveId: string, signal?: AbortSignal): Promise<ObjectiveArchiveReceipt> {
  return archiveRequest(`/${encodeURIComponent(objectiveId)}/archive`, {}, signal);
}
export async function accessObjective(objectiveId: string, intent: ObjectiveAccessIntent = "ensure-active", signal?: AbortSignal): Promise<ObjectiveAccessResult> {
  const result = await archiveRequest<ObjectiveAccessResult>(`/${encodeURIComponent(objectiveId)}/access`, { intent }, signal);
  return { ...result, objectiveRecords: result.objectiveRecords.map(assertObjectiveRecord) };
}
export function restoreObjectiveCluster(objectiveId: string, signal?: AbortSignal): Promise<ObjectiveAccessResult> {
  return accessObjective(objectiveId, "ensure-active", signal);
}
export async function undoObjectiveArchive(receipt: Pick<ObjectiveArchiveReceipt, "targetId" | "archiveId">, signal?: AbortSignal): Promise<ObjectiveAccessResult> {
  const result = await archiveRequest<ObjectiveAccessResult>("/archive/undo", receipt, signal);
  return { ...result, objectiveRecords: result.objectiveRecords.map(assertObjectiveRecord) };
}
export async function describeObjective(objectiveId: string, signal?: AbortSignal): Promise<ObjectiveDescription | null> {
  const result = await archiveRequest<ObjectiveDescription | null>(`/${encodeURIComponent(objectiveId)}/describe`, undefined, signal);
  return result ? { ...result, objectiveRecord: assertObjectiveRecord(result.objectiveRecord) } : null;
}
export async function fetchObjectiveArchive(theaterId?: string, signal?: AbortSignal): Promise<ObjectiveArchiveSnapshot> {
  const result = await archiveRequest<ObjectiveArchiveSnapshot>(`/archive${theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : ""}`, undefined, signal);
  return { ...result, entries: result.entries.map((entry) => ({ ...entry, objectiveRecord: assertObjectiveRecord(entry.objectiveRecord) })) };
}
export function previewObjectivePurge(objectiveId: string, signal?: AbortSignal): Promise<ObjectivePurgeConfirmation> {
  return archiveRequest(`/archive/${encodeURIComponent(objectiveId)}/purge-preview`, undefined, signal);
}
export function purgeArchivedObjectiveRecords(confirmation: ObjectivePurgeConfirmation, signal?: AbortSignal): Promise<ObjectivePurgeResult> {
  return archiveRequest("/archive/purge", confirmation, signal);
}
export function previewObjectiveBatch(objectiveIds: readonly string[], signal?: AbortSignal): Promise<ObjectivePurgeConfirmation> {
  return archiveRequest("/archive/purge-preview", { objectiveIds }, signal);
}
export function undoObjectivePurge(purgeId: string, signal?: AbortSignal): Promise<ObjectivePurgeResult> {
  return archiveRequest("/archive/purge-undo", { purgeId }, signal);
}
export async function restoreArchivedObjectiveRecords(confirmation: ObjectivePurgeConfirmation, signal?: AbortSignal): Promise<ObjectiveArchiveRestoreResult> {
  const result = await archiveRequest<ObjectiveArchiveRestoreResult>("/archive/restore", confirmation, signal);
  return { ...result, objectiveRecords: result.objectiveRecords.map(assertObjectiveRecord) };
}

export async function fetchObjectiveCatalog(signal?: AbortSignal): Promise<readonly ObjectiveCatalogPlugin[]> {
  const response = await fetch("/api/v1/objectives/records/catalog", { signal });
  if (!response.ok) throw new ApiError(response.status, `Objective catalog request failed: ${response.status}`);
  const payload = await response.json() as { readonly plugins?: unknown };
  return Array.isArray(payload.plugins) ? payload.plugins.map(readCatalogPlugin).filter((plugin): plugin is ObjectiveCatalogPlugin => plugin !== null) : [];
}

export function assertObjectiveRecord(value: unknown): ObjectiveRecord {
  const payload = value as Partial<ObjectiveRecord>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.theaterId !== "string"
    || typeof payload.title !== "string"
    || !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new ApiError(500, "Invalid objectiveRecord response");
  }
  return payload as ObjectiveRecord;
}

export function hasForbiddenBrowserPayloadKey(value: unknown): boolean {
  return containsForbiddenKey(value, new Set(["canonicalCwd", "cwd", "persona", "prompt", "providerSession", "ticket", "token", "toolAllowlist", "tools", "transcriptPath"]));
}

export function ObjectiveBody({ children, className }: ObjectiveBodyProps): React.ReactElement {
  return <div className={joinClassNames(OBJECTIVE_BODY_CLASS, className)}>{children}</div>;
}

function readCatalogPlugin(value: unknown): ObjectiveCatalogPlugin | null {
  if (!isRecord(value) || (value.id !== null && typeof value.id !== "string") || typeof value.title !== "string" || !Array.isArray(value.kinds)) return null;
  const kinds = value.kinds.map(readLaunchKind).filter((kind): kind is ObjectiveLaunchKind => kind !== null);
  if (kinds.length === 0) return null;
  return { id: value.id === "terminal" ? null : value.id, title: value.title, kinds };
}

function readLaunchKind(value: unknown): ObjectiveLaunchKind | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.title !== "string") return null;
  const variants = readLaunchVariantGroups(value.variants);
  const launchViews = readLaunchViews(value.launchViews);
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    ...(typeof value.disabled === "boolean" ? { disabled: value.disabled } : {}),
    ...(typeof value.disabledReason === "string" ? { disabledReason: value.disabledReason } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    ...(launchViews.length > 0 ? { launchViews } : {}),
  };
}

/**
 * 모르는 표면 이름은 버린다 — 코어는 자기가 그릴 수 있는 표면만 목록에 올린다. `terminal` 하나만
 * 남는 선언은 선택지가 아니므로 생략과 같게 접는다(호출부가 길이로 판정한다).
 */
function readLaunchViews(value: unknown): readonly ObjectiveLaunchView[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ObjectiveLaunchView>();
  for (const entry of value) {
    if (entry === "terminal" || entry === "chat") seen.add(entry);
  }
  return seen.has("chat") ? [...seen] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsForbiddenKey(value: unknown, forbidden: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, forbidden));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => forbidden.has(key) || containsForbiddenKey(item, forbidden));
}

function joinClassNames(...classNames: readonly (string | undefined)[]): string {
  return classNames.filter((className): className is string => Boolean(className)).join(" ");
}
