import type { OperationNode } from "@fleet-console/sdk/operations";

import { TOKSCALE_VERSION } from "./cli.js";
import type { LedgerClientDto, LedgerDailyPoint, LedgerOperationDto, LedgerSourceStatus, LedgerSummaryDto, LedgerUsage, LedgerWindow, TokscaleSession } from "./types.js";

interface OperationClaim {
  readonly operation: OperationNode;
  readonly sessionId: string;
  readonly provider: "claude" | "codex";
  readonly cliId: string;
  readonly cliLabel: string;
}

interface Accumulator {
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  messages: number;
}

class AggregateOverflowError extends Error {}

const MAX_DAILY_DAYS = 366;
/** 미매칭 목록 직렬화 상한 — 오래된 Theater의 누적 클레임이 payload를 무한히 키우지 못하게 한다. 전체 수는 unmatchedTotal이 별도로 싣는다. */
const MAX_UNMATCHED = 50;

function emptyAccumulator(): Accumulator {
  return { input: 0, output: 0, cacheRead: 0, costUsd: 0, messages: 0 };
}

function addSession(target: Accumulator, session: TokscaleSession): void {
  target.input = addFinite(target.input, session.input);
  target.output = addFinite(target.output, session.output);
  target.cacheRead = addFinite(target.cacheRead, session.cacheRead);
  target.costUsd = addFinite(target.costUsd, session.costUsd);
  target.messages = addFinite(target.messages, session.messages);
}

function addFinite(left: number, right: number): number {
  const result = left + right;
  if (!Number.isFinite(result)) throw new AggregateOverflowError("ledger aggregate overflow");
  return result;
}

export function localDayKey(atMs: number): string {
  const date = new Date(atMs);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateFromDayKey(day: string): Date {
  const date = new Date(0);
  date.setFullYear(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  date.setHours(12, 0, 0, 0);
  return date;
}

function derivedDailyRange(window: LedgerWindow, generatedAtMs: number): { readonly firstDay: string; readonly lastDay: string } {
  const lastDay = localDayKey(generatedAtMs);
  const firstDate = localDateFromDayKey(lastDay);
  if (window === "week") firstDate.setDate(firstDate.getDate() - 6);
  if (window === "month") firstDate.setDate(1);
  return { firstDay: localDayKey(firstDate.getTime()), lastDay };
}

function fillDailyPoints(
  observed: readonly LedgerDailyPoint[],
  derived: { readonly firstDay: string; readonly lastDay: string },
): LedgerDailyPoint[] {
  if (observed.length === 0) return [];
  // 파생 경계만 쓰면 upstream이 더 넓게 반환한 데이터를 자를 수 있고, 관측 범위만 쓰면 축이
  // 활동일만 설명하므로 두 범위의 합집합을 써야 어느 month 의미에서도 실제 데이터와 기간을 보존한다.
  let firstDay = observed[0]!.day < derived.firstDay ? observed[0]!.day : derived.firstDay;
  const observedLastDay = observed[observed.length - 1]!.day;
  const lastDay = observedLastDay > derived.lastDay ? observedLastDay : derived.lastDay;
  const cutoffDate = localDateFromDayKey(lastDay);
  cutoffDate.setDate(cutoffDate.getDate() - (MAX_DAILY_DAYS - 1));
  const cutoffDay = localDayKey(cutoffDate.getTime());
  if (firstDay < cutoffDay) firstDay = cutoffDay;
  const costs = new Map(observed.map((point) => [point.day, point.costUsd]));
  const daily: LedgerDailyPoint[] = [];
  const current = localDateFromDayKey(firstDay);
  while (true) {
    const day = localDayKey(current.getTime());
    daily.push({ day, costUsd: costs.get(day) ?? 0 });
    if (day === lastDay) return daily;
    current.setDate(current.getDate() + 1);
  }
}

function usageOf(value: Accumulator): LedgerUsage {
  return { input: value.input, output: value.output, cacheRead: value.cacheRead };
}

function stringField(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? payload[key] : "";
}

function readClaim(operation: OperationNode): OperationClaim | null {
  if (operation.pluginId !== "terminal" || operation.type !== "agent") return null;
  const providerSession = operation.payload.providerSession;
  if (!providerSession || typeof providerSession !== "object") return null;
  const candidate = providerSession as { readonly provider?: unknown; readonly sessionId?: unknown };
  if ((candidate.provider !== "claude" && candidate.provider !== "codex") || typeof candidate.sessionId !== "string") return null;
  return {
    operation,
    sessionId: candidate.sessionId,
    provider: candidate.provider,
    cliId: stringField(operation.payload, "cliId"),
    cliLabel: stringField(operation.payload, "cliLabel"),
  };
}

export function nativeSessionId(session: TokscaleSession): string | null {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (session.client === "claude") {
    const match = session.sessionId.match(new RegExp(`^(${uuid})$`, "i"));
    return match?.[1]?.toLowerCase() ?? null;
  }
  if (session.client !== "codex") return null;
  const timestamp = "\\d{4}-\\d{2}-\\d{2}T\\d{2}(?:-|:)\\d{2}(?:-|:)\\d{2}(?:\\.\\d{3})?Z?";
  const match = session.sessionId.match(new RegExp(`^rollout-${timestamp}-(${uuid})$`, "i"));
  return match?.[1]?.toLowerCase() ?? null;
}

export function buildSummary(
  sessions: readonly TokscaleSession[],
  operations: readonly OperationNode[],
  scope: { readonly theaterId: string | null; readonly window: LedgerWindow },
  status: LedgerSourceStatus = "ok",
  generatedAtMs = Date.now(),
  skippedSessions = 0,
): LedgerSummaryDto {
  try {
    return buildSummaryUnchecked(sessions, operations, scope, status, generatedAtMs, skippedSessions);
  } catch (error) {
    if (!(error instanceof AggregateOverflowError)) throw error;
    return {
      schemaVersion: 1,
      scope,
      generatedAtMs,
      totals: { costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 },
      operations: [],
      unmatched: [],
      unmatchedTotal: 0,
      otherTheaterTotals: { costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 },
      deviceTotals: { costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0, sessions: 0 },
      clients: [],
      daily: [],
      dailyAttributed: [],
      source: {
        status: "unreadable",
        skippedSessions: skippedSessions + sessions.length,
      },
    };
  }
}

function buildSummaryUnchecked(
  sessions: readonly TokscaleSession[],
  operations: readonly OperationNode[],
  scope: { readonly theaterId: string | null; readonly window: LedgerWindow },
  status: LedgerSourceStatus,
  generatedAtMs: number,
  skippedSessions: number,
): LedgerSummaryDto {
  const operationClaims = operations
    .map(readClaim)
    .filter((claim): claim is OperationClaim => claim !== null)
    .sort((a, b) => (
      b.operation.ts.updatedAt - a.operation.ts.updatedAt
      || (a.operation.id < b.operation.id ? -1 : a.operation.id > b.operation.id ? 1 : 0)
    ));
  const claims = new Map<string, OperationClaim>();
  for (const claim of operationClaims) {
    const key = `${claim.provider}:${claim.sessionId.toLowerCase()}`;
    if (!claims.has(key)) claims.set(key, claim);
  }

  const operationBuckets = new Map<string, { claim: OperationClaim; sessions: TokscaleSession[] }>();
  const otherTheaterValues = emptyAccumulator();
  const dailyAttributedMap = new Map<string, number>();
  for (const session of sessions) {
    const sessionId = nativeSessionId(session);
    const provider = session.client === "claude" || session.client === "codex" ? session.client : null;
    const claim = sessionId && provider ? claims.get(`${provider}:${sessionId}`) : undefined;
    if (!claim) continue;
    // 스코프 밖 Theater에 귀속된 사용량 — "기타 로컬 세션"과 구분해 브릿지가 Console 귀속을 거짓으로 말하지 않게 한다.
    if (scope.theaterId !== null && claim.operation.theaterId !== scope.theaterId) {
      addSession(otherTheaterValues, session);
      continue;
    }
    // 차트 귀속 레이어 — 브릿지의 첫 버킷(스코프 귀속)과 같은 모집단을 일별로 나눈다.
    const attributedDay = localDayKey(session.lastActive);
    dailyAttributedMap.set(attributedDay, addFinite(dailyAttributedMap.get(attributedDay) ?? 0, session.costUsd));
    const bucket = operationBuckets.get(claim.operation.id) ?? { claim, sessions: [] };
    bucket.sessions.push(session);
    operationBuckets.set(claim.operation.id, bucket);
  }

  const operationDtos: LedgerOperationDto[] = [...operationBuckets.values()]
    .filter(({ claim }) => scope.theaterId === null || claim.operation.theaterId === scope.theaterId)
    .map(({ claim, sessions: claimed }) => {
      const totals = emptyAccumulator();
      for (const session of claimed) addSession(totals, session);
      return {
        operationId: claim.operation.id,
        title: claim.operation.title,
        cliId: claim.cliId,
        cliLabel: claim.cliLabel,
        client: claimed[0]?.client ?? claim.provider,
        messages: totals.messages,
        usage: usageOf(totals),
        costUsd: totals.costUsd,
        models: [...new Set(claimed.flatMap((session) => session.models))],
        lastActivityAtMs: Math.max(...claimed.map((session) => session.lastActive)),
      };
    }).sort((a, b) => b.lastActivityAtMs - a.lastActivityAtMs);

  // 저장 세션 클레임은 있으나 이 window의 원본에서 한 세션도 매칭되지 않은 Operation —
  // 목록에서 조용히 지우지 않고 화면이 그 사실을 말할 수 있게 별도 목록으로보낸다.
  // dedup된 claims(같은 세션을 두 Operation이 가리키면 최신만 남음) 기준이라
  // 사용량이 다른 Operation에 귀속된 중복 클레임은 unmatched로 오표기되지 않는다.
  const unmatchedAll = [...claims.values()]
    .filter((claim) => !operationBuckets.has(claim.operation.id))
    .filter((claim) => scope.theaterId === null || claim.operation.theaterId === scope.theaterId)
    .map((claim) => ({
      operationId: claim.operation.id,
      title: claim.operation.title,
      cliId: claim.cliId,
      cliLabel: claim.cliLabel,
      lastActivityAtMs: claim.operation.ts.updatedAt,
    }));
  const unmatched = unmatchedAll.slice(0, MAX_UNMATCHED);

  const totalValues = emptyAccumulator();
  for (const operation of operationDtos) {
    totalValues.input = addFinite(totalValues.input, operation.usage.input);
    totalValues.output = addFinite(totalValues.output, operation.usage.output);
    totalValues.cacheRead = addFinite(totalValues.cacheRead, operation.usage.cacheRead);
    totalValues.costUsd = addFinite(totalValues.costUsd, operation.costUsd);
    totalValues.messages = addFinite(totalValues.messages, operation.messages);
  }
  const clientMap = new Map<string, { sessions: number; totals: Accumulator }>();
  const dailyMap = new Map<string, number>();
  const deviceValues = emptyAccumulator();
  let deviceSessions = 0;
  for (const session of sessions) {
    const client = clientMap.get(session.client) ?? { sessions: 0, totals: emptyAccumulator() };
    client.sessions = addFinite(client.sessions, 1);
    addSession(client.totals, session);
    clientMap.set(session.client, client);
    addSession(deviceValues, session);
    deviceSessions = addFinite(deviceSessions, 1);
    const day = localDayKey(session.lastActive);
    dailyMap.set(day, addFinite(dailyMap.get(day) ?? 0, session.costUsd));
  }
  const clients: LedgerClientDto[] = [...clientMap.entries()]
    .map(([client, value]) => ({
      client,
      sessions: value.sessions,
      usage: usageOf(value.totals),
      costUsd: value.totals.costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0));
  const observedDaily: LedgerDailyPoint[] = [...dailyMap.entries()]
    .map(([day, costUsd]) => ({ day, costUsd }))
    .sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  const daily = fillDailyPoints(observedDaily, derivedDailyRange(scope.window, generatedAtMs));
  // daily와 같은 날짜 축을 보장해 클라이언트가 인덱스 정렬 없이 겹쳐 그릴 수 있게 한다.
  const dailyAttributed: LedgerDailyPoint[] = daily.map((point) => ({
    day: point.day,
    costUsd: dailyAttributedMap.get(point.day) ?? 0,
  }));

  return {
    schemaVersion: 1,
    scope,
    generatedAtMs,
    totals: { ...usageOf(totalValues), costUsd: totalValues.costUsd, messages: totalValues.messages },
    operations: operationDtos,
    unmatched,
    unmatchedTotal: unmatchedAll.length,
    otherTheaterTotals: { ...usageOf(otherTheaterValues), costUsd: otherTheaterValues.costUsd, messages: otherTheaterValues.messages },
    deviceTotals: { ...usageOf(deviceValues), costUsd: deviceValues.costUsd, messages: deviceValues.messages, sessions: deviceSessions },
    clients,
    daily,
    dailyAttributed,
    source: { status, skippedSessions },
  };
}
