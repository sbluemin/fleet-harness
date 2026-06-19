import { ApiError } from "./api.js";
import type { AgentCliState, AgentCliStatus } from "./types.js";

export async function fetchAgentCliState(signal?: AbortSignal): Promise<AgentCliState> {
  const response = await fetch("/agent-cli/state", { signal });
  await assertOk(response);
  return assertAgentCliState(await response.json(), response.status);
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 사용한다.
  }
  throw new ApiError(response.status, message);
}

function assertAgentCliState(value: unknown, status: number): AgentCliState {
  const payload = value as { clis?: unknown };
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.clis)) {
    throw new ApiError(status, "Invalid agent CLI state response");
  }
  return { clis: payload.clis.map((entry) => assertAgentCliStatus(entry, status)) };
}

function assertAgentCliStatus(value: unknown, status: number): AgentCliStatus {
  const entry = value as Partial<AgentCliStatus>;
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.id !== "string" ||
    typeof entry.displayName !== "string" ||
    typeof entry.available !== "boolean" ||
    !(entry.version === null || typeof entry.version === "string")
  ) {
    throw new ApiError(status, "Invalid agent CLI status entry");
  }
  // Token Boundary 방어: 백엔드가 실수로 경로를 직렬화하면 즉시 거부한다.
  if (Object.prototype.hasOwnProperty.call(entry, "path")) {
    throw new ApiError(status, "Agent CLI status must not expose filesystem paths");
  }
  return {
    id: entry.id,
    displayName: entry.displayName,
    available: entry.available,
    version: entry.version,
  };
}
