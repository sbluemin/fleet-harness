import type http from "node:http";

import type { GatewayQueuedToolCall } from "./api-types.js";
import type { PendingGatewayToolCall } from "./call-queue.js";

export function writeGatewayCallEvent(res: http.ServerResponse, call: PendingGatewayToolCall): void {
  const payload: GatewayQueuedToolCall = {
    callId: call.callId,
    sessionId: call.sessionId,
    toolName: call.toolName,
    args: call.args,
    createdAt: call.createdAt,
  };
  res.write(`event: tool-call\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
