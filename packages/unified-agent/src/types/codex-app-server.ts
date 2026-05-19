/**
 * Codex app-server v2 프로토콜의 필요한 subset 타입입니다.
 * 확인된 upstream schema 필드만 포함합니다.
 */

export type CodexJsonValue =
  | null
  | boolean
  | number
  | string
  | CodexJsonValue[]
  | { [key: string]: CodexJsonValue | undefined };

export interface CodexInitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface CodexInitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexThreadStartParams {
  model?: string | null;
  approvalPolicy?: string | null;
  sandbox?: string | null;
  config?: Record<string, CodexJsonValue> | null;
  developerInstructions?: string | null;
}

export interface CodexThreadInfo {
  id: string;
}

export interface CodexThreadStartResponse {
  thread: CodexThreadInfo;
}

export interface CodexThreadResumeParams {
  threadId: string;
  path?: string | null;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: string | null;
  sandbox?: string | null;
  config?: Record<string, CodexJsonValue> | null;
  developerInstructions?: string | null;
}

export interface CodexThreadResumeResponse {
  thread: CodexThreadInfo;
}

export interface CodexThreadArchiveParams {
  threadId: string;
}

export type CodexThreadArchiveResponse = Record<string, never>;

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexUserInput[];
  model?: string | null;
  effort?: string | null;
}

export interface CodexTurnStartResponse {
  turn: {
    id: string;
  };
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type CodexTurnInterruptResponse = Record<string, never>;

export interface CodexTurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: CodexUserInput[];
}

export interface CodexTurnSteerResponse {
  turnId: string;
}

export type CodexUserInput = {
  type: 'text';
  text: string;
  text_elements: unknown[];
};

export interface CodexTurnStartedNotification {
  threadId: string;
  turn: {
    id: string;
  };
}

export interface CodexItemStartedNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

export interface CodexAgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexMcpServerStartupStatusNotification {
  name: string;
  status: string;
  error: {
    message?: string;
  } | string | null;
}

export interface CodexReasoningTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  contentIndex: number;
}

export interface CodexReasoningSummaryTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  summaryIndex: number;
}

export interface CodexPlanDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexMcpToolCallProgressNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  message: string;
}

export interface CodexItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

export interface CodexTurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    status: CodexTurnStatus;
    error: {
      message: string;
      codexErrorInfo: CodexErrorInfo | null;
      additionalDetails: string | null;
    } | null;
  };
}

export interface CodexErrorNotification {
  threadId: string;
  turnId: string;
  error: {
    message: string;
    codexErrorInfo: CodexErrorInfo | null;
    additionalDetails: string | null;
  };
  willRetry: boolean;
}

export type CodexThreadItem =
  | {
      type: 'agentMessage';
      id: string;
      text: string;
      phase: string | null;
      memoryCitation: unknown;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: unknown;
      arguments: CodexJsonValue;
      mcpAppResourceUri?: string;
      result: unknown;
      error: unknown;
      durationMs: number | null;
    }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      source: unknown;
      status: unknown;
      commandActions: unknown[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: unknown[];
      status: unknown;
    }
  | {
      type: string;
      id: string;
      [key: string]: unknown;
    };

export interface CodexCommandExecutionApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  command?: string | null;
  reason?: string | null;
  availableDecisions?: CodexApprovalDecision[] | null;
}

export interface CodexCommandExecutionApprovalResponse {
  decision: CodexApprovalDecision;
}

export interface CodexFileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
}

export interface CodexFileChangeApprovalResponse {
  decision: CodexApprovalDecision;
}

export interface CodexPermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: unknown;
}

export interface CodexPermissionsApprovalResponse {
  permissions: unknown;
  scope: unknown;
  strictAutoReview?: boolean;
}

export type CodexApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: unknown;
      };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: unknown;
      };
    };

export type CodexTurnStatus = 'completed' | 'failed' | 'interrupted' | 'inProgress';

export type CodexErrorInfo =
  | 'contextWindowExceeded'
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'cyberPolicy'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'threadRollbackFailed'
  | 'sandboxError'
  | 'other'
  | {
      httpConnectionFailed: {
        httpStatusCode: number | null;
      };
    }
  | {
      responseStreamConnectionFailed: {
        httpStatusCode: number | null;
      };
    }
  | {
      responseStreamDisconnected: {
        httpStatusCode: number | null;
      };
    }
  | {
      responseTooManyFailedAttempts: {
        httpStatusCode: number | null;
      };
    }
  | {
      activeTurnNotSteerable: {
        turnKind: unknown;
      };
    };

export const CODEX_METHODS = {
  INITIALIZE: 'initialize',
  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  THREAD_ARCHIVE: 'thread/archive',
  TURN_START: 'turn/start',
  TURN_INTERRUPT: 'turn/interrupt',
  TURN_STEER: 'turn/steer',
} as const;

export const CODEX_NOTIFICATIONS = {
  TURN_STARTED: 'turn/started',
  ITEM_STARTED: 'item/started',
  AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  REASONING_TEXT_DELTA: 'item/reasoning/textDelta',
  REASONING_SUMMARY_DELTA: 'item/reasoning/summaryTextDelta',
  PLAN_DELTA: 'plan/delta',
  MCP_SERVER_STARTUP_STATUS_UPDATED: 'mcpServer/startupStatus/updated',
  MCP_TOOL_CALL_PROGRESS: 'item/mcpToolCall/progress',
  ITEM_COMPLETED: 'item/completed',
  TURN_COMPLETED: 'turn/completed',
  ERROR: 'error',
} as const;

export const CODEX_SERVER_REQUESTS = {
  COMMAND_EXECUTION_APPROVAL: 'item/commandExecution/requestApproval',
  FILE_CHANGE_APPROVAL: 'item/fileChange/requestApproval',
  PERMISSIONS_APPROVAL: 'item/permissions/requestApproval',
} as const;
