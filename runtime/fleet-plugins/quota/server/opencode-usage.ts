import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { QuotaWindow } from "./types.js";

/**
 * OpenCode Go 관측 사용량 스캐너 — OpenUsage(robinebers/openusage)의 OpenCode provider와
 * 같은 접근을 이식했다. Go에는 아직 키 인증 사용량 API가 없으므로(2026-08-03 실측),
 * opencode CLI가 이 기기에 남기는 SQLite 로그(`opencode*.db`)의 메시지별 `cost`를 합산해
 * 공개된 플랜 캡($12/5h 롤링·$30/UTC 월요일 주·$60/최초 사용일 앵커 월) 대비 창을 만든다.
 *
 * 한계도 같은 방식으로 정직하게 진다: 이 수치는 "이 기기의 opencode CLI가 기록한 스펜딩"
 * 이다. 다른 기기 사용분과 Fleet 게이트웨이 경유 사용분은 opencode.db에 기록되지 않아
 * 실제 계정 사용량보다 낮게 읽힐 수 있다. 공식 usage API가 출시되면 같은 창 계약 위에서
 * 권위 있는 숫자로 교체한다.
 */

export const OPENCODE_GO_SESSION_CAP_USD = 12;
export const OPENCODE_GO_WEEKLY_CAP_USD = 30;
export const OPENCODE_GO_MONTHLY_CAP_USD = 60;

const SESSION_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 86_400_000;
const SCAN_DAYS_BACK = 33;

export interface OpencodeGoWindowsResult {
  readonly windows: readonly QuotaWindow[];
  readonly cycleDays: number;
}

export interface OpencodeUsageScanDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly now?: () => number;
}

/**
 * opencode 자신의 해석 순서를 미러링한다: OPENCODE_DATA_DIR → $XDG_DATA_HOME/opencode →
 * ~/.local/share/opencode.
 */
export function resolveOpencodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const override = env.OPENCODE_DATA_DIR?.trim();
  if (override) return expandHome(override, homeDir).replace(/\/+$/, "");
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return `${expandHome(xdg, homeDir).replace(/\/+$/, "")}/opencode`;
  return path.join(homeDir, ".local", "share", "opencode");
}

/**
 * 채널별로 분할된 모든 `opencode*.db`(stable=opencode.db, preview=opencode-next.db 등)를
 * 읽는다. 디렉터리 부재는 "opencode 미사용"으로 빈 배열이고, 존재하는데 열거가 실패하면
 * 부재와 구분하기 위해 그대로 던진다.
 */
export function listOpencodeDatabases(dataDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch (error) {
    if (!fs.existsSync(dataDir)) return [];
    throw error;
  }
  return names
    .filter((name) => name.startsWith("opencode") && name.endsWith(".db"))
    .sort()
    .map((name) => path.join(dataDir, name));
}

/**
 * 로컬 opencode DB에서 Go 창 3종을 계산한다.
 * - `null`: 이 기기에 opencode DB가 아예 없다(정상적인 "로컬 데이터 없음").
 * - throw: DB가 존재하는데 전부 읽기 실패했다 — 0 사용량으로 오독하면 안 되는 상태.
 */
export async function scanOpencodeGoWindows(
  deps: OpencodeUsageScanDeps = {},
): Promise<OpencodeGoWindowsResult | null> {
  const nowMs = (deps.now ?? Date.now)();
  const dataDir = resolveOpencodeDataDir(deps.env ?? process.env, deps.homeDir ?? os.homedir());
  const databases = listOpencodeDatabases(dataDir);
  if (databases.length === 0) return null;

  // node:sqlite는 Node 22.5+의 내장 모듈이다. 구버전 런타임에서는 로더가 던지므로,
  // 호출자가 창 없는 상태로 강등할 수 있게 그대로 전파한다.
  const { DatabaseSync } = await import("node:sqlite");

  const cutoffMs = nowMs - SCAN_DAYS_BACK * 86_400_000;
  const costs: { ms: number; cost: number }[] = [];
  let anchorMs: number | undefined;
  let failures = 0;

  for (const databasePath of databases) {
    let db: InstanceType<typeof DatabaseSync> | undefined;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      const rows = db.prepare(
        `SELECT time_created AS ms, json_extract(data,'$.cost') AS cost
         FROM message
         WHERE time_created >= ?
           AND json_valid(data)
           AND json_extract(data,'$.role') = 'assistant'
           AND json_extract(data,'$.providerID') = 'opencode-go'
           AND json_type(data,'$.cost') IN ('integer','real')`,
      ).all(cutoffMs) as { ms: unknown; cost: unknown }[];
      for (const row of rows) {
        if (typeof row.ms !== "number" || typeof row.cost !== "number" || row.cost < 0) continue;
        costs.push({ ms: row.ms, cost: row.cost });
      }
      // 월 주기 앵커: 이 기기의 최초 Go 사용 시각. 실패는 달력 월 폴백으로 조용히 흡수한다.
      const anchorRow = db.prepare(
        `SELECT MIN(time_created) AS ms FROM message
         WHERE json_valid(data)
           AND json_extract(data,'$.role') = 'assistant'
           AND json_extract(data,'$.providerID') = 'opencode-go'
           AND json_type(data,'$.cost') IN ('integer','real')`,
      ).get() as { ms: unknown } | undefined;
      if (typeof anchorRow?.ms === "number") {
        anchorMs = anchorMs === undefined ? anchorRow.ms : Math.min(anchorMs, anchorRow.ms);
      }
    } catch {
      failures += 1;
    } finally {
      db?.close();
    }
  }
  if (failures === databases.length) {
    throw new Error("Every OpenCode database exists but could not be read");
  }

  return computeOpencodeGoWindows(costs, anchorMs, nowMs);
}

/** 순수 창 계산 — UTC 기반이라 결정적이고 단위 테스트 가능하다. */
export function computeOpencodeGoWindows(
  costs: readonly { ms: number; cost: number }[],
  anchorMs: number | undefined,
  nowMs: number,
): OpencodeGoWindowsResult {
  const sessionStart = nowMs - SESSION_MS;
  const sessionSpend = sumRange(costs, sessionStart, nowMs);
  const oldestInSession = costs
    .filter((row) => row.ms >= sessionStart && row.ms < nowMs)
    .reduce<number | undefined>((min, row) => (min === undefined ? row.ms : Math.min(min, row.ms)), undefined);
  const sessionResetsAt = (oldestInSession ?? nowMs) + SESSION_MS;

  const weekStart = startOfUtcWeek(nowMs);
  const weekEnd = weekStart + WEEK_MS;
  const weeklySpend = sumRange(costs, weekStart, weekEnd);

  const month = anchoredMonthBounds(nowMs, anchorMs);
  const monthlySpend = sumRange(costs, month.start, month.end);

  // period: 캡과 창 경계는 공개된 플랜 지식(catalog)이고, 시작 시각은 그 규칙에서
  // 계산(derived)했다. 금액(amounts)은 달러 단위라 계약상 제외한다.
  return {
    windows: [
      {
        id: "session",
        usedPercent: percent(sessionSpend, OPENCODE_GO_SESSION_CAP_USD),
        resetsAt: sessionResetsAt,
        period: {
          durationMs: SESSION_MS,
          durationBasis: "catalog",
          startsAt: sessionResetsAt - SESSION_MS,
          startsAtBasis: "derived",
        },
      },
      {
        id: "weekly",
        usedPercent: percent(weeklySpend, OPENCODE_GO_WEEKLY_CAP_USD),
        resetsAt: weekEnd,
        period: {
          durationMs: WEEK_MS,
          durationBasis: "catalog",
          startsAt: weekStart,
          startsAtBasis: "derived",
        },
      },
      {
        id: "cycle",
        usedPercent: percent(monthlySpend, OPENCODE_GO_MONTHLY_CAP_USD),
        resetsAt: month.end,
        period: {
          durationMs: month.end - month.start,
          durationBasis: "catalog",
          startsAt: month.start,
          startsAtBasis: "derived",
        },
      },
    ],
    cycleDays: Math.round((month.end - month.start) / 86_400_000),
  };
}

function percent(spend: number, cap: number): number {
  return Math.max(0, Math.min(100, Math.round((spend / cap) * 100)));
}

function sumRange(costs: readonly { ms: number; cost: number }[], start: number, end: number): number {
  const total = costs.reduce(
    (partial, row) => (row.ms >= start && row.ms < end ? partial + row.cost : partial),
    0,
  );
  // 캡으로 나누기 전에 부동소수 합산 노이즈를 1/100센트 단위로 스냅한다.
  return Math.round(total * 10_000) / 10_000;
}

function startOfUtcWeek(nowMs: number): number {
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return dayStart - daysSinceMonday * 86_400_000;
}

function anchoredMonthBounds(
  nowMs: number,
  anchorMs: number | undefined,
): { start: number; end: number } {
  const now = new Date(nowMs);
  if (anchorMs === undefined || !Number.isFinite(anchorMs)) {
    return {
      start: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      end: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    };
  }
  const anchor = new Date(anchorMs);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let start = anchoredMonthStart(year, month, anchor);
  // 앵커 일자가 오늘보다 뒤면 진행 중인 주기는 지난달에 시작했다.
  if (start > nowMs) {
    month -= 1;
    start = anchoredMonthStart(year, month, anchor);
  }
  const end = anchoredMonthStart(year, month + 1, anchor);
  return { start, end };
}

/** 해당 월 안의 앵커 주기 시작: 앵커의 일자(월 길이에 클램프)와 시각, UTC. */
function anchoredMonthStart(year: number, month: number, anchor: Date): number {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchor.getUTCDate(), daysInMonth);
  return Date.UTC(
    year,
    month,
    day,
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}
