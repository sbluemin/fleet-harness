import { formatTaskRef } from "./references.js";
import { extractPlanExecutionStructure } from "./lint.js";
import type { PlanDocument, PlanTask } from "./types.js";

export function buildPlanExecutionView(
  document: PlanDocument,
  selectedTasks: readonly PlanTask[],
) {
  const laneIds = new Set(selectedTasks.map((task) => task.laneId));
  if (selectedTasks.length === 0 || laneIds.size !== 1) {
    throw new Error("A compact Plan execution view requires TaskRefs from exactly one Lane");
  }
  const structure = extractPlanExecutionStructure(document.markdown);
  const laneId = selectedTasks[0]!.laneId;
  const lane = structure.lanes.find((candidate) => candidate.id === laneId);
  if (!lane) {
    throw new Error(`Assigned Lane does not exist in Plan: ${laneId}`);
  }
  const completedTasks = document.lint.tasks.filter((task) => task.completed).length;

  return {
    plan_context: {
      objective: structure.sections.objective,
      execution_topology: structure.sections.executionTopology,
      current_progress: {
        completed_tasks: completedTasks,
        total_tasks: document.lint.tasks.length,
        lanes: document.lint.lanes.map((candidate) => {
          const tasks = document.lint.tasks.filter((task) => task.laneId === candidate.id);
          return {
            lane_id: candidate.id,
            lane_name: candidate.name,
            wave_id: candidate.waveId,
            completed_tasks: tasks.filter((task) => task.completed).length,
            total_tasks: tasks.length,
            complete: tasks.length > 0 && tasks.every((task) => task.completed),
          };
        }),
      },
      qa_gates: structure.sections.qaGates,
      acceptance_criteria: structure.sections.acceptanceCriteria,
      documentation_updates: structure.sections.documentationUpdates,
      final_review_loop: structure.sections.finalReviewLoop,
    },
    lane_context: {
      lane_id: lane.id,
      lane_name: lane.name,
      wave_id: lane.waveId,
      dependency_start_conditions: lane.dependencyStartConditions,
      exact_write_set: lane.writeSet,
      read_dependencies: lane.readDependencies,
      eligible_concurrent_lane_ids: lane.eligibleConcurrentLaneIds,
      integration_gate: lane.integrationGate,
      handoff: lane.handoff,
      rollback_unit: lane.rollbackUnit,
      verification_static_checks: lane.verificationStaticChecks,
      escalation_triggers: lane.escalationTriggers,
    },
    selected_tasks: selectedTasks.map((task) => ({
      task_ref: task.taskRef ?? formatTaskRef(document.planRef, task.id),
      task_id: task.id,
      description: task.description,
      completed: task.completed,
    })),
  };
}
