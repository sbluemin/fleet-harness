import type { ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import type { OwnedProcessRegistry } from "@fleet-console/lifecycle";

/** The stderr kept per agent CLI for the failure log: the same tail the SDK would have quoted. */
const STDERR_TAIL_BYTES = 2_048;
/** The SDK ends an agent CLI that did not leave on stdin close with these; they are not failures of the CLI. */
const EXPECTED_STOP_SIGNALS = new Set<NodeJS.Signals>(["SIGTERM", "SIGKILL", "SIGINT"]);

/**
 * The spawn port every Console SDK user gets (agent chat, Analyst, the gateway's routing model). Each agent CLI starts as
 * the leader of a registered process group, so the Console's deadline and its watcher can end it with everything it
 * started. Because the SDK no longer reads the CLI's stderr itself, the tail of a CLI that fails goes to the failure log.
 */
export function createAgentProcessSpawner(registry: OwnedProcessRegistry, recordFailure: (kind: string, error: unknown) => void): ClaudeProcessSpawner {
  return (request) => {
    const child = registry.spawn(request);
    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.once("exit", (code, signal) => {
      const failed = (code !== null && code !== 0) || (signal !== null && !EXPECTED_STOP_SIGNALS.has(signal));
      if (!failed) return;
      const how = code !== null ? `exited with code ${code}` : `was ended by ${signal}`;
      recordFailure("agent_cli_exit", new Error(`Agent CLI ${child.pid ?? "?"} ${how}${tail.trim() ? `; stderr: ${tail.trim()}` : ""}`));
    });
    return child;
  };
}
