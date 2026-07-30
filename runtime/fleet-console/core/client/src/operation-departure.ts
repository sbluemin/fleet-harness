const DEPARTURE_COOLDOWN_MS = 60_000;
const DEPARTURE_EXPIRY_MS = 30_000;

const listeners = new Set<() => void>();

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
  emit();
}

export function clearDeparture(id: string): void {
  if (!departureMarkedAt.has(id)) return;
  departureMarkedAt = new Map(departureMarkedAt);
  departureMarkedAt.delete(id);
  scheduleExpirySweep(Date.now());
  emit();
}

export function getDepartureIds(): ReadonlySet<string> {
  const now = Date.now();
  if (sweepExpired(now)) {
    scheduleExpirySweep(now);
    emit();
  }
  return new Set(departureMarkedAt.keys());
}

export function subscribeDeparture(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
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
    if (changed) emit();
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

function emit(): void {
  for (const listener of listeners) listener();
}
