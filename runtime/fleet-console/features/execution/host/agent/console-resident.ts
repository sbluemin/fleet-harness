import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentInput, AgentSession } from "../../shared/agent.js";
import { createAgentSessionHost, type AgentSessionHostDeps, type InternalSessionOptions } from "./agent-session.js";

export { AGENT_RESERVED_TOOL_GROUPS, type AgentWorkspace, type WorkspaceBuiltin } from "./agent-session.js";

export interface ConsoleResidentSession extends AgentSession {
  steer(input: AgentInput, id: string): boolean;
}
/** 상주 대화는 작업 폴더 도구(Bash·Glob·Grep·Skill)와 `workspace`를 받는다 — Console 내부 소유자만 여는 능력이다. */
export interface ConsoleResidentOptions extends InternalSessionOptions { readonly cwd: string }
export interface ConsoleResidentAgentHost {
  createSession(options: ConsoleResidentOptions): Promise<ConsoleResidentSession>;
}
export type ConsoleResidentAgentDeps = AgentSessionHostDeps & { readonly resolveExecutablePath: () => Promise<string> };

/** Console 내부 전용 상주 대화. cwd는 빌리고 CLI 홈·좌표만 임시로 소유한다. */
export function createConsoleResidentAgentHost(deps: ConsoleResidentAgentDeps): ConsoleResidentAgentHost & { dispose(): Promise<void> } {
  const host = createAgentSessionHost(deps, async (options) => {
    if (!options.cwd || !path.isAbsolute(options.cwd) || options.continuation !== "conversation" || options.timeoutMs !== undefined) throw new Error("resident_options_invalid");
    const stat = await fs.lstat(options.cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("resident_cwd_invalid");
    const scratch = await fs.mkdtemp(path.join(tmpdir(), "fleet-commodore-"));
    return { cwd: options.cwd, scratch, resident: true, release: () => fs.rm(scratch, { recursive: true, force: true }) };
  }, { workspace: true });
  return {
    async createSession(options) {
      const session = await host.createSession(options);
      return { ...session, steer: (input, id) => session.steer!(input, id) };
    },
    dispose: () => host.dispose(),
  };
}
