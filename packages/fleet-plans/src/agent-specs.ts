import type { AgentToolSpec, McpCallToolResult } from "@dotobokuri/core-agent";
import { Type } from "typebox";

import { formatPlanRef, parseTaskRef } from "./references.js";
import {
  markPlanTasksComplete,
  readPlanMarkdown,
  writePlanMarkdown,
} from "./store.js";
import type { PlanDocument, PlanTask } from "./types.js";

export const FLEET_PLAN_TOOL_IDS = [
  "plan_read",
  "plan_write",
  "plan_mark_tasks",
  "plan_verify",
] as const;

export interface PlanToolSpecs {
  readonly markTasks: AgentToolSpec;
  readonly read: AgentToolSpec;
  readonly verify: AgentToolSpec;
  readonly write: AgentToolSpec;
}

export interface PlanToolSpecDeps {
  readonly dataDir: string;
}

const PLAN_REF_SCHEMA = Type.String({
  description: "Logical PlanRef returned by plan_write, formatted as <workspace-ref>:<plan-id>.",
  minLength: 3,
});
const TASK_REFS_SCHEMA = Type.Array(Type.String({ minLength: 5 }), {
  description: "Fully qualified TaskRefs formatted as <plan-ref>#<task-id>.",
  minItems: 1,
  uniqueItems: true,
});
const PLAN_ID_PATTERN = "^(?!.*\\.md$)[a-z0-9](?:[a-z0-9_-]|\\.(?=[a-z0-9_-])){0,127}$";

export function getPlanToolSpecs(deps: PlanToolSpecDeps): PlanToolSpecs {
  return {
    read: buildPlanReadSpec(deps),
    write: buildPlanWriteSpec(deps),
    markTasks: buildPlanMarkTasksSpec(deps),
    verify: buildPlanVerifySpec(deps),
  };
}

function buildPlanReadSpec(deps: PlanToolSpecDeps): AgentToolSpec {
  return {
    id: "plan_read",
    tag: "plan_read",
    title: "Plan Read",
    description: "Read and deterministically lint one workspace-scoped Fleet Plan, optionally resolving an assigned same-lane TaskRef set.",
    promptSnippet: "Read PlanRef or TaskRefs through the Fleet Plan boundary; never reconstruct a data-dir file path.",
    whenToUse: [
      "A structured Fleet Plan or assigned Ohio tasks must be inspected",
      "Plan validity, task identity, topology, or completion state is needed",
    ],
    whenNotToUse: [
      "Creating or replacing a Plan — Kirov uses plan_write",
      "Marking completed Ohio tasks — use plan_mark_tasks after the lane QA gate",
    ],
    usageGuidelines: [
      "Provide exactly one plan_ref or a task_refs array, never both.",
      "Treat valid=false as a blocking Plan contract failure; do not execute an invalid Plan.",
      "A task_refs read rejects cross-Plan or cross-Lane selections.",
    ],
    guardrails: ["Read-only: this tool never creates directories or mutates Plan state."],
    parameters: Type.Object({
      plan_ref: Type.Optional(PLAN_REF_SCHEMA),
      task_refs: Type.Optional(TASK_REFS_SCHEMA),
    }, { additionalProperties: false }),
    async execute(args) {
      return captureToolError("plan_read", () => {
        const input = asRecord(args);
        const planRef = optionalString(input.plan_ref);
        const taskRefs = optionalStringArray(input.task_refs);
        if ((planRef ? 1 : 0) + (taskRefs ? 1 : 0) !== 1) {
          throw new Error("plan_read requires exactly one of plan_ref or task_refs");
        }
        if (planRef) {
          return toReadPayload(readPlanMarkdown(deps.dataDir, planRef));
        }
        const references = taskRefs!.map(parseTaskRef);
        const first = references[0]!;
        if (references.some((reference) => reference.workspaceRef !== first.workspaceRef || reference.planId !== first.planId)) {
          throw new Error("All TaskRefs must belong to the same PlanRef");
        }
        const resolvedPlanRef = formatPlanRef(first.workspaceRef, first.planId);
        const document = readPlanMarkdown(deps.dataDir, resolvedPlanRef);
        const byId = new Map(document.lint.tasks.map((task) => [task.id, task]));
        const assignedTasks = references.map((reference) => {
          const task = byId.get(reference.taskId);
          if (!task) throw new Error(`TaskRef does not exist in Plan: ${reference.taskId}`);
          return task;
        });
        const laneIds = new Set(assignedTasks.map((task) => task.laneId));
        if (laneIds.size !== 1) {
          throw new Error(`Assigned TaskRefs must belong to one Lane; found ${[...laneIds].join(", ")}`);
        }
        return {
          ...toReadPayload(document),
          assigned_lane: assignedTasks[0]!.laneId,
          assigned_tasks: assignedTasks,
        };
      });
    },
  };
}

function buildPlanWriteSpec(deps: PlanToolSpecDeps): AgentToolSpec {
  return {
    id: "plan_write",
    tag: "plan_write",
    title: "Plan Write",
    description: "Kirov-only atomic Fleet Plan creation or replacement. Invalid Markdown is rejected before any existing Plan is changed.",
    promptSnippet: "Submit the complete required Markdown template to plan_write, correct every deterministic lint error, then read it back with plan_read.",
    whenToUse: ["Kirov has completed planning and must create or replace the named Plan"],
    whenNotToUse: [
      "Updating task completion checkboxes — Ohio uses plan_mark_tasks",
      "Writing source code, configuration, documentation, or any file outside Fleet Plan storage",
    ],
    usageGuidelines: [
      "Use a stable lowercase plan_id, not a filesystem path.",
      "Include the exact required heading order and stable WN-X-TN task IDs.",
      "Retry only after correcting the returned lint diagnostics.",
    ],
    guardrails: [
      "Kirov-only mutation surface.",
      "The tool computes WorkspaceDir from executor cwd and never accepts a caller path.",
    ],
    parameters: Type.Object({
      plan_id: Type.String({ minLength: 1, maxLength: 128, pattern: PLAN_ID_PATTERN }),
      markdown: Type.String({ minLength: 1, maxLength: 1048576 }),
    }, { additionalProperties: false }),
    async execute(args, ctx) {
      return captureToolError("plan_write", () => {
        const input = asRecord(args);
        const planId = requiredString(input.plan_id, "plan_id");
        const markdown = requiredContent(input.markdown, "markdown");
        const result = writePlanMarkdown(deps.dataDir, ctx.cwd, planId, markdown);
        const payload = {
          ok: result.written,
          tool: "plan_write",
          plan_ref: result.planRef,
          written: result.written,
          lint: result.lint,
          tasks: result.document?.lint.tasks ?? [],
        };
        return result.written ? payload : errorResult(payload);
      });
    },
  };
}

function buildPlanMarkTasksSpec(deps: PlanToolSpecDeps): AgentToolSpec {
  return {
    id: "plan_mark_tasks",
    tag: "plan_mark_tasks",
    title: "Plan Mark Tasks",
    description: "Ohio-only idempotent completion marker that flips assigned same-Lane TaskRefs from unchecked to checked after QA passes.",
    promptSnippet: "After the assigned Lane QA gate passes, mark exactly the completed TaskRefs; never edit Plan Markdown directly.",
    whenToUse: ["Ohio completed every supplied TaskRef and its Lane QA/integration gate passed"],
    whenNotToUse: [
      "Any assigned task or QA gate is incomplete",
      "Task wording, topology, ownership, or Plan structure needs to change — return to Kirov",
    ],
    usageGuidelines: [
      "Submit only the TaskRefs assigned in this Ohio request.",
      "All TaskRefs must belong to one Plan and one Lane.",
      "The operation is idempotent and never changes task text.",
    ],
    guardrails: ["Ohio-only mutation surface; it can only flip known checkbox state to completed."],
    parameters: Type.Object({ task_refs: TASK_REFS_SCHEMA }, { additionalProperties: false }),
    async execute(args) {
      return captureToolError("plan_mark_tasks", () => {
        const taskRefs = requiredStringArray(asRecord(args).task_refs, "task_refs");
        const result = markPlanTasksComplete(deps.dataDir, taskRefs);
        return {
          ok: true,
          tool: "plan_mark_tasks",
          plan_ref: result.document.planRef,
          completed_task_refs: result.completed,
          already_completed_task_refs: result.alreadyCompleted,
          remaining_task_refs: result.document.lint.tasks
            .filter((task) => !task.completed)
            .map((task) => task.taskRef),
        };
      });
    },
  };
}

function buildPlanVerifySpec(deps: PlanToolSpecDeps): AgentToolSpec {
  return {
    id: "plan_verify",
    tag: "plan_verify",
    title: "Plan Verify",
    description: "Host-only deterministic Plan-state verification. It never substitutes for artifact inspection, tests, or Sentinel review.",
    promptSnippet: "Use after execution results are integrated; combine its Plan-state result with real diff, QA, acceptance, and review evidence.",
    whenToUse: ["The host is deciding whether a structured Plan is ready for final artifact verification"],
    whenNotToUse: ["The caller wants proof that code behavior is correct — inspect artifacts and execute QA instead"],
    usageGuidelines: [
      "ready_for_host_verification means only that the Plan is valid and every task is marked complete.",
      "Never report actual completion from this result alone.",
    ],
    guardrails: ["Host-only and read-only."],
    parameters: Type.Object({ plan_ref: PLAN_REF_SCHEMA }, { additionalProperties: false }),
    async execute(args) {
      return captureToolError("plan_verify", () => {
        const planRef = requiredString(asRecord(args).plan_ref, "plan_ref");
        const document = readPlanMarkdown(deps.dataDir, planRef);
        const incomplete = document.lint.tasks.filter((task) => !task.completed);
        return {
          ok: true,
          tool: "plan_verify",
          plan_ref: document.planRef,
          lint_valid: document.lint.valid,
          diagnostics: document.lint.diagnostics,
          total_tasks: document.lint.tasks.length,
          completed_tasks: document.lint.tasks.length - incomplete.length,
          incomplete_task_refs: incomplete.map((task) => task.taskRef),
          lanes: document.lint.lanes.map((lane) => ({
            lane_id: lane.id,
            complete: lane.taskIds.every((taskId) => document.lint.tasks.find((task) => task.id === taskId)?.completed === true),
          })),
          ready_for_host_verification: document.lint.valid && document.lint.tasks.length > 0 && incomplete.length === 0,
          implementation_verified: false,
        };
      });
    },
  };
}

function toReadPayload(document: PlanDocument) {
  return {
    ok: true,
    tool: "plan_read",
    plan_ref: document.planRef,
    valid: document.lint.valid,
    diagnostics: document.lint.diagnostics,
    markdown: document.markdown,
    lanes: document.lint.lanes,
    tasks: document.lint.tasks,
  };
}

function captureToolError(tool: string, operation: () => unknown): unknown {
  try {
    return operation();
  } catch (error) {
    return errorResult({
      ok: false,
      tool,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function errorResult(payload: unknown): McpCallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredContent(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, "plan_ref");
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  const normalized = value.map((entry) => requiredString(entry, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return normalized;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return value === undefined ? undefined : requiredStringArray(value, "task_refs");
}
