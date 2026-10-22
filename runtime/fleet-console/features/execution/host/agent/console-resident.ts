import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AgentInput, AgentSession, AgentSessionOptions } from "@fleet-console/sdk/agent";
import { createAgentSessionHost, type AgentSessionHostDeps, type InternalSessionOptions } from "./agent-session.js";
import { hostedPluginPrefix } from "../session-host/plugin-proxy.js";

export interface ConsoleResidentSession extends AgentSession {
  steer(input: AgentInput, id: string): boolean;
  waitForTurn?(): Promise<void>;
}
export interface ConsoleResidentOptions extends InternalSessionOptions { readonly cwd: string }
export interface ConsoleResidentAgentHost {
  hasLiveSession?(key: string): boolean;
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
  });
  return {
    hasLiveSession: (key) => deps.hostedExecution?.inventory().some((session) => session.state === "live" && session.sessionKey.startsWith(hostedPluginPrefix(deps.pluginId!, key))) ?? false,
    async createSession(options) {
      const session = await host.createSession(options);
      return { ...session, steer: (input, id) => session.steer!(input, id) };
    },
    dispose: () => host.dispose(),
  };
}
