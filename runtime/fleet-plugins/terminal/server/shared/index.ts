export type {
  TerminalLaunchContext,
  TerminalLaunchSpec,
  TerminalPtyDataDisposable,
  TerminalPtyHandle,
  TerminalSessionManager,
  TerminalSocket,
  TerminalSocketData,
  TerminalTicket,
  TerminalTicketContext,
  TerminalTitleListener,
} from "./terminal-types.js";
export { createPluginTerminalTicketRegistry, readSocketRole } from "./tickets.js";
export type { TerminalTicketRegistry, TerminalTicketRegistryDeps } from "./tickets.js";
export { createTerminalRuntime } from "./runtime.js";
export type { TerminalRuntime, TerminalLaunchResolver } from "./runtime.js";
export { createWorkspaceChangeScanner, parseGitStatusPorcelainZ } from "./workspace-scanner.js";
