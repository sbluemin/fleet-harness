/**
 * CodexAppServerConnection - Codex app-server v2 네이티브 연결 구현
 */

import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BaseConnection, type BaseConnectionOptions } from './BaseConnection.js';
import type {
  AcpPermissionOption,
  AcpPermissionRequestParams,
  AcpPermissionResponse,
} from '../types/acp.js';
import type {
  ConnectionState,
  StructuredLogEntry,
} from '../types/common.js';
import type {
  CodexAgentMessageDeltaNotification,
  CodexApprovalDecision,
  CodexCommandExecutionApprovalParams,
  CodexErrorNotification,
  CodexFileChangeApprovalParams,
  CodexInitializeResult,
  CodexItemCompletedNotification,
  CodexItemStartedNotification,
  CodexJsonValue,
  CodexMcpServerStartupStatusNotification,
  CodexMcpToolCallProgressNotification,
  CodexPermissionsApprovalParams,
  CodexPlanDeltaNotification,
  CodexReasoningSummaryTextDeltaNotification,
  CodexReasoningTextDeltaNotification,
  CodexThreadArchiveResponse,
  CodexThreadReadParams,
  CodexThreadReadResponse,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurnCompletedNotification,
  CodexTurnInterruptResponse,
  CodexTurnStartResponse,
  CodexTurnStartedNotification,
  CodexUserInput,
} from '../types/codex-app-server.js';
import {
  CODEX_METHODS,
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
} from '../types/codex-app-server.js';
import { isIntentionalKillMarked } from '../utils/process.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: object;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: object;
}

interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error?: {
    code?: number;
    message?: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingMcpReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface CodexExitDiagnostics {
  code: number | null;
  signal: string | null;
  stderrTail: string[];
  lastNotificationKind: string | null;
  pendingRequestIds: number[];
}

interface SyntheticPermissionOption {
  decision: CodexApprovalDecision;
  option: AcpPermissionOption;
}

interface SendMessageOptions {
  model?: string;
  effort?: string;
}

interface ConnectSessionOptions {
  cwd?: string;
  developerInstructions?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  config?: Record<string, CodexJsonValue>;
}

interface ResumeSessionOptions {
  cwd?: string;
  developerInstructions?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  config?: Record<string, CodexJsonValue>;
}

interface ResetSessionOptions extends ConnectSessionOptions {}

interface BaseConnectionEventMap {
  stateChange: [state: ConnectionState];
  error: [error: Error];
  exit: [code: number | null, signal: string | null];
  log: [message: string];
  logEntry: [entry: StructuredLogEntry];
}

export interface CodexAppServerConnectionOptions extends BaseConnectionOptions {
  clientInfo?: { name: string; version: string };
  autoApprove?: boolean;
  mcpServerNames?: string[];
  mcpStartupTimeout?: number;
}

export interface CodexAppServerEventMap {
  stateChange: [state: ConnectionState];
  messageChunk: [text: string, sessionId: string];
  thoughtChunk: [text: string, sessionId: string];
  userMessageChunk: [text: string, sessionId: string];
  toolCall: [title: string, status: string, sessionId: string, data?: unknown];
  toolCallUpdate: [title: string, status: string, sessionId: string, data?: unknown];
  plan: [plan: string, sessionId: string];
  mcpServerStatus: [status: CodexMcpServerStartupStatusNotification];
  promptComplete: [sessionId: string];
  permissionRequest: [
    params: AcpPermissionRequestParams,
    resolve: (response: AcpPermissionResponse | { optionId: string }) => void,
  ];
  sessionUpdate: [update: unknown];
  error: [error: Error];
  exit: [code: number | null, signal: string | null];
  log: [message: string];
  logEntry: [entry: StructuredLogEntry];
}

type CodexAppServerEvents = BaseConnectionEventMap & CodexAppServerEventMap;

const CODEX_MCP_READY_STATUS = 'ready';
const CODEX_MCP_FAILED_STATUSES = new Set(['failed', 'error']);
const DEFAULT_MCP_STARTUP_TIMEOUT = 60_000;
const STDERR_TAIL_LIMIT = 20;

/**
 * Codex app-server v2와 직접 JSON-RPC로 통신하는 연결 클래스입니다.
 */
export class CodexAppServerConnection extends BaseConnection {
  private readonly clientInfo: { name: string; version: string };
  private readonly autoApprove: boolean;
  private readonly expectedMcpServerNames: Set<string>;
  private readonly mcpStartupTimeout: number;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private pendingMcpReadyWaiters = new Set<PendingMcpReadyWaiter>();
  private stdoutBuffer = '';
  private pendingModel: string | null = null;
  private pendingEffort: string | null = null;
  private codexHome: string | null = null;
  private isDisconnecting = false;
  private lastNotificationKind: string | null = null;
  private readonly stderrTail: string[] = [];
  private agentMessagePhases = new Map<string, string>();
  private mcpServerStatuses = new Map<string, CodexMcpServerStartupStatusNotification>();

  /** 현재 활성 thread id를 session id로 취급합니다. */
  get sessionId(): string | null {
    return this.threadId;
  }

  constructor(options: CodexAppServerConnectionOptions) {
    super(options);
    this.clientInfo = options.clientInfo ?? {
      name: 'UnifiedAgent',
      version: '1.0.0',
    };
    this.autoApprove = options.autoApprove ?? false;
    this.expectedMcpServerNames = new Set(options.mcpServerNames ?? []);
    this.mcpStartupTimeout = options.mcpStartupTimeout ?? DEFAULT_MCP_STARTUP_TIMEOUT;
  }

  setPendingModel(model: string): void {
    this.pendingModel = model;
  }

  setPendingEffort(effort: string): void {
    this.pendingEffort = effort;
  }

  on<K extends keyof CodexAppServerEvents>(
    event: K,
    listener: (...args: CodexAppServerEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof CodexAppServerEvents>(
    event: K,
    listener: (...args: CodexAppServerEvents[K]) => void,
  ): this {
    return super.once(event, listener);
  }

  off<K extends keyof CodexAppServerEvents>(
    event: K,
    listener: (...args: CodexAppServerEvents[K]) => void,
  ): this {
    return super.off(event, listener);
  }

  emit<K extends keyof CodexAppServerEvents>(
    event: K,
    ...args: CodexAppServerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  async connect(
    options?: ConnectSessionOptions & { skipThreadStart?: boolean },
  ): Promise<CodexThreadStartResponse | null> {
    this.isDisconnecting = false;
    const child = this.spawnRawProcess();
    this.setupStdoutReader(child);
    this.setState('initializing');

    try {
      const initializeResult = await this.sendRequest<CodexInitializeResult>(
        CODEX_METHODS.INITIALIZE,
        {
          clientInfo: this.clientInfo,
          capabilities: {
            experimentalApi: true,
          },
        },
        this.initTimeout,
      );
      this.codexHome = initializeResult.codexHome;
      this.setState('connected');

      if (options?.skipThreadStart) {
        return null;
      }

      const response = await this.sendRequest<CodexThreadStartResponse>(
        CODEX_METHODS.THREAD_START,
        {
          cwd: options?.cwd ?? this.cwd,
          developerInstructions: options?.developerInstructions ?? null,
          model: options?.model ?? null,
          approvalPolicy: options?.approvalPolicy ?? null,
          sandbox: options?.sandbox ?? null,
          config: options?.config ?? null,
        },
      );
      this.threadId = response.thread.id;
      this.turnId = null;
      this.setState('ready');
      return response;
    } catch (error) {
      this.setState('error');
      this.isDisconnecting = true;
      await this.disconnect();
      throw error;
    }
  }

  async loadSession(
    threadId: string,
    options?: ResumeSessionOptions,
  ): Promise<CodexThreadResumeResponse> {
    let response: CodexThreadResumeResponse;
    try {
      response = await this.sendThreadResumeRequest(threadId, options);
    } catch (error) {
      const rolloutPath = this.findRolloutPathForThreadId(threadId);
      if (!rolloutPath || !isMissingRolloutError(error, threadId)) {
        throw error;
      }
      response = await this.sendThreadResumeRequest(threadId, options, rolloutPath);
    }
    this.threadId = response.thread.id;
    this.turnId = null;
    this.setState('ready');
    return response;
  }

  /** Reads existing thread metadata without resuming it or loading its turns. */
  async readThread(threadId: string): Promise<CodexThreadReadResponse> {
    return this.sendRequest<CodexThreadReadResponse>(
      CODEX_METHODS.THREAD_READ,
      {
        threadId,
        includeTurns: false,
      } satisfies CodexThreadReadParams,
    );
  }

  async sendMessage(
    input: CodexUserInput[],
    options?: SendMessageOptions,
  ): Promise<void> {
    const sessionId = this.requireThreadId();
    await this.waitForMcpServersReady();
    const echoed = input
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (echoed) {
      this.emit('userMessageChunk', echoed, sessionId);
    }

    let cleanupTurnListeners = () => {};
    const turnCompleted = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupTurnListeners();
        fn();
      };
      const onComplete = () => settle(resolve);
      const onError = (err: Error) => settle(() => reject(err));
      const onExit = (code: number | null, signal: string | null) => {
        const exitError = this.createTurnExitError(code, signal);
        const hadPendingRequests = this.pendingRequests.size > 0;
        this.rejectPendingRequests(exitError);

        if (this.shouldTreatExitAsGraceful(code)) {
          setTimeout(() => settle(resolve), 0);
          return;
        }
        if (hadPendingRequests) {
          settle(resolve);
          return;
        }

        settle(() => reject(exitError));
      };
      cleanupTurnListeners = () => {
        this.off('promptComplete', onComplete);
        this.off('error', onError);
        this.off('exit', onExit);
      };
      this.on('promptComplete', onComplete);
      this.on('error', onError);
      this.on('exit', onExit);
    });

    try {
      const response = await this.sendRequest<CodexTurnStartResponse>(
        CODEX_METHODS.TURN_START,
        {
          threadId: sessionId,
          input,
          model: options?.model ?? this.pendingModel ?? null,
          effort: options?.effort ?? this.pendingEffort ?? null,
        },
      );
      this.pendingModel = null;
      this.pendingEffort = null;
      this.turnId = response.turn.id;

      await turnCompleted;
    } finally {
      cleanupTurnListeners();
    }
  }

  async cancelPrompt(): Promise<void> {
    if (!this.threadId || !this.turnId) {
      return;
    }
    await this.sendRequest<CodexTurnInterruptResponse>(
      CODEX_METHODS.TURN_INTERRUPT,
      {
        threadId: this.threadId,
        turnId: this.turnId,
      },
    );
    this.turnId = null;
  }

  async endSession(): Promise<void> {
    const threadId = this.threadId;
    const activeTurnId = this.turnId;

    if (threadId && activeTurnId) {
      await this.sendRequest<CodexTurnInterruptResponse>(
        CODEX_METHODS.TURN_INTERRUPT,
        { threadId, turnId: activeTurnId },
      ).catch(() => {});
    }

    if (threadId) {
      await this.sendRequest<CodexThreadArchiveResponse>(
        CODEX_METHODS.THREAD_ARCHIVE,
        { threadId },
      ).catch(() => {});
    }

    this.threadId = null;
    this.turnId = null;
    if (this.child) {
      this.setState('connected');
    }
  }

  async resetSession(
    options?: ResetSessionOptions,
  ): Promise<CodexThreadStartResponse> {
    await this.endSession();
    const response = await this.sendRequest<CodexThreadStartResponse>(
      CODEX_METHODS.THREAD_START,
      {
        cwd: options?.cwd ?? this.cwd,
        developerInstructions: options?.developerInstructions ?? null,
        model: options?.model ?? null,
        approvalPolicy: options?.approvalPolicy ?? null,
        sandbox: options?.sandbox ?? null,
        config: options?.config ?? null,
      },
    );
    this.threadId = response.thread.id;
    this.turnId = null;
    this.setState('ready');
    return response;
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;
    this.threadId = null;
    this.turnId = null;
    this.rejectPendingRequests(new Error('Codex 연결이 종료되었습니다.'));
    this.rejectPendingMcpReadyWaiters(new Error('Codex 연결이 종료되었습니다.'));
    this.stdoutBuffer = '';
    this.codexHome = null;
    try {
      await super.disconnect();
    } finally {
      this.isDisconnecting = false;
    }
  }

  protected processNotification(method: string, params: unknown): void {
    this.lastNotificationKind = method;
    this.emit('sessionUpdate', { method, params });

    switch (method) {
      case CODEX_NOTIFICATIONS.AGENT_MESSAGE_DELTA: {
        const notification = params as CodexAgentMessageDeltaNotification;
        this.emit('messageChunk', notification.delta, this.requireThreadId());
        break;
      }
      case CODEX_NOTIFICATIONS.REASONING_TEXT_DELTA: {
        const notification = params as CodexReasoningTextDeltaNotification;
        this.emit('thoughtChunk', notification.delta, this.requireThreadId());
        break;
      }
      case CODEX_NOTIFICATIONS.REASONING_SUMMARY_DELTA: {
        const notification = params as CodexReasoningSummaryTextDeltaNotification;
        this.emit('thoughtChunk', notification.delta, this.requireThreadId());
        break;
      }
      case CODEX_NOTIFICATIONS.ITEM_STARTED: {
        const notification = params as CodexItemStartedNotification;
        if (notification.item.type === 'agentMessage') {
          const phase = notification.item.phase;
          if (typeof phase === 'string') {
            this.agentMessagePhases.set(notification.item.id, phase);
          }
        } else if (notification.item.type === 'mcpToolCall') {
          this.emit(
            'toolCall',
            `${notification.item.server}/${notification.item.tool}`,
            'in_progress',
            this.requireThreadId(),
            notification.item,
          );
        } else if (notification.item.type === 'commandExecution') {
          const command = typeof notification.item.command === 'string'
            ? notification.item.command
            : 'commandExecution';
          this.emit(
            'toolCall',
            command,
            'in_progress',
            this.requireThreadId(),
            notification.item,
          );
        }
        break;
      }
      case CODEX_NOTIFICATIONS.MCP_SERVER_STARTUP_STATUS_UPDATED: {
        const notification = params as CodexMcpServerStartupStatusNotification;
        this.mcpServerStatuses.set(notification.name, notification);
        this.emit('mcpServerStatus', notification);
        this.settlePendingMcpReadyWaiters();
        break;
      }
      case CODEX_NOTIFICATIONS.MCP_TOOL_CALL_PROGRESS: {
        const notification = params as CodexMcpToolCallProgressNotification;
        this.emit(
          'toolCallUpdate',
          notification.message,
          'in_progress',
          this.requireThreadId(),
        );
        break;
      }
      case CODEX_NOTIFICATIONS.ITEM_COMPLETED: {
        const notification = params as CodexItemCompletedNotification;
        if (notification.item.type === 'agentMessage') {
          this.agentMessagePhases.delete(notification.item.id);
        } else if (notification.item.type === 'mcpToolCall') {
          this.emit(
            'toolCallUpdate',
            `${notification.item.server}/${notification.item.tool}`,
            'completed',
            this.requireThreadId(),
            notification.item,
          );
        } else if (notification.item.type === 'commandExecution') {
          const command = typeof notification.item.command === 'string'
            ? notification.item.command
            : 'commandExecution';
          this.emit(
            'toolCallUpdate',
            command,
            'completed',
            this.requireThreadId(),
            notification.item,
          );
        }
        break;
      }
      case CODEX_NOTIFICATIONS.PLAN_DELTA: {
        const notification = params as CodexPlanDeltaNotification;
        this.emit('plan', notification.delta, this.requireThreadId());
        break;
      }
      case CODEX_NOTIFICATIONS.TURN_STARTED: {
        const notification = params as CodexTurnStartedNotification;
        this.turnId = notification.turn.id;
        break;
      }
      case CODEX_NOTIFICATIONS.TURN_COMPLETED: {
        const notification = params as CodexTurnCompletedNotification;
        this.turnId = null;
        if (notification.turn.status === 'failed' && notification.turn.error) {
          this.emit('error', new Error(notification.turn.error.message));
          break;
        }
        this.emit('promptComplete', this.requireThreadId());
        break;
      }
      case CODEX_NOTIFICATIONS.ERROR: {
        const notification = params as CodexErrorNotification;
        if (!notification.willRetry) {
          this.emit('error', new Error(notification.error.message));
        }
        break;
      }
      default:
        this.emit('log', `[codex-native] unhandled notification: ${method}`);
        break;
    }
  }

  protected processServerRequest(
    id: number,
    method: string,
    params: unknown,
  ): void {
    switch (method) {
      case CODEX_SERVER_REQUESTS.COMMAND_EXECUTION_APPROVAL: {
        const approval = params as CodexCommandExecutionApprovalParams;
        this.bridgeApproval(id, method, {
          toolName: 'commandExecution',
          toolInput: approval.command ?? '',
          reason: approval.reason,
          availableDecisions: approval.availableDecisions,
        });
        break;
      }
      case CODEX_SERVER_REQUESTS.FILE_CHANGE_APPROVAL: {
        const approval = params as CodexFileChangeApprovalParams;
        this.bridgeApproval(id, method, {
          toolName: 'fileChange',
          toolInput: '',
          reason: approval.reason,
          availableDecisions: null,
        });
        break;
      }
      case 'mcpServer/elicitation/request': {
        const p = params as { serverName?: string; message?: string; _meta?: { codex_approval_kind?: string } };
        if (p?._meta?.codex_approval_kind !== 'mcp_tool_call') {
          this.sendJsonRpc({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unsupported elicitation: ${p?._meta?.codex_approval_kind ?? 'unknown'}` },
          });
          break;
        }
        const elicitServer = typeof p.serverName === 'string' ? p.serverName : undefined;
        const elicitTool = typeof p.message === 'string' ? /run tool "([^"]+)"/.exec(p.message)?.[1] : undefined;
        const elicitTitle = `${elicitServer ?? 'mcp'}/${elicitTool ?? 'unknown'}`;
        const elicitParams: AcpPermissionRequestParams = {
          sessionId: this.sessionId ?? '',
          options: [
            { optionId: 'accept', name: 'accept', kind: 'allow_once' },
            { optionId: 'decline', name: 'decline', kind: 'reject_once' },
          ],
          toolCall: {
            toolCallId: `${elicitTitle}:${id}`,
            title: elicitTitle,
            kind: 'execute',
            status: 'pending',
            rawInput: {},
          },
          _meta: {
            'sbluemin/codexApproval': {
              method,
              requestedPermissions: null,
              server: elicitServer ?? null,
              tool: elicitTool ?? null,
            },
          },
        };
        if (this.autoApprove) {
          this.sendJsonRpc({ jsonrpc: '2.0', id, result: { action: 'accept' } });
          this.emit('permissionRequest', elicitParams, () => {});
          break;
        }
        this.emit('permissionRequest', elicitParams, (response) => {
          const optionId = this.extractPermissionOptionId(response);
          this.sendJsonRpc({ jsonrpc: '2.0', id, result: { action: optionId === 'accept' ? 'accept' : 'decline' } });
        });
        break;
      }
      case CODEX_SERVER_REQUESTS.MCP_TOOL_CALL_APPROVAL: {
        const approval = params as import('../types/codex-app-server.js').CodexMcpToolCallApprovalParams;
        const mcpServer = typeof approval?.server === 'string' ? approval.server : approval?.item?.server;
        const mcpTool = typeof approval?.tool === 'string' ? approval.tool : approval?.item?.tool;
        this.bridgeApproval(id, method, {
          toolName: `${mcpServer ?? 'mcp'}/${mcpTool ?? 'unknown'}`,
          toolInput: '',
          reason: approval?.reason ?? null,
          availableDecisions: approval?.availableDecisions ?? null,
          mcpServer,
          mcpTool,
        });
        break;
      }
      case CODEX_SERVER_REQUESTS.PERMISSIONS_APPROVAL: {
        const approval = params as CodexPermissionsApprovalParams;
        this.bridgeApproval(id, method, {
          toolName: 'permissions',
          toolInput: approval.reason ?? '',
          reason: approval.reason,
          availableDecisions: null,
          approvedPermissions: approval.permissions,
        });
        break;
      }
      default:
        this.sendJsonRpc({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Unsupported method: ${method}`,
          },
        });
    }
  }

  private bridgeApproval(
    jsonRpcId: number,
    method: string,
    info: {
      toolName: string;
      toolInput: string;
      reason?: string | null;
      availableDecisions?: CodexApprovalDecision[] | null;
      approvedPermissions?: unknown;
      mcpServer?: string;
      mcpTool?: string;
    },
  ): void {
    const decisions = info.availableDecisions ?? ['accept', 'decline'];
    const permissionOptions = decisions.map((decision, index) => this.toPermissionOption(decision, index));
    const decisionMap = new Map(
      permissionOptions.map(({ decision, option }) => [option.optionId, decision]),
    );

    const syntheticParams: AcpPermissionRequestParams = {
      sessionId: this.sessionId ?? '',
      options: permissionOptions.map(({ option }) => option),
      toolCall: {
        toolCallId: `${info.toolName}:${jsonRpcId}`,
        title: info.toolName,
        kind: 'execute',
        status: 'pending',
        rawInput: {
          input: info.toolInput,
          reason: info.reason ?? null,
          requestedPermissions: info.approvedPermissions ?? null,
        },
      },
      _meta: {
        'sbluemin/codexApproval': {
          method,
          requestedPermissions: info.approvedPermissions ?? null,
          server: info.mcpServer ?? null,
          tool: info.mcpTool ?? null,
        },
      },
    };

    if (this.autoApprove && permissionOptions.length > 0) {
      const autoDecision = this.selectAutoApprovalDecision(permissionOptions, decisionMap);
      this.resolveApproval(jsonRpcId, method, autoDecision, info.approvedPermissions);
      this.emit('permissionRequest', syntheticParams, () => {});
      return;
    }

    this.emit('permissionRequest', syntheticParams, (response) => {
      const optionId = this.extractPermissionOptionId(response);
      if (!optionId) {
        const fallbackDecision = this.selectCancellationDecision(decisions);
        this.resolveApproval(jsonRpcId, method, fallbackDecision, info.approvedPermissions);
        return;
      }
      const decision = decisionMap.get(optionId);
      if (!decision) {
        this.sendJsonRpc({
          jsonrpc: '2.0',
          id: jsonRpcId,
          error: {
            code: -32602,
            message: 'Invalid optionId',
          },
        });
        return;
      }

      this.resolveApproval(jsonRpcId, method, decision, info.approvedPermissions);
    });
  }

  private resolveApproval(
    jsonRpcId: number,
    method: string,
    decision: CodexApprovalDecision,
    approvedPermissions?: unknown,
  ): void {
    if (method === CODEX_SERVER_REQUESTS.PERMISSIONS_APPROVAL) {
      const permissions = this.isAcceptDecision(decision) && approvedPermissions !== undefined
        ? approvedPermissions
        : {};
      this.sendJsonRpc({
        jsonrpc: '2.0',
        id: jsonRpcId,
        result: { permissions, scope: null },
      });
      return;
    }
    this.sendJsonRpc({
      jsonrpc: '2.0',
      id: jsonRpcId,
      result: { decision },
    });
  }

  private selectAutoApprovalDecision(
    permissions: SyntheticPermissionOption[],
    decisionMap: Map<string, CodexApprovalDecision>,
  ): CodexApprovalDecision {
    for (const preferredName of ['acceptForSession', 'accept']) {
      const matchedPermission = permissions.find((permission) => permission.option.name === preferredName);
      if (!matchedPermission) {
        continue;
      }
      const matchedDecision = decisionMap.get(matchedPermission.option.optionId);
      if (matchedDecision) {
        return matchedDecision;
      }
    }

    return permissions[0]?.decision ?? 'accept';
  }

  private selectCancellationDecision(decisions: CodexApprovalDecision[]): CodexApprovalDecision {
    return decisions.find((decision) => decision === 'decline' || decision === 'cancel') ?? 'decline';
  }

  private extractPermissionOptionId(
    response: AcpPermissionResponse | { optionId: string },
  ): string | null {
    if ('optionId' in response) {
      return response.optionId;
    }
    if (response.outcome.outcome === 'selected') {
      return response.outcome.optionId;
    }
    return null;
  }

  private toPermissionOption(
    decision: CodexApprovalDecision,
    index: number,
  ): SyntheticPermissionOption {
    const name = typeof decision === 'string'
      ? decision
      : Object.keys(decision)[0] ?? `decision_${index}`;
    return {
      decision,
      option: {
        optionId: `decision_${index}`,
        name,
        kind: this.toPermissionOptionKind(name),
        _meta: {
          'sbluemin/codexApprovalDecision': decision,
        },
      },
    };
  }

  private toPermissionOptionKind(name: string): AcpPermissionOption['kind'] {
    if (name === 'acceptForSession') {
      return 'allow_always';
    }
    if (name.startsWith('accept') || name.startsWith('apply')) {
      return 'allow_once';
    }
    return 'reject_once';
  }

  private isAcceptDecision(decision: CodexApprovalDecision): boolean {
    if (typeof decision === 'string') {
      return decision === 'accept' || decision === 'acceptForSession';
    }
    return 'acceptWithExecpolicyAmendment' in decision || 'applyNetworkPolicyAmendment' in decision;
  }

  private setupStdoutReader(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.stdoutBuffer += chunk.toString();

      while (true) {
        const newlineIndex = this.stdoutBuffer.indexOf('\n');
        if (newlineIndex < 0) {
          break;
        }

        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        let message: unknown;
        try {
          message = JSON.parse(line) as unknown;
        } catch {
          this.emit('log', `[codex-native] invalid json: ${line}`);
          continue;
        }

        this.processJsonRpcMessage(message);
      }
    });
  }

  private processJsonRpcMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    const record = message as Record<string, unknown>;
    const id = typeof record.id === 'number' ? record.id : null;
    const method = typeof record.method === 'string' ? record.method : null;

    if (id != null && !method) {
      this.processResponse(record as unknown as JsonRpcSuccessResponse | JsonRpcErrorResponse);
      return;
    }

    if (id == null && method) {
      this.processNotification(method, record.params);
      return;
    }

    if (id != null && method) {
      this.processServerRequest(id, method, record.params);
    }
  }

  private processResponse(
    response: JsonRpcSuccessResponse | JsonRpcErrorResponse,
  ): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      this.emit('log', `[codex-native] unexpected response id: ${response.id}`);
      return;
    }

    this.pendingRequests.delete(response.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    if ('error' in response && response.error) {
      pending.reject(
        new Error(response.error.message ?? `JSON-RPC error (${response.id})`),
      );
      return;
    }

    pending.resolve((response as JsonRpcSuccessResponse).result);
  }

  private waitForMcpServersReady(): Promise<void> {
    if (this.expectedMcpServerNames.size === 0) {
      return Promise.resolve();
    }

    const startupError = this.getMcpStartupError();
    if (startupError) {
      return Promise.reject(startupError);
    }

    if (this.areExpectedMcpServersReady()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter: PendingMcpReadyWaiter = { resolve, reject };
      if (this.mcpStartupTimeout > 0) {
        waiter.timer = setTimeout(() => {
            this.pendingMcpReadyWaiters.delete(waiter);
            reject(new Error(
              `Codex MCP servers did not become ready within ${this.mcpStartupTimeout}ms: ${this.getPendingMcpServerNames().join(', ')}`,
            ));
          }, this.mcpStartupTimeout);
      }
      this.pendingMcpReadyWaiters.add(waiter);
      this.settlePendingMcpReadyWaiters();
    });
  }

  private areExpectedMcpServersReady(): boolean {
    return this.getPendingMcpServerNames().length === 0;
  }

  private getPendingMcpServerNames(): string[] {
    return [...this.expectedMcpServerNames].filter((name) => {
      const status = this.mcpServerStatuses.get(name)?.status;
      return status !== CODEX_MCP_READY_STATUS;
    });
  }

  private getMcpStartupError(): Error | null {
    for (const name of this.expectedMcpServerNames) {
      const status = this.mcpServerStatuses.get(name);
      if (!status || !CODEX_MCP_FAILED_STATUSES.has(status.status)) {
        continue;
      }
      const suffix = this.formatMcpStartupError(status.error);
      return new Error(`Codex MCP server '${name}' failed to start${suffix}`);
    }
    return null;
  }

  private formatMcpStartupError(error: CodexMcpServerStartupStatusNotification['error']): string {
    if (!error) {
      return '';
    }
    if (typeof error === 'string') {
      return `: ${error}`;
    }
    if (error.message) {
      return `: ${error.message}`;
    }
    return '';
  }

  private settlePendingMcpReadyWaiters(): void {
    const startupError = this.getMcpStartupError();
    if (startupError) {
      this.rejectPendingMcpReadyWaiters(startupError);
      return;
    }

    if (!this.areExpectedMcpServersReady()) {
      return;
    }

    for (const waiter of this.pendingMcpReadyWaiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve();
      this.pendingMcpReadyWaiters.delete(waiter);
    }
  }

  private rejectPendingMcpReadyWaiters(error: Error): void {
    for (const waiter of this.pendingMcpReadyWaiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(error);
      this.pendingMcpReadyWaiters.delete(waiter);
    }
  }

  private sendThreadResumeRequest(
    threadId: string,
    options?: ResumeSessionOptions,
    rolloutPath?: string,
  ): Promise<CodexThreadResumeResponse> {
    return this.sendRequest<CodexThreadResumeResponse>(
      CODEX_METHODS.THREAD_RESUME,
      {
        threadId,
        path: rolloutPath ?? null,
        cwd: options?.cwd ?? this.cwd,
        model: options?.model ?? null,
        approvalPolicy: options?.approvalPolicy ?? null,
        sandbox: options?.sandbox ?? null,
        developerInstructions: options?.developerInstructions ?? null,
        config: options?.config ?? null,
      },
    );
  }

  private findRolloutPathForThreadId(threadId: string): string | null {
    const codexHome = this.codexHome ?? this.env.CODEX_HOME ?? path.join(this.env.HOME ?? '', '.codex');
    if (!codexHome) {
      return null;
    }

    for (const rootName of ['sessions', 'archived_sessions']) {
      const found = findRolloutPath(path.join(codexHome, rootName), threadId);
      if (found) {
        return found;
      }
    }

    return null;
  }

  private sendJsonRpc(message: JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    if (!this.child?.stdin) {
      throw new Error('Codex app-server 프로세스가 준비되지 않았습니다.');
    }
    if (this.child.exitCode != null || this.child.killed) {
      throw new Error(
        `Codex app-server 프로세스가 이미 종료되었습니다. ${this.formatExitStatus(
          this.child.exitCode,
          this.child.signalCode ?? null,
        )}`,
      );
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async sendRequest<T>(
    method: string,
    params?: object,
    timeoutMs = this.requestTimeout,
  ): Promise<T> {
    const id = this.nextRequestId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const promise = new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pendingRequests.delete(id);
            reject(new Error(`Codex request timed out: ${method}`));
          }, timeoutMs)
        : undefined;
      this.pendingRequests.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      });
    });

    try {
      this.sendJsonRpc(request);
    } catch (error) {
      const pending = this.pendingRequests.get(id);
      if (pending?.timer) {
        clearTimeout(pending.timer);
      }
      this.pendingRequests.delete(id);
      throw error;
    }

    return promise;
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  protected override emitStderrLine(rawLine: string): void {
    super.emitStderrLine(rawLine);
    const message = rawLine.trim();
    if (!message) {
      return;
    }
    this.stderrTail.push(message);
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.shift();
    }
  }

  private shouldTreatExitAsGraceful(code: number | null): boolean {
    return code === 0 || this.isDisconnecting || isIntentionalKillMarked(this.child);
  }

  private createTurnExitError(code: number | null, signal: string | null): Error {
    const diagnostics = this.collectExitDiagnostics(code, signal);
    const error = new Error(
      `Codex app-server exited before turn completion (${this.formatExitStatus(code, signal)}; lastNotification=${diagnostics.lastNotificationKind ?? 'none'}; pendingRequests=${diagnostics.pendingRequestIds.join(',') || 'none'}; stderrTail=${diagnostics.stderrTail.join(' | ') || 'empty'})`,
    );
    error.name = 'CodexAppServerTurnExitError';
    return error;
  }

  private collectExitDiagnostics(
    code: number | null,
    signal: string | null,
  ): CodexExitDiagnostics {
    return {
      code,
      signal,
      stderrTail: [...this.stderrTail],
      lastNotificationKind: this.lastNotificationKind,
      pendingRequestIds: [...this.pendingRequests.keys()],
    };
  }

  private formatExitStatus(code: number | null, signal: string | null): string {
    return `code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
  }

  private requireThreadId(): string {
    if (!this.threadId) {
      throw new Error('Codex thread가 아직 준비되지 않았습니다.');
    }
    return this.threadId;
  }
}

function isMissingRolloutError(error: unknown, threadId: string): boolean {
  return error instanceof Error && error.message.includes(`no rollout found for thread id ${threadId}`);
}

function findRolloutPath(root: string, threadId: string): string | null {
  if (!fs.existsSync(root)) {
    return null;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findRolloutPath(entryPath, threadId);
      if (found) {
        return found;
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
      return entryPath;
    }
  }

  return null;
}
