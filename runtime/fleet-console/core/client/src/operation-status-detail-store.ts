import { useSyncExternalStore } from "react";

import type { OperationActivityVisual } from "./operation-activity.js";

type Listener = () => void;

export interface OperationStatusDetailSnapshot {
  readonly detail: string | null;
  readonly activityChangedAt: number | null;
}

const details = new Map<string, string>();
const activities = new Map<string, OperationActivityVisual>();
const activityChangedAt = new Map<string, number>();
const listeners = new Set<Listener>();
let revision = 0;

export function setOperationStatusDetail(operationId: string, detail: string): void {
  if (details.get(operationId) === detail) return;
  details.set(operationId, detail);
  emit();
}

export function clearOperationStatusDetail(operationId: string): void {
  const detailChanged = details.delete(operationId);
  const activityChanged = activities.delete(operationId);
  const timestampChanged = activityChangedAt.delete(operationId);
  if (detailChanged || activityChanged || timestampChanged) emit();
}

export function recordOperationActivityTransition(
  operationId: string,
  activity: OperationActivityVisual,
  now = Date.now(),
): void {
  if (activities.get(operationId) === activity) return;
  activities.set(operationId, activity);
  activityChangedAt.set(operationId, now);
  emit();
}

export function getOperationStatusDetailSnapshot(operationId: string): OperationStatusDetailSnapshot {
  return {
    detail: details.get(operationId) ?? null,
    activityChangedAt: activityChangedAt.get(operationId) ?? null,
  };
}

function subscribeOperationStatusDetail(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getOperationStatusDetailRevision(): number {
  return revision;
}

export function useOperationStatusDetails(): number {
  return useSyncExternalStore(
    subscribeOperationStatusDetail,
    getOperationStatusDetailRevision,
    getOperationStatusDetailRevision,
  );
}

function emit(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
