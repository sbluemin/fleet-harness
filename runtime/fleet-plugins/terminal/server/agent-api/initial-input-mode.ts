import type { AgentCliId } from "@dotobokuri/fleet-admiral";

// claude 계열은 positional argv로 프롬프트를 받을 수 있으므로 argv; 그 외는 quiescence write.
const INITIAL_INPUT_MODES: Record<AgentCliId, "argv" | "write"> = {
  "claude": "argv",
  "claude-kimi": "argv",
  "claude-glm": "argv",
  "codex": "write",
};

export function resolveInitialInputMode(cliId?: string): "argv" | "write" {
  if (!cliId) return "write";
  return INITIAL_INPUT_MODES[cliId as AgentCliId] ?? "write";
}
