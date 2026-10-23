import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentHost } from "../../shared/agent.js";
import { createAgentSessionHost, type AgentSessionHostDeps } from "./agent-session.js";

export type PluginAgentDeps = AgentSessionHostDeps;

/** 플러그인 등록 단위의 비영속 실행. SDK에는 상주 세션이나 디스크 재개 권한을 내주지 않는다. */
export function createPluginAgentHost(deps: PluginAgentDeps): AgentHost & { dispose(): Promise<void> } {
  return createAgentSessionHost(deps, async () => {
    const scratch = await fs.mkdtemp(path.join(tmpdir(), "fleet-plugin-agent-"));
    return { cwd: scratch, scratch, resident: false, release: () => fs.rm(scratch, { recursive: true, force: true }) };
  });
}
