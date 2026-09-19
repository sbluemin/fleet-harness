// Per-Operation transient marks. Each is state the server never stores: a card is
// leaving, a card went idle while unwatched, or a status line needs a detail suffix.
// All three are read by chrome that must repaint on change, so each keeps its own
// subscribe seam rather than sharing one store.

import { useSyncExternalStore } from "react";
import type { OperationActivityVisual } from "./operation-activity.js";

// ─── departure ─────────────────────────────────────────────────────────────────

const DEPARTURE_COOLDOWN_MS = 60_000;
const DEPARTURE_EXPIRY_MS = 30_000;

const departureListeners = new Set<() => void>();

let departureMarkedAt = new Map<string, number>();
let lastDepartureAt = new Map<string, number>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

export function markDeparture(id: string): void {
  const now = Date.now();
  pruneCooldowns(now);
  const lastMarkedAt = lastDepartureAt.get(id);
  if (lastMarkedAt !== undefined && now - lastMarkedAt < DEPARTURE_COOLDOWN_MS) return;
  departureMarkedAt = new Map(departureMarkedAt).set(id, now);
  lastDepartureAt = new Map(lastDepartureAt).set(id, now);
  scheduleExpirySweep(now);
  emitDeparture();
}

export function clearDeparture(id: string): void {
  if (!departureMarkedAt.has(id)) return;
  departureMarkedAt = new Map(departureMarkedAt);
  departureMarkedAt.delete(id);
  scheduleExpirySweep(Date.now());
  emitDeparture();
}

export function getDepartureIds(): ReadonlySet<string> {
  const now = Date.now();
  if (sweepExpired(now)) {
    scheduleExpirySweep(now);
    emitDeparture();
  }
  return new Set(departureMarkedAt.keys());
}

export function subscribeDeparture(listener: () => void): () => void {
  departureListeners.add(listener);
  return () => {
    departureListeners.delete(listener);
  };
}

export function resetDepartureForTests(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  departureMarkedAt = new Map();
  lastDepartureAt = new Map();
}

function scheduleExpirySweep(now: number): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  let expiresAt: number | null = null;
  for (const markedAt of departureMarkedAt.values()) {
    const candidate = markedAt + DEPARTURE_EXPIRY_MS;
    if (expiresAt === null || candidate < expiresAt) expiresAt = candidate;
  }
  if (expiresAt === null) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    const sweepNow = Date.now();
    const changed = sweepExpired(sweepNow);
    scheduleExpirySweep(sweepNow);
    if (changed) emitDeparture();
  }, Math.max(0, expiresAt - now));
}

function sweepExpired(now: number): boolean {
  let changed = false;
  const current = new Map<string, number>();
  for (const [id, markedAt] of departureMarkedAt) {
    if (now - markedAt < DEPARTURE_EXPIRY_MS) current.set(id, markedAt);
    else changed = true;
  }
  if (changed) departureMarkedAt = current;
  pruneCooldowns(now);
  return changed;
}

function pruneCooldowns(now: number): void {
  let next: Map<string, number> | null = null;
  for (const [id, markedAt] of lastDepartureAt) {
    if (now - markedAt < DEPARTURE_COOLDOWN_MS) continue;
    if (next === null) next = new Map(lastDepartureAt);
    next.delete(id);
  }
  if (next !== null) lastDepartureAt = next;
}

function emitDeparture(): void {
  for (const listener of departureListeners) listener();
}

// ─── idle arrival ──────────────────────────────────────────────────────────────

const idleArrivalListeners = new Set<() => void>();

let idleArrivalIds = new Set<string>();
let acknowledgementSuspended = false;

export function markIdleArrival(id: string): void {
  if (idleArrivalIds.has(id)) return;
  idleArrivalIds = new Set(idleArrivalIds);
  idleArrivalIds.add(id);
  for (const listener of idleArrivalListeners) listener();
}

export function acknowledgeIdleArrival(id: string): boolean {
  if (acknowledgementSuspended) return false;
  clearIdleArrival(id);
  return true;
}

export function setIdleArrivalAcknowledgementSuspended(suspended: boolean): void {
  acknowledgementSuspended = suspended;
}

export function isIdleArrivalAcknowledgementSuspended(): boolean {
  return acknowledgementSuspended;
}

export function clearIdleArrival(id: string): void {
  if (!idleArrivalIds.has(id)) return;
  idleArrivalIds = new Set(idleArrivalIds);
  idleArrivalIds.delete(id);
  for (const listener of idleArrivalListeners) listener();
}

export function getIdleArrivalIds(): ReadonlySet<string> {
  return idleArrivalIds;
}

export function subscribeIdleArrival(listener: () => void): () => void {
  idleArrivalListeners.add(listener);
  return () => {
    idleArrivalListeners.delete(listener);
  };
}

export function resetIdleArrivalForTests(): void {
  idleArrivalIds = new Set();
  acknowledgementSuspended = false;
}

// ─── status detail ─────────────────────────────────────────────────────────────

type Listener = () => void;

export interface OperationStatusDetailSnapshot {
  readonly detail: string | null;
  readonly activityChangedAt: number | null;
}

const details = new Map<string, string>();
const activities = new Map<string, OperationActivityVisual>();
const activityChangedAt = new Map<string, number>();
const statusDetailListeners = new Set<Listener>();
let revision = 0;

export function setOperationStatusDetail(operationId: string, detail: string): void {
  if (details.get(operationId) === detail) return;
  details.set(operationId, detail);
  emitStatusDetail();
}

export function clearOperationStatusDetail(operationId: string): void {
  const detailChanged = details.delete(operationId);
  const activityChanged = activities.delete(operationId);
  const timestampChanged = activityChangedAt.delete(operationId);
  if (detailChanged || activityChanged || timestampChanged) emitStatusDetail();
}

export function recordOperationActivityTransition(
  operationId: string,
  activity: OperationActivityVisual,
  now = Date.now(),
): void {
  if (activities.get(operationId) === activity) return;
  activities.set(operationId, activity);
  activityChangedAt.set(operationId, now);
  emitStatusDetail();
}

export function getOperationStatusDetailSnapshot(operationId: string): OperationStatusDetailSnapshot {
  return {
    detail: details.get(operationId) ?? null,
    activityChangedAt: activityChangedAt.get(operationId) ?? null,
  };
}

function subscribeOperationStatusDetail(listener: Listener): () => void {
  statusDetailListeners.add(listener);
  return () => statusDetailListeners.delete(listener);
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

function emitStatusDetail(): void {
  revision += 1;
  for (const listener of statusDetailListeners) listener();
}
