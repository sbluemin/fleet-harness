export type PlanDiagnosticSeverity = "error" | "warning";

export interface PlanDiagnostic {
  readonly code: string;
  readonly line?: number;
  readonly message: string;
  readonly severity: PlanDiagnosticSeverity;
}

export interface PlanTask {
  readonly completed: boolean;
  readonly description: string;
  readonly id: string;
  readonly laneId: string;
  readonly line: number;
  readonly taskRef?: string;
  readonly waveId: string;
}

export interface PlanLane {
  readonly id: string;
  readonly name: string;
  readonly taskIds: readonly string[];
  readonly waveId: string;
  readonly writeSet: readonly string[];
}

export interface PlanLintResult {
  readonly diagnostics: readonly PlanDiagnostic[];
  readonly lanes: readonly PlanLane[];
  readonly tasks: readonly PlanTask[];
  readonly valid: boolean;
}

export interface ParsedPlanRef {
  readonly planId: string;
  readonly workspaceRef: string;
}

export interface ParsedTaskRef extends ParsedPlanRef {
  readonly taskId: string;
}

export interface PlanDocument {
  readonly lint: PlanLintResult;
  readonly markdown: string;
  readonly planRef: string;
}
