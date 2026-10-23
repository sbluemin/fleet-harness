import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describeConsoleUpdateFailure } from "@fleet-console/protocol/lifecycle";
import type { ConsoleUpdateProgressStatus } from "./update-progress.js";

const FILE = "session-update-notice.json";

/** 설치 성공 기록이 세션 종료 결과를 덮지 않도록 별도로 보관한다. */
export function recordSessionUpdateIncompatibility(dataDir: string, fromVersion: string, targetVersion: string, at = Date.now()): void {
  recordSessionUpdateNotice(dataDir, { reason: "session-bridge-incompatible", fromVersion, targetVersion }, at);
}

export function recordSessionUpdateNotice(dataDir: string, notice: { readonly reason: "session-bridge-incompatible" | "session-preservation-unavailable"; readonly fromVersion: string; readonly targetVersion: string }, at = Date.now()): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, at, ...notice }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function clearSessionUpdateNotice(dataDir: string): void { fs.rmSync(path.join(dataDir, FILE), { force: true }); }
export function readSessionUpdateNotice(dataDir: string, now: number, ttlMs: number): ConsoleUpdateProgressStatus | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), "utf8")) as { schema?: number; at?: number; reason?: string; fromVersion?: string; targetVersion?: string };
    if (value.schema !== 1 || !Number.isFinite(value.at) || value.at! > now || now - value.at! > ttlMs || typeof value.fromVersion !== "string" || typeof value.targetVersion !== "string" || !/^[0-9A-Za-z.+_-]{1,100}$/.test(value.fromVersion) || !/^[0-9A-Za-z.+_-]{1,100}$/.test(value.targetVersion)) return null;
    if (value.reason !== undefined && value.reason !== "session-bridge-incompatible" && value.reason !== "session-preservation-unavailable") return null;
    const reason = value.reason ?? "session-bridge-incompatible";
    return { state: "failed", phase: "failed", reason, description: describeConsoleUpdateFailure(reason), startedAt: new Date(value.at!).toISOString(), fromVersion: value.fromVersion, targetVersion: value.targetVersion };
  } catch { return null; }
}
