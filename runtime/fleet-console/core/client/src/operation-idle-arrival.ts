const listeners = new Set<() => void>();

let idleArrivalIds = new Set<string>();
let acknowledgementSuspended = false;

export function markIdleArrival(id: string): void {
  if (idleArrivalIds.has(id)) return;
  idleArrivalIds = new Set(idleArrivalIds);
  idleArrivalIds.add(id);
  for (const listener of listeners) listener();
}

export function acknowledgeIdleArrival(id: string): boolean {
  if (acknowledgementSuspended) return false;
  clearIdleArrival(id);
  return true;
}

export function setIdleArrivalAcknowledgementSuspended(suspended: boolean): void {
  acknowledgementSuspended = suspended;
}

export function clearIdleArrival(id: string): void {
  if (!idleArrivalIds.has(id)) return;
  idleArrivalIds = new Set(idleArrivalIds);
  idleArrivalIds.delete(id);
  for (const listener of listeners) listener();
}

export function getIdleArrivalIds(): ReadonlySet<string> {
  return idleArrivalIds;
}

export function subscribeIdleArrival(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetIdleArrivalForTests(): void {
  idleArrivalIds = new Set();
  acknowledgementSuspended = false;
}
