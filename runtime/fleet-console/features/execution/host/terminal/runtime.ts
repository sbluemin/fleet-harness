import type { CliMessagePolicy } from "@fleet-console/agent-runtime/fleet";
import type { ConsoleRuntimeContext, RequestLifetime } from "../context.js";
import type { UpgradeHandler } from "@fleet-console/infra/http/routing";

import { createShellTerminalLaunchResolver, startTerminalShell, type TerminalLaunchResolver } from "./pty.js";
import { createTerminalSessionManager } from "./session-manager.js";
import os from "node:os";

import { createPluginTerminalTicketRegistry } from "./tickets.js";
import type { TerminalCwdListener, TerminalSessionManager, TerminalTicket, TerminalTicketContext, TerminalLaunchContext, TerminalLaunchSpec, TerminalSocket, TerminalTitleListener } from "./terminal-types.js";
import { createPluginTerminalUpgradeHandler } from "./ws.js";

export interface TerminalRuntime {
  readonly handleUpgrade: UpgradeHandler;
  issueTicket(context: TerminalTicketContext): TerminalTicket;
  invalidateTicketsForSession(sessionId: string): void;
  /** 제어 보유자가 바뀌었을 때 붙어 있는 소켓들이 등급을 다시 받게 한다. */
  renegotiateSockets(): void;
  canAttach(objectiveId: string): boolean;
  attach(context: TerminalTicketContext): Promise<void>;
  write(objectiveId: string, data: string): boolean;
  terminate(objectiveId: string): boolean;
  /** PTY를 접고 그 자식 프로세스가 실제로 끝날 때까지 기다린다. 제한 시간 안에 확인하지 못하면 false. */
  terminateAndWait(objectiveId: string, timeoutMs: number): Promise<boolean>;
  /**
   * 이 Objective 의 접은 PTY 자식이 사라질 때까지 기다린다. 남은 것이 없으면 곧바로 true, 제한 시간 안에 확인하지 못하면 false.
   * PTY 재기동은 스스로 이 관문을 지나므로, 같은 Claude 세션을 다른 표면(채팅 SDK 자식)으로 이어 쓰는 쪽이 부른다.
   */
  awaitWriterExit(objectiveId: string, timeoutMs: number): Promise<boolean>;
  getMessagePolicy(objectiveId: string): CliMessagePolicy | undefined;
  getRenameCommand(objectiveId: string): string | undefined;
  getSessionLastActivityAt(objectiveId: string): number | null;
  /** 이 세션의 PTY가 지금 살아 있는가. */
  isLive(sessionId: string): boolean;
  /** PTY 전경 프로세스 이름. 모르면 null. */
  getForegroundProcess(sessionId: string): string | null;
  /** 프롬프트 표식으로 본 셸 줄 상태(세션 매니저 `getShellLineState`). 표식을 읽지 않는 세션이면 null. */
  getShellLineState(sessionId: string): ReturnType<TerminalSessionManager["getShellLineState"]>;
  /**
   * 이 세션의 OSC 7(cwd 보고)을 받는다. 등록은 세션이 생기기 전에 해 둔다 — 파서는 PTY를 만들 때
   * 받을 곳이 있는 세션에만 붙는다. 받는 경로는 서버 안의 절대 경로다.
   */
  onCwd(sessionId: string, callback: TerminalCwdListener): () => void;
  resolveSessionIdentity(objectiveId: string, providerSessionId: string): Promise<string | null>;
  onExit(callback: (objectiveId: string) => void | Promise<void>): () => void;
  onTitle(objectiveRecordType: string, callback: TerminalTitleListener): () => void;
  registerLaunchResolver(objectiveRecordType: string, resolver: TerminalLaunchResolver): () => void;
  /**
   * 채팅 티켓이 소켓을 연 뒤 저널을 붙일 자리. 플러그인 라우트가 등록한다.
   * 등록 전 채팅 업그레이드는 소켓을 거절한다.
   */
  bindChatAttach(attach: (socket: TerminalSocket, context: TerminalTicketContext, lifetime: RequestLifetime) => void): () => void;
  stop(): Promise<void>;
}

export type { TerminalLaunchResolver };

const SHELL_OBJECTIVE_TYPE = "shell";

export function createTerminalRuntime(ctx: ConsoleRuntimeContext): TerminalRuntime {
  const tickets = createPluginTerminalTicketRegistry();
  let chatAttach: ((socket: TerminalSocket, context: TerminalTicketContext, lifetime: RequestLifetime) => void) | null = null;
  const terminalExitListeners = new Set<(objectiveId: string) => void | Promise<void>>();
  const terminalTitleListeners = new Map<string, Set<TerminalTitleListener>>();
  const terminalCwdListeners = new Map<string, Set<TerminalCwdListener>>();
  const terminalLaunchResolvers = new Map<string, TerminalLaunchResolver>();
  const defaultTerminalLaunch = createShellTerminalLaunchResolver();
  terminalLaunchResolvers.set(SHELL_OBJECTIVE_TYPE, (cwd, context) => defaultTerminalLaunch(cwd, { ...context, kind: "shell" }));
  const sessions = createTerminalSessionManager({
    launch: createRegistryAwareTerminalLaunchResolver(defaultTerminalLaunch, terminalLaunchResolvers),
    startShell: startTerminalShell,
    resolveTitleListener: (context) => {
      const objectiveRecordType = context.objectiveRecordType;
      if (!objectiveRecordType || !terminalTitleListeners.has(objectiveRecordType)) return undefined;
      return (sessionId, title) => {
        for (const listener of terminalTitleListeners.get(objectiveRecordType) ?? []) listener(sessionId, title);
      };
    },
    resolveCwdListener: (context) => {
      if (!terminalCwdListeners.has(context.sessionId)) return undefined;
      return (sessionId, cwd) => {
        for (const listener of terminalCwdListeners.get(sessionId) ?? []) listener(sessionId, cwd);
      };
    },
    localHostnames: readLocalHostnames(),
    onFailure: ctx.recordFailure,
    onSessionExit: async (sessionId) => {
      await Promise.all([...terminalExitListeners].map((listener) => listener(sessionId)));
    },
  });
  const upgrade = createPluginTerminalUpgradeHandler({
    tickets,
    sessions,
    isAuthorized: ctx.host.security.isTerminalAuthorized,
    ...(ctx.host.requestLifetime ? { requestLifetime: ctx.host.requestLifetime } : {}),
    attachChat: (socket, context, lifetime) => {
      if (!chatAttach) {
        socket.close(1013, "chat_unavailable");
        return;
      }
      chatAttach(socket, context, lifetime);
    },
  });

  return {
    handleUpgrade: upgrade.handleUpgrade,
    issueTicket: (context) => tickets.issue(context),
    renegotiateSockets: () => sessions.renegotiateSockets(),
    invalidateTicketsForSession: (sessionId) => tickets.invalidateForSession(sessionId),
    canAttach: (objectiveId) => sessions.canAttach(objectiveId),
    attach: async (context) => {
      await sessions.createSession(context);
    },
    write: (objectiveId, data) => sessions.writeToSession(objectiveId, data),
    terminate: (objectiveId) => sessions.terminate(objectiveId),
    terminateAndWait: (objectiveId, timeoutMs) => sessions.terminateAndWait(objectiveId, timeoutMs),
    awaitWriterExit: (objectiveId, timeoutMs) => sessions.awaitWriterExit(objectiveId, timeoutMs),
    getMessagePolicy: (objectiveId) => sessions.getSessionMessagePolicy(objectiveId),
    getRenameCommand: (objectiveId) => sessions.getSessionRenameCommand(objectiveId),
    getSessionLastActivityAt: (objectiveId) => sessions.getSessionLastActivityAt(objectiveId),
    isLive: (sessionId) => sessions.hasSession(sessionId),
    getForegroundProcess: (sessionId) => sessions.getForegroundProcess(sessionId),
    getShellLineState: (sessionId) => sessions.getShellLineState(sessionId),
    onCwd: (sessionId, callback) => {
      const listeners = terminalCwdListeners.get(sessionId) ?? new Set<TerminalCwdListener>();
      listeners.add(callback);
      terminalCwdListeners.set(sessionId, listeners);
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) terminalCwdListeners.delete(sessionId);
      };
    },
    resolveSessionIdentity: (objectiveId, providerSessionId) => sessions.resolveSessionIdentity(objectiveId, providerSessionId),
    onExit: (callback) => {
      terminalExitListeners.add(callback);
      return () => terminalExitListeners.delete(callback);
    },
    onTitle: (objectiveRecordType, callback) => {
      const listeners = terminalTitleListeners.get(objectiveRecordType) ?? new Set<TerminalTitleListener>();
      listeners.add(callback);
      terminalTitleListeners.set(objectiveRecordType, listeners);
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) terminalTitleListeners.delete(objectiveRecordType);
      };
    },
    registerLaunchResolver: (objectiveRecordType, resolver) => {
      terminalLaunchResolvers.set(objectiveRecordType, resolver);
      return () => {
        if (terminalLaunchResolvers.get(objectiveRecordType) === resolver) terminalLaunchResolvers.delete(objectiveRecordType);
      };
    },
    bindChatAttach: (attach) => {
      chatAttach = attach;
      return () => {
        if (chatAttach === attach) chatAttach = null;
      };
    },
    stop: async () => {
      chatAttach = null;
      upgrade.close();
      await sessions.stop();
      terminalExitListeners.clear();
      terminalTitleListeners.clear();
      terminalCwdListeners.clear();
      terminalLaunchResolvers.clear();
    },
  };
}

function createRegistryAwareTerminalLaunchResolver(defaultResolver: TerminalLaunchResolver, resolvers: ReadonlyMap<string, TerminalLaunchResolver>): TerminalLaunchResolver {
  return async (cwd: string | undefined, context: TerminalLaunchContext | undefined): Promise<TerminalLaunchSpec> => {
    const objectiveRecordType = context?.objectiveRecordType;
    if (!objectiveRecordType) return defaultResolver(cwd, context);
    const resolver = resolvers.get(objectiveRecordType);
    if (resolver) return resolver(cwd, context);
    if (objectiveRecordType === "agent") return defaultResolver(cwd, context);
    throw new Error(`terminal_launch_resolver_missing:${objectiveRecordType}`);
  };
}

/** OSC 7의 호스트 부분이 이 기계를 가리킬 수 있는 이름들 — 전체 이름과 첫 마디(`.local` 등을 뗀 것). */
function readLocalHostnames(): readonly string[] {
  try {
    const full = os.hostname();
    const short = full.split(".")[0] ?? full;
    return full === short ? [full] : [full, short];
  } catch {
    return [];
  }
}
