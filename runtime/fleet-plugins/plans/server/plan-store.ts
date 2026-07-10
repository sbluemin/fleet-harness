import fs from "node:fs";
import path from "node:path";

import { parsePlan, type PlanWave } from "./plan-parse.js";

export type PlanStoreErrorCode = "path_outside_theater" | "not_found" | "too_large";

export interface PlanListItem {
  readonly name: string;
  readonly title: string;
  readonly waveCount: number;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly updatedAt: string;
  readonly sizeBytes: number;
}

export interface PlanReadResult {
  readonly name: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly content: string;
  readonly waves: readonly PlanWave[];
}

interface PlansRoot {
  readonly realTheaterPath: string;
  readonly realPlansPath: string;
}

interface PlanFile {
  readonly realPath: string;
  readonly stat: fs.Stats;
}

const PLANS_DIRECTORY_SEGMENTS = [".fleet", "plans"] as const;
const MARKDOWN_EXTENSION = ".md";
export const PLAN_READ_SIZE_CAP = 2 * 1024 * 1024;

export class PlanStoreError extends Error {
  readonly code: PlanStoreErrorCode;

  constructor(code: PlanStoreErrorCode) {
    super(code);
    this.name = "PlanStoreError";
    this.code = code;
  }
}

export async function listPlansForTheater(theaterPath: string): Promise<readonly PlanListItem[]> {
  const plansRoot = await resolvePlansRoot(theaterPath, true);
  if (plansRoot === null) return [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(plansRoot.realPlansPath, { withFileTypes: true });
  } catch (error) {
    throw toPlanStoreError(error);
  }

  // 항목 단위 실패(격납 탈출 심링크, 삭제 경합 등)는 목록 전체를 오염시키지 않고 해당 항목만 건너뛴다.
  const plans = (await Promise.all(entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(MARKDOWN_EXTENSION))
    .map((entry) => toPlanListItem(plansRoot, entry.name).catch(() => null))))
    .filter((plan): plan is PlanListItem => plan !== null);

  return plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readPlanForTheater(theaterPath: string, name: string): Promise<PlanReadResult> {
  const plansRoot = await resolvePlansRoot(theaterPath, false);
  if (plansRoot === null) throw new PlanStoreError("not_found");

  const file = await resolvePlanFile(plansRoot, name);
  if (file.stat.size > PLAN_READ_SIZE_CAP) throw new PlanStoreError("too_large");

  let content: string;
  try {
    content = await fs.promises.readFile(file.realPath, "utf8");
  } catch (error) {
    throw toPlanStoreError(error);
  }

  const parsed = parsePlan(content);
  return {
    name,
    title: parsed.title ?? name,
    updatedAt: file.stat.mtime.toISOString(),
    content,
    waves: parsed.waves,
  };
}

async function toPlanListItem(plansRoot: PlansRoot, name: string): Promise<PlanListItem> {
  const file = await resolvePlanFile(plansRoot, name);
  // 목록 경로에서도 read 캡을 존중한다 — 초과 파일은 본문을 읽지 않고 구조 정보 없이 나열만 한다.
  if (file.stat.size > PLAN_READ_SIZE_CAP) {
    return {
      name,
      title: name,
      waveCount: 0,
      tasksDone: 0,
      tasksTotal: 0,
      updatedAt: file.stat.mtime.toISOString(),
      sizeBytes: file.stat.size,
    };
  }
  const content = await fs.promises.readFile(file.realPath, "utf8").catch((error: unknown) => {
    throw toPlanStoreError(error);
  });
  const parsed = parsePlan(content);

  return {
    name,
    title: parsed.title ?? name,
    waveCount: parsed.waves.length,
    tasksDone: parsed.tasksDone,
    tasksTotal: parsed.tasksTotal,
    updatedAt: file.stat.mtime.toISOString(),
    sizeBytes: file.stat.size,
  };
}

async function resolvePlansRoot(theaterPath: string, allowMissing: boolean): Promise<PlansRoot | null> {
  const nominalTheaterPath = path.resolve(theaterPath);
  const plansPath = path.resolve(nominalTheaterPath, ...PLANS_DIRECTORY_SEGMENTS);
  if (!isWithinRoot(plansPath, nominalTheaterPath)) throw new PlanStoreError("path_outside_theater");

  let realTheaterPath: string;
  let realPlansPath: string;
  try {
    [realTheaterPath, realPlansPath] = await Promise.all([
      fs.promises.realpath(nominalTheaterPath),
      fs.promises.realpath(plansPath),
    ]);
  } catch (error) {
    if (allowMissing && isNotFoundError(error)) return null;
    throw toPlanStoreError(error);
  }
  if (!isWithinRoot(realPlansPath, realTheaterPath)) throw new PlanStoreError("path_outside_theater");

  return { realTheaterPath, realPlansPath };
}

async function resolvePlanFile(plansRoot: PlansRoot, name: string): Promise<PlanFile> {
  const candidatePath = path.resolve(plansRoot.realPlansPath, name);
  if (!isWithinRoot(candidatePath, plansRoot.realPlansPath)) throw new PlanStoreError("path_outside_theater");

  let realPath: string;
  try {
    realPath = await fs.promises.realpath(candidatePath);
  } catch (error) {
    throw toPlanStoreError(error);
  }
  if (!isWithinRoot(realPath, plansRoot.realPlansPath) || !isWithinRoot(realPath, plansRoot.realTheaterPath)) {
    throw new PlanStoreError("path_outside_theater");
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realPath);
  } catch (error) {
    throw toPlanStoreError(error);
  }
  if (!stat.isFile()) throw new PlanStoreError("not_found");

  return { realPath, stat };
}

function isWithinRoot(resolvedPath: string, rootPath: string): boolean {
  const normalizedRoot = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  return resolvedPath === rootPath || resolvedPath.startsWith(normalizedRoot);
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function toPlanStoreError(error: unknown): PlanStoreError {
  if (error instanceof PlanStoreError) return error;
  return new PlanStoreError("not_found");
}
