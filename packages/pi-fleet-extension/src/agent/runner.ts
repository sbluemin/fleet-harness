import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadModels as getModelConfig } from "@sbluemin/fleet-core/admiral/store";
import {
  executeWithPool,
  type AgentStatus,
  type CollectedStreamData,
} from "@sbluemin/fleet-core/admiral/agent-runtime";
import type { CliType } from "@sbluemin/unified-agent";

export type UnifiedAgentRequestStatus = "done" | "error" | "aborted";

export interface UnifiedAgentToolCall {
  readonly title: string;
  readonly status: string;
}

export interface UnifiedAgentRequestOptionsBase {
  cli: CliType;
  carrierId: string;
  request: string;
  signal?: AbortSignal;
  cwd?: string;
  connectSystemPrompt?: string | null;
  onMessageChunk?: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
  onToolCall?: (
    title: string,
    status: string,
    rawOutput?: string,
    toolCallId?: string,
  ) => void;
}

export interface UnifiedAgentBackgroundRequestOptions extends UnifiedAgentRequestOptionsBase {
  cwd: string;
}

export interface UnifiedAgentResult {
  status: UnifiedAgentRequestStatus;
  responseText: string;
  sessionId?: string;
  error?: string;
  thinking?: string;
  toolCalls?: UnifiedAgentToolCall[];
  streamData?: CollectedStreamData;
}

export interface UnifiedAgentRequestOptions extends UnifiedAgentRequestOptionsBase {
  ctx: ExtensionContext;
}

export interface UnifiedAgentRequestBridge {
  requestUnifiedAgent(options: UnifiedAgentRequestOptions): Promise<UnifiedAgentResult>;
}

type RunAgentRequestOptions = UnifiedAgentRequestOptions;

export async function runAgentRequest(options: RunAgentRequestOptions): Promise<UnifiedAgentResult> {
  return executeAgentRequest(toCoreOptions(options));
}

export function exposeAgentApi(): UnifiedAgentRequestBridge {
  const bridge: UnifiedAgentRequestBridge = {
    requestUnifiedAgent: (options) =>
      runAgentRequest({
        ...options,
      }),
  };

  return bridge;
}

function toCoreOptions(options: RunAgentRequestOptions): UnifiedAgentRequestOptionsBase {
  const { ctx, cwd, ...rest } = options;
  return {
    ...rest,
    cwd: cwd ?? ctx.cwd,
  };
}

async function executeAgentRequest(
  options: UnifiedAgentRequestOptionsBase,
): Promise<UnifiedAgentResult> {
  const {
    carrierId,
    cli,
    request,
    signal,
    cwd,
    onMessageChunk,
    onThoughtChunk,
    onToolCall,
  } = options;

  try {
    const cliConfig = getModelConfig()[carrierId];
    const result = await executeWithPool({
      carrierId,
      cliType: cli,
      request,
      cwd: cwd ?? process.cwd(),
      model: cliConfig?.model,
      effort: cliConfig?.effort,
      connectSystemPrompt: options.connectSystemPrompt,
      signal,
      onMessageChunk: (text) => {
        onMessageChunk?.(text);
      },
      onThoughtChunk: (text) => {
        onThoughtChunk?.(text);
      },
      onToolCall: (title, status, rawOutput, toolCallId) => {
        onToolCall?.(title, status, rawOutput, toolCallId);
      },
    });

    const finalStatus = toFinalStatus(result.status);
    const sessionId = result.connectionInfo.sessionId;

    return {
      status: finalStatus,
      responseText: result.responseText,
      sessionId: sessionId ?? undefined,
      error: result.error,
      thinking: result.thoughtText || undefined,
      toolCalls: result.toolCalls.length > 0
        ? result.toolCalls.map((toolCall) => ({
          title: toolCall.title,
          status: toolCall.status,
        }))
        : undefined,
      streamData: result.streamData,
    };
  } catch (error) {
    throw error;
  }
}

function toFinalStatus(status: AgentStatus): UnifiedAgentRequestStatus {
  if (status === "done" || status === "aborted") {
    return status;
  }
  return "error";
}
