import type { CliMessagePolicy } from "@dotobokuri/fleet-admiral";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { UpgradeHandler } from "@fleet-console/sdk/routing";

import { createShellTerminalLaunchResolver, startTerminalShell, type TerminalLaunchResolver } from "./pty.js";
import { createTerminalSessionManager } from "./session-manager.js";
import { createPluginTerminalTicketRegistry } from "./tickets.js";
import type { TerminalTicket, TerminalTicketContext, TerminalLaunchContext, TerminalLaunchSpec, TerminalTitleListener } from "./terminal-types.js";
import { createPluginTerminalUpgradeHandler } from "./ws.js";

export interface TerminalRuntime {
  readonly handleUpgrade: UpgradeHandler;
  issueTicket(context: TerminalTicketContext): TerminalTicket;
  invalidateTicketsForSession(sessionId: string): void;
  /** 제어 보유자가 바뀌었을 때 붙어 있는 소켓들이 등급을 다시 받게 한다. */
  renegotiateSockets(): void;
  canAttach(operationId: string): boolean;
  attach(context: TerminalTicketContext): Promise<void>;
  write(operationId: string, data: string): boolean;
  terminate(operationId: string): boolean;
  getMessagePolicy(operationId: string): CliMessagePolicy | undefined;
  getRenameCommand(operationId: string): string | undefined;
  getSessionLastActivityAt(operationId: string): number | null;
  resolveSessionIdentity(operationId: string, providerSessionId: string): Promise<string | null>;
  onExit(callback: (operationId: string) => void | Promise<void>): () => void;
  onTitle(operationType: string, callback: TerminalTitleListener): () => void;
  registerLaunchResolver(operationType: string, resolver: TerminalLaunchResolver): () => void;
  stop(): Promise<void>;
}

export type { TerminalLaunchResolver };

const SHELL_OPERATION_TYPE = "shell";

export function createTerminalRuntime(ctx: FleetPluginServerContext): TerminalRuntime {
  const tickets = createPluginTerminalTicketRegistry();
  const terminalExitListeners = new Set<(operationId: string) => void | Promise<void>>();
  const terminalTitleListeners = new Map<string, Set<TerminalTitleListener>>();
  const terminalLaunchResolvers = new Map<string, TerminalLaunchResolver>();
  const defaultTerminalLaunch = createShellTerminalLaunchResolver();
  terminalLaunchResolvers.set(SHELL_OPERATION_TYPE, (cwd, context) => defaultTerminalLaunch(cwd, { ...context, kind: "shell" }));
  const sessions = createTerminalSessionManager({
    launch: createRegistryAwareTerminalLaunchResolver(defaultTerminalLaunch, terminalLaunchResolvers),
    startShell: startTerminalShell,
    resolveTitleListener: (context) => {
      const operationType = context.operationType;
      if (!operationType || !terminalTitleListeners.has(operationType)) return undefined;
      return (sessionId, title) => {
        for (const listener of terminalTitleListeners.get(operationType) ?? []) listener(sessionId, title);
      };
    },
    onSessionExit: async (sessionId) => {
      await Promise.all([...terminalExitListeners].map((listener) => listener(sessionId)));
    },
  });
  const upgrade = createPluginTerminalUpgradeHandler({
    tickets,
    sessions,
    isAuthorized: ctx.host.security.isTerminalAuthorized,
  });

  return {
    handleUpgrade: upgrade.handleUpgrade,
    issueTicket: (context) => tickets.issue(context),
    renegotiateSockets: () => sessions.renegotiateSockets(),
    invalidateTicketsForSession: (sessionId) => tickets.invalidateForSession(sessionId),
    canAttach: (operationId) => sessions.canAttach(operationId),
    attach: async (context) => {
      await sessions.createSession(context);
    },
    write: (operationId, data) => sessions.writeToSession(operationId, data),
    terminate: (operationId) => sessions.terminate(operationId),
    getMessagePolicy: (operationId) => sessions.getSessionMessagePolicy(operationId),
    getRenameCommand: (operationId) => sessions.getSessionRenameCommand(operationId),
    getSessionLastActivityAt: (operationId) => sessions.getSessionLastActivityAt(operationId),
    resolveSessionIdentity: (operationId, providerSessionId) => sessions.resolveSessionIdentity(operationId, providerSessionId),
    onExit: (callback) => {
      terminalExitListeners.add(callback);
      return () => terminalExitListeners.delete(callback);
    },
    onTitle: (operationType, callback) => {
      const listeners = terminalTitleListeners.get(operationType) ?? new Set<TerminalTitleListener>();
      listeners.add(callback);
      terminalTitleListeners.set(operationType, listeners);
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) terminalTitleListeners.delete(operationType);
      };
    },
    registerLaunchResolver: (operationType, resolver) => {
      terminalLaunchResolvers.set(operationType, resolver);
      return () => {
        if (terminalLaunchResolvers.get(operationType) === resolver) terminalLaunchResolvers.delete(operationType);
      };
    },
    stop: async () => {
      upgrade.close();
      await sessions.stop();
      terminalExitListeners.clear();
      terminalTitleListeners.clear();
      terminalLaunchResolvers.clear();
    },
  };
}

function createRegistryAwareTerminalLaunchResolver(defaultResolver: TerminalLaunchResolver, resolvers: ReadonlyMap<string, TerminalLaunchResolver>): TerminalLaunchResolver {
  return async (cwd: string | undefined, context: TerminalLaunchContext | undefined): Promise<TerminalLaunchSpec> => {
    const operationType = context?.operationType;
    if (!operationType) return defaultResolver(cwd, context);
    const resolver = resolvers.get(operationType);
    if (resolver) return resolver(cwd, context);
    if (operationType === "agent") return defaultResolver(cwd, context);
    throw new Error(`terminal_launch_resolver_missing:${operationType}`);
  };
}
