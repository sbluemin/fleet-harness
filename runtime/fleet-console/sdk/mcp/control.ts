export type ConsoleActivity = "idle" | "running" | "awaiting" | "background" | "ended" | "unknown";
export type ConsoleActionKind = "launch" | "send" | "interrupt";
export type ConsoleCaller = { readonly kind: "operation"; readonly operationId: string } | { readonly kind: "plugin"; readonly pluginId: string };

export interface ConsoleActionInput {
  readonly kind: ConsoleActionKind;
  readonly theaterId?: string;
  readonly operationId?: string;
  readonly text?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly viewMode?: "chat" | "terminal";
}

export interface ConsoleOperationObservation {
  readonly activity: ConsoleActivity;
  readonly lifecycle: "live" | "dormant" | "unknown";
  readonly observedAt: string;
  readonly source: "host";
  readonly attention: { readonly kind: "none" | "input" | "permission" | "failure" | "unknown" };
  readonly surface: "chat" | "terminal";
  readonly supportedActions: readonly ConsoleActionKind[];
  readonly output: {
    readonly status: "available" | "unavailable";
    readonly source?: "terminal_hook" | "terminal_transcript";
    readonly text?: string;
    readonly truncated?: boolean;
    readonly revision?: number;
    readonly outcome: "unknown" | "running" | "completed" | "succeeded" | "failed" | "interrupted";
  };
}

export interface ConsoleActionReceipt {
  readonly id: string;
  readonly requestId: string;
  readonly caller: ConsoleCaller;
  readonly input: ConsoleActionInput;
  readonly status: "accepted" | "running" | "finished" | "rejected" | "failed" | "outcome_unknown";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly expectedRevision: string;
  readonly operationId?: string;
  readonly policyId?: string;
  readonly error?: string;
  readonly outcome?: "completed" | "succeeded" | "failed" | "interrupted";
  readonly delivery?: "queued" | "confirmed" | "requested";
}

export interface ConsoleAutomationInput {
  readonly name: string;
  readonly theaterId: string;
  readonly trigger: { readonly kind: "interval"; readonly minutes: number } | { readonly kind: "activity"; readonly operationId: string; readonly activity: ConsoleActivity };
  readonly action: ConsoleActionInput | { readonly kind: "briefing" };
  readonly expiresAt: string;
  readonly maxRuns: number;
}

export interface ConsoleAutomation {
  readonly id: string;
  readonly caller: ConsoleCaller;
  readonly input: ConsoleAutomationInput;
  readonly status: "active" | "paused" | "expired" | "exhausted";
  readonly runs: number;
  readonly createdAt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastError?: string;
  readonly briefing?: { readonly at: string; readonly total: number; readonly unknown: number; readonly counts: Readonly<Record<string, number>> };
}

export interface ConsoleControlState {
  readonly paused: boolean;
  readonly actions: readonly ConsoleActionReceipt[];
  readonly automations: readonly ConsoleAutomation[];
  readonly retention: { readonly actionDays: number; readonly actionLimit: number; readonly deduplication: "retained_receipts" };
}
