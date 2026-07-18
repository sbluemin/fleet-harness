import fs from "node:fs";
import path from "node:path";

import { assertWithinRoot, safeLstat } from "@dotobokuri/core-infra/fs-store";
import { findWorkspaceDirectory } from "@dotobokuri/core-infra/workspace-dir";

import { parsePlan, type PlanExecutionMode, type PlanWave } from "./plan-parse.js";

export type PlanStoreErrorCode = "unsafe_path" | "not_found" | "too_large";

export interface PlanListItem {
  readonly name: string;
  readonly title: string;
  readonly executionMode: PlanExecutionMode;
  readonly waveCount: number;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly updatedAt: string;
  readonly sizeBytes: number;
}

export interface PlanReadResult {
  readonly name: string;
  readonly title: string;
  readonly executionMode: PlanExecutionMode;
  readonly updatedAt: string;
  readonly content: string;
  readonly waves: readonly PlanWave[];
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

interface PlansRoot {
  readonly plansPath: string;
  readonly workspacePath: string;
}

interface PlanFile {
  readonly path: string;
  readonly stat: fs.Stats;
}

const PLANS_DIRECTORY_NAME = "plans";
const MARKDOWN_EXTENSION = ".md";
const PLAN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const LIST_READ_CONCURRENCY = 16;
export const PLAN_READ_SIZE_CAP = 2 * 1024 * 1024;

export class PlanStoreError extends Error {
  readonly code: PlanStoreErrorCode;

  constructor(code: PlanStoreErrorCode) {
    super(code);
    this.name = "PlanStoreError";
    this.code = code;
  }
}

export async function listPlansForWorkspace(dataDir: string, cwd: string): Promise<readonly PlanListItem[]> {
  const plansRoot = resolvePlansRoot(dataDir, cwd, true);
  if (plansRoot === null) return [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(plansRoot.plansPath, { withFileTypes: true });
  } catch (error) {
    throw toPlanStoreError(error);
  }

  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(MARKDOWN_EXTENSION) && isValidPlanName(entry.name))
    .map((entry) => entry.name);
  const plans: PlanListItem[] = [];

  // 항목 단위 실패(격납 탈출 심링크, 삭제 경합 등)는 목록 전체를 오염시키지 않고 해당 항목만 건너뛴다.
  for (let startIndex = 0; startIndex < names.length; startIndex += LIST_READ_CONCURRENCY) {
    const chunk = names.slice(startIndex, startIndex + LIST_READ_CONCURRENCY);
    const results = await Promise.all(chunk.map((name) => toPlanListItem(plansRoot, name).catch(() => null)));
    plans.push(...results.filter((plan): plan is PlanListItem => plan !== null));
  }

  return plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Resolves the Plans directory for server-side observation only.  A missing
 * workspace or Plans directory is deliberately represented as null: readers
 * and watchers must never create either as a side effect of a request.
 */
export function resolvePlansWatchDirectory(dataDir: string, cwd: string): string | null {
  return resolvePlansRoot(dataDir, cwd, true)?.plansPath ?? null;
}

export function isValidPlanName(name: string): boolean {
  return PLAN_NAME_PATTERN.test(name) && !name.includes("..");
}

export async function readPlanForWorkspace(dataDir: string, cwd: string, name: string): Promise<PlanReadResult> {
  const plansRoot = resolvePlansRoot(dataDir, cwd, false);
  if (plansRoot === null) throw new PlanStoreError("not_found");

  const file = await resolvePlanFile(plansRoot, name);
  if (file.stat.size > PLAN_READ_SIZE_CAP) throw new PlanStoreError("too_large");

  let content: string;
  try {
    content = await fs.promises.readFile(file.path, "utf8");
  } catch (error) {
    throw toPlanStoreError(error);
  }

  const parsed = parsePlan(content);
  return {
    name,
    title: parsed.title ?? name,
    executionMode: parsed.executionMode,
    updatedAt: file.stat.mtime.toISOString(),
    content,
    waves: parsed.waves,
    tasksDone: parsed.tasksDone,
    tasksTotal: parsed.tasksTotal,
  };
}

async function toPlanListItem(plansRoot: PlansRoot, name: string): Promise<PlanListItem> {
  const file = await resolvePlanFile(plansRoot, name);
  // 목록 경로에서도 read 캡을 존중한다 — 초과 파일은 본문을 읽지 않고 구조 정보 없이 나열만 한다.
  if (file.stat.size > PLAN_READ_SIZE_CAP) {
    return {
      name,
      title: name,
      executionMode: null,
      waveCount: 0,
      tasksDone: 0,
      tasksTotal: 0,
      updatedAt: file.stat.mtime.toISOString(),
      sizeBytes: file.stat.size,
    };
  }
  const content = await fs.promises.readFile(file.path, "utf8").catch((error: unknown) => {
    throw toPlanStoreError(error);
  });
  const parsed = parsePlan(content);

  return {
    name,
    title: parsed.title ?? name,
    executionMode: parsed.executionMode,
    waveCount: parsed.waves.length,
    tasksDone: parsed.tasksDone,
    tasksTotal: parsed.tasksTotal,
    updatedAt: file.stat.mtime.toISOString(),
    sizeBytes: file.stat.size,
  };
}

function resolvePlansRoot(dataDir: string, cwd: string, allowMissing: boolean): PlansRoot | null {
  let workspace;
  try {
    workspace = findWorkspaceDirectory(dataDir, cwd);
  } catch {
    throw new PlanStoreError("unsafe_path");
  }
  if (!workspace) {
    if (allowMissing) return null;
    throw new PlanStoreError("not_found");
  }
  const plansPath = path.join(workspace.path, PLANS_DIRECTORY_NAME);
  assertWithinRoot(workspace.path, plansPath);
  const stat = safeLstat(plansPath);
  if (!stat) {
    if (allowMissing) return null;
    throw new PlanStoreError("not_found");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlanStoreError("unsafe_path");
  return { plansPath, workspacePath: workspace.path };
}

async function resolvePlanFile(plansRoot: PlansRoot, name: string): Promise<PlanFile> {
  try {
    const candidatePath = path.resolve(plansRoot.plansPath, name);
    assertWithinRoot(plansRoot.plansPath, candidatePath);
    assertWithinRoot(plansRoot.workspacePath, candidatePath);
    const stat = safeLstat(candidatePath);
    if (stat?.isSymbolicLink()) throw new PlanStoreError("unsafe_path");
    if (!stat?.isFile()) throw new PlanStoreError("not_found");
    return { path: candidatePath, stat };
  } catch (error) {
    if (error instanceof PlanStoreError) throw error;
    throw new PlanStoreError("unsafe_path");
  }
}

function toPlanStoreError(error: unknown): PlanStoreError {
  if (error instanceof PlanStoreError) return error;
  return new PlanStoreError("not_found");
}
