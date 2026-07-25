import * as fs from "node:fs";
import * as path from "node:path";

import {
  assertWithinRoot,
  ensureSafeDirectory,
  safeLstat,
  withDirectoryLock,
  writeAtomicSync,
} from "@dotobokuri/core-infra/fs-store";
import {
  ensureWorkspaceDirectory,
  findWorkspaceDirectory,
  resolveWorkspaceDirectory,
  resolveWorkspaceDirectoryByName,
  type WorkspaceDirectory,
} from "@dotobokuri/core-infra/workspace-dir";

import {
  lintPlanMarkdown,
  lintPlanMarkdownForWrite,
  normalizePlanMarkdown,
  planMarkdownUsesExactLegacyFullPlanPolicy,
} from "./lint.js";
import {
  assertPlanId,
  formatPlanRef,
  formatTaskRef,
  parsePlanRef,
  parseTaskRef,
} from "./references.js";
import type { PlanDocument, PlanLintResult, PlanTask } from "./types.js";

const PLANS_DIRECTORY_NAME = "plans";
const MAX_PLAN_BYTES = 1024 * 1024;

export interface PlanWriteResult {
  readonly document?: PlanDocument;
  readonly lint: PlanLintResult;
  readonly planRef: string;
  readonly written: boolean;
}

export interface PlanMarkTasksResult {
  readonly alreadyCompleted: readonly string[];
  readonly completed: readonly string[];
  readonly document: PlanDocument;
}

interface PlanLocation {
  readonly filePath: string;
  readonly lockDir: string;
  readonly planId: string;
  readonly plansDir: string;
  readonly planRef: string;
  readonly workspace: WorkspaceDirectory;
}

export function writePlanMarkdown(
  dataDir: string,
  workspaceRoot: string,
  planId: string,
  markdown: string,
): PlanWriteResult {
  assertPlanId(planId);
  assertPlanSize(markdown);
  const normalized = normalizePlanMarkdown(markdown);
  const lint = lintPlanMarkdown(normalized);
  const resolvedWorkspace = resolveWorkspaceDirectory(dataDir, workspaceRoot);
  const planRef = formatPlanRef(resolvedWorkspace.name, planId);
  if (!lint.valid) {
    return { lint, planRef, written: false };
  }

  // 신규 Plan의 레거시 Ohio 정책은 저장소 생성 전에 거부한다(fail-closed).
  // create/replace 허용 결정은 아래 Plan 잠금 안에서만 한다.
  if (
    planMarkdownUsesExactLegacyFullPlanPolicy(normalized)
    && !planFileExists(dataDir, workspaceRoot, planId)
  ) {
    return {
      lint: lintPlanMarkdownForWrite(normalized, false),
      planRef,
      written: false,
    };
  }

  const workspace = ensureWorkspaceDirectory(dataDir, workspaceRoot);
  const location = ensurePlanLocation(workspace, planId);
  return withDirectoryLock({ lockDir: location.lockDir }, () => {
    assertSafePlanFile(location.filePath);
    const existingStat = safeLstat(location.filePath);
    const exists = Boolean(existingStat?.isFile() && !existingStat.isSymbolicLink());
    const allowLegacyFullPlanPolicy = exists && existingPlanUsesExactLegacyFullPlanPolicy(location.filePath);
    const writeLint = lintPlanMarkdownForWrite(normalized, allowLegacyFullPlanPolicy);
    if (!writeLint.valid) {
      return { lint: writeLint, planRef, written: false };
    }
    writeAtomicSync(location.filePath, normalized);
    return {
      document: attachTaskRefs({ lint: writeLint, markdown: normalized, planRef }),
      lint: writeLint,
      planRef,
      written: true,
    };
  });
}

export function readPlanMarkdown(dataDir: string, planRef: string): PlanDocument {
  const location = resolvePlanLocation(dataDir, planRef);
  return readPlanAtLocation(location);
}

export function markPlanTasksComplete(
  dataDir: string,
  taskRefs: readonly string[],
): PlanMarkTasksResult {
  const parsedRefs = normalizeTaskRefs(taskRefs);
  const planRef = formatPlanRef(parsedRefs[0]!.workspaceRef, parsedRefs[0]!.planId);
  const location = resolvePlanLocation(dataDir, planRef);

  return withDirectoryLock({ lockDir: location.lockDir }, () => {
    const document = readPlanAtLocation(location);
    if (!document.lint.valid) {
      throw new Error(`Cannot mark tasks in invalid plan: ${planRef}`);
    }
    const tasksById = new Map(document.lint.tasks.map((task) => [task.id, task]));
    const selected = parsedRefs.map((reference) => {
      const task = tasksById.get(reference.taskId);
      if (!task) throw new Error(`TaskRef does not exist in plan: ${formatTaskRef(planRef, reference.taskId)}`);
      return task;
    });
    assertSingleLane(selected);

    const lines = document.markdown.replace(/\n$/u, "").split("\n");
    const completed: string[] = [];
    const alreadyCompleted: string[] = [];
    for (const task of selected) {
      const taskRef = formatTaskRef(planRef, task.id);
      if (task.completed) {
        alreadyCompleted.push(taskRef);
        continue;
      }
      const lineIndex = task.line - 1;
      const line = lines[lineIndex];
      if (!line || !line.includes(`- [ ] ${task.id} — `)) {
        throw new Error(`Task checkbox changed while marking completion: ${taskRef}`);
      }
      lines[lineIndex] = line.replace(`- [ ] ${task.id} — `, `- [x] ${task.id} — `);
      completed.push(taskRef);
    }

    const markdown = normalizePlanMarkdown(lines.join("\n"));
    const lint = lintPlanMarkdown(markdown);
    if (!lint.valid) {
      throw new Error(`Task completion update produced an invalid plan: ${planRef}`);
    }
    assertSafePlanFile(location.filePath);
    if (completed.length > 0) {
      writeAtomicSync(location.filePath, markdown);
    }
    return {
      alreadyCompleted,
      completed,
      document: attachTaskRefs({ lint, markdown, planRef }),
    };
  });
}

function normalizeTaskRefs(taskRefs: readonly string[]) {
  if (taskRefs.length === 0) {
    throw new Error("At least one TaskRef is required");
  }
  const normalized = taskRefs.map((taskRef) => taskRef.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("TaskRefs in one operation must not contain duplicates");
  }
  const parsed = normalized.map(parseTaskRef);
  const first = parsed[0]!;
  if (parsed.some((reference) => reference.workspaceRef !== first.workspaceRef || reference.planId !== first.planId)) {
    throw new Error("All TaskRefs in one operation must belong to the same PlanRef");
  }
  return parsed;
}

function assertSingleLane(tasks: readonly PlanTask[]): void {
  const laneIds = new Set(tasks.map((task) => task.laneId));
  if (laneIds.size !== 1) {
    throw new Error(`All TaskRefs in one operation must belong to one lane; found ${[...laneIds].join(", ")}`);
  }
}

function attachTaskRefs(document: PlanDocument): PlanDocument {
  return {
    ...document,
    lint: {
      ...document.lint,
      tasks: document.lint.tasks.map((task) => ({
        ...task,
        taskRef: formatTaskRef(document.planRef, task.id),
      })),
    },
  };
}

function readPlanAtLocation(location: PlanLocation): PlanDocument {
  const stat = safeLstat(location.filePath);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Plan not found or unsafe: ${location.planRef}`);
  }
  if (stat.size > MAX_PLAN_BYTES) {
    throw new Error(`Plan exceeds ${MAX_PLAN_BYTES} bytes: ${location.planRef}`);
  }
  const markdown = normalizePlanMarkdown(fs.readFileSync(location.filePath, "utf8"));
  return attachTaskRefs({
    lint: lintPlanMarkdown(markdown),
    markdown,
    planRef: location.planRef,
  });
}

function ensurePlanLocation(workspace: WorkspaceDirectory, planId: string): PlanLocation {
  const plansDir = path.join(workspace.path, PLANS_DIRECTORY_NAME);
  assertWithinRoot(workspace.path, plansDir);
  ensureSafeDirectory(plansDir);
  return buildPlanLocation(workspace, planId);
}

function planFileExists(dataDir: string, workspaceRoot: string, planId: string): boolean {
  const workspace = findWorkspaceDirectory(dataDir, workspaceRoot);
  if (!workspace) return false;
  const filePath = path.join(workspace.path, PLANS_DIRECTORY_NAME, `${planId}.md`);
  assertWithinRoot(workspace.path, filePath);
  const stat = safeLstat(filePath);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

function existingPlanUsesExactLegacyFullPlanPolicy(filePath: string): boolean {
  const stat = safeLstat(filePath);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLAN_BYTES) {
    return false;
  }
  return planMarkdownUsesExactLegacyFullPlanPolicy(
    normalizePlanMarkdown(fs.readFileSync(filePath, "utf8")),
  );
}

function resolvePlanLocation(dataDir: string, planRef: string): PlanLocation {
  const reference = parsePlanRef(planRef);
  const workspace = resolveWorkspaceDirectoryByName(dataDir, reference.workspaceRef);
  const plansDir = path.join(workspace.path, PLANS_DIRECTORY_NAME);
  assertWithinRoot(workspace.path, plansDir);
  const plansStat = safeLstat(plansDir);
  if (!plansStat?.isDirectory() || plansStat.isSymbolicLink()) {
    throw new Error(`Plan directory not found or unsafe: ${planRef}`);
  }
  return buildPlanLocation(workspace, reference.planId);
}

function buildPlanLocation(workspace: WorkspaceDirectory, planId: string): PlanLocation {
  assertPlanId(planId);
  const plansDir = path.join(workspace.path, PLANS_DIRECTORY_NAME);
  const filePath = path.join(plansDir, `${planId}.md`);
  assertWithinRoot(plansDir, filePath);
  return {
    filePath,
    lockDir: path.join(plansDir, `.${planId}.lock`),
    planId,
    plansDir,
    planRef: formatPlanRef(workspace.name, planId),
    workspace,
  };
}

function assertSafePlanFile(filePath: string): void {
  const stat = safeLstat(filePath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Unsafe plan file: ${filePath}`);
  }
}

function assertPlanSize(markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > MAX_PLAN_BYTES) {
    throw new Error(`Plan exceeds ${MAX_PLAN_BYTES} bytes`);
  }
}
