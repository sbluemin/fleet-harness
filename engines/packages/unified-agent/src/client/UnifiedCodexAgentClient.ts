import { EventEmitter } from 'events';
import type { McpServer, PromptResponse } from '@agentclientprotocol/sdk';

import type {
  AgentMode,
  CliDetectionResult,
  McpServerConfig,
  UnifiedClientOptions,
} from '../types/config.js';
import type {
  AcpAvailableCommand,
  AcpContentBlock,
  AcpFileReadParams,
  AcpFileReadResponse,
  AcpFileWriteParams,
  AcpFileWriteResponse,
  AcpPermissionRequestParams,
  AcpPermissionResponse,
  AcpSessionNewResult,
  AcpSessionUpdateParams,
  AcpToolCall,
  AcpToolCallUpdate,
} from '../types/acp.js';
import type { CodexJsonValue, CodexUserInput } from '../types/codex-app-server.js';
import type { ConnectionState, StructuredLogEntry } from '../types/common.js';
import type {
  ConnectResult,
  ConnectionInfo,
  IUnifiedAgentClient,
  UnifiedClientEvents,
} from './IUnifiedAgentClient.js';
import { AcpConnection } from '../connection/AcpConnection.js';
import { CodexAppServerConnection } from '../connection/CodexAppServerConnection.js';
import { CliDetector } from '../detector/CliDetector.js';
import {
  buildCodexDeveloperInstructionConfig,
  buildConfigOverrideArgs,
  createSpawnConfig,
  getBackendConfig,
  getYoloModeId,
  mcpServerConfigsToAcp,
  mcpServerConfigsToCodexArgs,
} from '../config/CliConfigs.js';
import { cleanEnvironment } from '../utils/env.js';
import { getProviderModels } from '../models/ModelRegistry.js';
import type { ProviderModelInfo } from '../models/schemas.js';

interface CodexPendingOverrides {
  model?: string;
  mode?: string;
  turnConfig: Record<string, string>;
  threadConfig: Record<string, string>;
}

interface CodexModeMapping {
  approvalPolicy: string;
  sandbox: string;
}

interface CodexThreadDefaultsForReset {
  cwd: string;
  approvalPolicy?: string;
  sandbox?: string;
  developerInstructions?: string;
  config?: Record<string, CodexJsonValue>;
}

interface CodexThreadDefaultsForResume {
  cwd: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  developerInstructions?: string;
  config?: Record<string, CodexJsonValue>;
}

const CODEX_TURN_LEVEL_CONFIG_KEYS = new Set(['effort', 'model']);
const CODEX_THREAD_POLICY_CONFIG_KEYS = new Set(['approvalPolicy', 'sandbox']);
const CODEX_USE_ACP = true;

type CodexConnection = CodexAppServerConnection | AcpConnection;

/**
 * Codex app-server 전용 내부 클라이언트.
 * Codex 특수화는 이 클래스가 담당합니다.
 */
export class UnifiedCodexAgentClient extends EventEmitter implements IUnifiedAgentClient {
  private connection: CodexConnection | null = null;
  private sessionId: string | null = null;
  private sessionCwd: string | null = null;
  private currentSystemPrompt: string | null = null;
  private pendingOverrides: CodexPendingOverrides | null = null;
  private detector = new CliDetector();

  on<K extends keyof UnifiedClientEvents>(
    event: K,
    listener: (...args: UnifiedClientEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof UnifiedClientEvents>(
    event: K,
    listener: (...args: UnifiedClientEvents[K]) => void,
  ): this {
    return super.once(event, listener);
  }

  off<K extends keyof UnifiedClientEvents>(
    event: K,
    listener: (...args: UnifiedClientEvents[K]) => void,
  ): this {
    return super.off(event, listener);
  }

  private emitTyped<K extends keyof UnifiedClientEvents>(
    event: K,
    ...args: UnifiedClientEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  async connect(options: UnifiedClientOptions): Promise<ConnectResult> {
    await this.disconnect();
    if (options.cli && options.cli !== 'codex') {
      throw new Error('UnifiedCodexAgentClient는 codex CLI만 지원합니다.');
    }

    if (CODEX_USE_ACP) {
      return this.connectAcp(options);
    }

    return this.connectAppServer(options);
  }

  private async connectAppServer(options: UnifiedClientOptions): Promise<ConnectResult> {
    const backend = getBackendConfig('codex');
    const cleanEnv = cleanEnvironment(process.env, options.env);
    const command = options.cliPath ?? backend.cliCommand;
    const baseArgs = backend.appServerArgs ?? ['app-server', '--listen', 'stdio://'];
    const developerInstructions = options.systemPrompt ?? null;
    const modeMapping = this.resolveMode(options.yoloMode === false ? 'default' : 'yolo');
    const args = [
      ...baseArgs,
      ...this.buildStartupConfigArgs(options.configOverrides, options.mcpServers, modeMapping),
    ];
    const mcpServerNames = this.resolveMcpServerNames(options.configOverrides, options.mcpServers);
    const connection = new CodexAppServerConnection({
      command,
      args,
      cwd: options.cwd,
      env: cleanEnv,
      requestTimeout: options.timeout ?? 600_000,
      initTimeout: options.timeout ?? 60_000,
      promptIdleTimeout: options.promptIdleTimeout ?? 600_000,
      clientInfo: options.clientInfo,
      autoApprove: options.autoApprove,
      mcpServerNames,
      mcpStartupTimeout: options.timeout ?? 60_000,
    });
    this.connection = connection;
    this.setupEventForwarding();

    if (options.sessionId) {
      await connection.connect({
        skipThreadStart: true,
        model: options.model,
      });
      await connection.loadSession(
        options.sessionId,
        this.buildCodexThreadDefaultsForResume(
          options.cwd,
          options.model,
          developerInstructions,
          modeMapping,
        ),
      );
    } else {
      await connection.connect({
        developerInstructions: developerInstructions ?? undefined,
        model: options.model,
        approvalPolicy: modeMapping.approvalPolicy,
        sandbox: modeMapping.sandbox,
      });
    }

    this.sessionId = connection.sessionId;
    this.sessionCwd = options.cwd;
    this.currentSystemPrompt = developerInstructions;
    this.pendingOverrides = {
      turnConfig: {},
      threadConfig: {
        approvalPolicy: modeMapping.approvalPolicy,
        sandbox: modeMapping.sandbox,
      },
    };

    return {
      cli: 'codex',
      protocol: 'codex-app-server',
    };
  }

  private async connectAcp(options: UnifiedClientOptions): Promise<ConnectResult> {
    const cleanEnv = cleanEnvironment(process.env, options.env);
    const spawnConfig = createSpawnConfig('codex', options);
    const developerInstructions = options.systemPrompt ?? null;
    const args = [
      ...spawnConfig.args,
      ...this.buildStartupConfigArgs(
        options.configOverrides,
        undefined,
        undefined,
        developerInstructions,
      ),
    ];
    const connection = new AcpConnection({
      command: spawnConfig.command,
      args,
      cliType: 'codex',
      cwd: options.cwd,
      env: { ...cleanEnv },
      requestTimeout: options.timeout ?? 600_000,
      initTimeout: options.timeout ?? 60_000,
      promptIdleTimeout: options.promptIdleTimeout ?? 600_000,
      clientInfo: options.clientInfo,
      autoApprove: options.autoApprove,
    });
    this.connection = connection;
    this.setupEventForwarding();

    const recentLogs: string[] = [];
    const collectLog = (message: string): void => {
      recentLogs.push(message);
      if (recentLogs.length > 30) {
        recentLogs.shift();
      }
    };
    connection.on('log', collectLog);

    let session: AcpSessionNewResult;
    try {
      session = await connection.connect(
        options.cwd,
        options.sessionId,
        this.resolveAcpMcpServers(options.mcpServers),
      );
    } catch (error) {
      const connectionError = this.buildConnectionError(error, recentLogs);
      await this.cleanupFailedConnection();
      throw connectionError;
    } finally {
      connection.off('log', collectLog);
    }

    await this.finalizeAcpConnect(options, session);

    return {
      cli: 'codex',
      protocol: 'acp',
      session,
    };
  }

  async disconnect(): Promise<void> {
    if (!this.connection) {
      this.clearSessionState();
      return;
    }

    const conn = this.connection;
    if (this.sessionId && conn instanceof AcpConnection && conn.canResetSession) {
      try {
        await conn.endSession(this.sessionId);
      } catch {
        // 세션 close 실패는 프로세스 종료를 막지 않습니다.
      }
    }
    await conn.disconnect();
    conn.removeAllListeners();
    this.connection = null;
    this.clearSessionState();
  }

  async endSession(): Promise<void> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    if (this.connection instanceof AcpConnection) {
      if (!this.sessionId) {
        throw new Error('연결되어 있지 않습니다');
      }
      await this.connection.endSession(this.sessionId);
    } else {
      await this.connection.endSession();
    }
    this.sessionId = null;
    this.sessionCwd = null;
  }

  getConnectionInfo(): ConnectionInfo {
    if (!this.connection) {
      return {
        cli: null,
        protocol: null,
        sessionId: null,
        state: 'disconnected',
      };
    }

    return {
      cli: 'codex',
      protocol: this.connection instanceof AcpConnection ? 'acp' : 'codex-app-server',
      sessionId: this.sessionId,
      state: this.connection.connectionState,
    };
  }

  async detectClis(): Promise<CliDetectionResult[]> {
    return this.detector.detectAll(true);
  }

  async sendMessage(content: string | AcpContentBlock[]): Promise<PromptResponse> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    if (this.connection instanceof AcpConnection) {
      if (!this.sessionId) {
        throw new Error('연결되어 있지 않습니다');
      }
      return this.connection.sendPrompt(this.sessionId, content);
    }

    this.applyPendingOverrides();
    const input: CodexUserInput[] = typeof content === 'string'
      ? [{ type: 'text', text: content, text_elements: [] }]
      : content.map((block) => ('text' in block
        ? { type: 'text' as const, text: block.text, text_elements: [] }
        : { type: 'text' as const, text: JSON.stringify(block), text_elements: [] }));
    await this.connection.sendMessage(input);
    return { stopReason: 'end_turn' } as PromptResponse;
  }

  async cancelPrompt(): Promise<void> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    if (this.connection instanceof AcpConnection) {
      if (!this.sessionId) {
        throw new Error('연결되어 있지 않습니다');
      }
      await this.connection.cancelSession(this.sessionId);
      return;
    }

    await this.connection.cancelPrompt();
  }

  async setModel(model: string): Promise<void> {
    if (this.connection instanceof AcpConnection && this.sessionId) {
      await this.connection.setModel(this.sessionId, model);
      return;
    }

    this.ensurePendingOverrides().model = model;
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (this.connection instanceof AcpConnection && this.sessionId) {
      if (configId === 'model') {
        await this.connection.setModel(this.sessionId, value);
        return;
      }

      await this.connection.setConfigOption(
        this.sessionId,
        configId === 'effort' ? 'reasoning_effort' : configId,
        value,
      );
      return;
    }

    const pending = this.ensurePendingOverrides();
    if (CODEX_TURN_LEVEL_CONFIG_KEYS.has(configId)) {
      pending.turnConfig[configId] = value;
      return;
    }

    pending.threadConfig[configId] = value;
    this.emitTyped('log', `[codex] config '${configId}' will apply on next thread/start or thread/resume`);
  }

  async setMode(mode: string): Promise<void> {
    if (this.connection instanceof AcpConnection && this.sessionId) {
      await this.connection.setMode(this.sessionId, this.resolveAcpMode(mode));
      return;
    }

    const resolved = this.resolveMode(mode);
    const pending = this.ensurePendingOverrides();
    pending.threadConfig.approvalPolicy = resolved.approvalPolicy;
    pending.threadConfig.sandbox = resolved.sandbox;
    pending.mode = undefined;
  }

  async setYoloMode(enabled: boolean): Promise<void> {
    return this.setMode(enabled ? getYoloModeId('codex') : 'default');
  }

  getAvailableModes(): AgentMode[] {
    return getBackendConfig('codex').modes ?? [];
  }

  getAvailableModels(): ProviderModelInfo | null {
    return getProviderModels('codex');
  }

  getCurrentSystemPrompt(): string | null {
    return this.currentSystemPrompt;
  }

  async loadSession(sessionId: string, mcpServers?: McpServerConfig[]): Promise<void> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    if (this.connection instanceof AcpConnection) {
      await this.connection.loadSession({
        sessionId,
        cwd: this.sessionCwd ?? process.cwd(),
        mcpServers: this.resolveAcpMcpServers(mcpServers),
      });
      this.sessionId = sessionId;
      return;
    }

    if (mcpServers?.length) {
      this.emitTyped(
        'log',
        '[codex] mcpServers on loadSession are ignored; pass them to connect() so app-server starts with -c overrides',
      );
    }
    const targetCwd = this.sessionCwd ?? process.cwd();
    await this.connection.loadSession(
      sessionId,
      this.buildCodexThreadDefaultsForResume(
        targetCwd,
        undefined,
        this.currentSystemPrompt,
        this.pendingOverrides?.threadConfig ?? {},
      ),
    );
    this.sessionId = sessionId;
  }

  async resetSession(cwd?: string): Promise<ConnectResult> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    const targetCwd = cwd ?? this.sessionCwd ?? process.cwd();
    if (this.connection instanceof AcpConnection) {
      if (!this.sessionId) {
        throw new Error('연결되어 있지 않습니다');
      }
      if (!this.connection.canResetSession) {
        throw new Error('[codex] 세션 리셋을 지원하지 않습니다. disconnect() 후 재연결하세요.');
      }

      await this.connection.endSession(this.sessionId);
      const session = await this.connection.reconnectSession(targetCwd);
      this.sessionId = session.sessionId;
      this.sessionCwd = targetCwd;

      return {
        cli: 'codex',
        protocol: 'acp',
        session,
      };
    }

    const result = await this.connection.resetSession(
      this.buildCodexThreadDefaultsForReset(targetCwd),
    );
    this.sessionId = result.thread.id;
    this.sessionCwd = targetCwd;
    this.pendingOverrides = {
      turnConfig: {},
      threadConfig: this.pendingOverrides?.threadConfig ?? {},
    };
    return {
      cli: 'codex',
      protocol: 'codex-app-server',
    };
  }

  private resolveAcpMcpServers(servers?: McpServerConfig[]): McpServer[] {
    return servers?.length ? mcpServerConfigsToAcp(servers) : [];
  }

  private async finalizeAcpConnect(
    options: UnifiedClientOptions,
    session: AcpSessionNewResult,
  ): Promise<void> {
    this.sessionId = session.sessionId;
    this.sessionCwd = options.cwd;
    this.currentSystemPrompt = options.systemPrompt ?? null;
    this.pendingOverrides = {
      turnConfig: {},
      threadConfig: {},
    };

    const mode = options.yoloMode === false ? 'default' : 'yolo';
    await this.setMode(mode);

    if (options.model) {
      await this.setModel(options.model);
    }

    if (options.effort) {
      await this.setConfigOption('effort', options.effort);
    }
  }

  private clearSessionState(): void {
    this.sessionId = null;
    this.sessionCwd = null;
    this.currentSystemPrompt = null;
    this.pendingOverrides = null;
  }

  private setupEventForwarding(): void {
    if (!this.connection) return;

    const connection = this.connection;

    if (connection instanceof AcpConnection) {
      this.setupAcpEventForwarding(connection);
      return;
    }

    this.setupAppServerEventForwarding(connection);
  }

  private setupAcpEventForwarding(connection: AcpConnection): void {
    connection.on('stateChange', (state: ConnectionState) => {
      this.emitTyped('stateChange', state);
    });
    connection.on('userMessageChunk', (text: string, sessionId: string) => {
      this.emitTyped('userMessageChunk', text, sessionId);
    });
    connection.on('messageChunk', (text: string, sessionId: string) => {
      this.emitTyped('messageChunk', text, sessionId);
    });
    connection.on('thoughtChunk', (text: string, sessionId: string) => {
      this.emitTyped('thoughtChunk', text, sessionId);
    });
    connection.on('toolCall', (title: string, status: string, sessionId: string, data?: unknown) => {
      this.emitTyped('toolCall', title, status, sessionId, data as AcpToolCall | undefined);
    });
    connection.on('toolCallUpdate', (title: string, status: string, sessionId: string, data?: unknown) => {
      this.emitTyped('toolCallUpdate', title, status, sessionId, data as AcpToolCallUpdate | undefined);
    });
    connection.on('plan', (plan: string, sessionId: string) => {
      this.emitTyped('plan', plan, sessionId);
    });
    connection.on('availableCommandsUpdate', (commands: AcpAvailableCommand[], sessionId: string) => {
      this.emitTyped('availableCommandsUpdate', commands, sessionId);
    });
    connection.on('promptComplete', (sessionId: string) => {
      this.emitTyped('promptComplete', sessionId);
    });
    connection.on('permissionRequest', (params: AcpPermissionRequestParams, resolve: (response: AcpPermissionResponse) => void) => {
      this.emitTyped(
        'permissionRequest',
        params,
        resolve,
      );
    });
    connection.on('sessionUpdate', (update: AcpSessionUpdateParams) => {
      this.emitTyped('sessionUpdate', update);
    });
    connection.on('fileRead', (params: AcpFileReadParams, resolve: (response: AcpFileReadResponse) => void) => {
      this.emitTyped('fileRead', params, resolve);
    });
    connection.on('fileWrite', (params: AcpFileWriteParams, resolve: (response: AcpFileWriteResponse) => void) => {
      this.emitTyped('fileWrite', params, resolve);
    });
    connection.on('error', (err: Error) => {
      this.emitTyped('error', err);
    });
    connection.on('exit', (code: number | null, signal: string | null) => {
      this.emitTyped('exit', code, signal);
    });
    connection.on('log', (msg: string) => {
      this.emitTyped('log', msg);
    });
    connection.on('logEntry', (entry: StructuredLogEntry) => {
      this.emitTyped('logEntry', entry);
    });
  }

  private setupAppServerEventForwarding(connection: CodexAppServerConnection): void {
    connection.on('stateChange', (state: ConnectionState) => {
      this.emitTyped('stateChange', state);
    });
    connection.on('userMessageChunk', (text: string, sessionId: string) => {
      this.emitTyped('userMessageChunk', text, sessionId);
    });
    connection.on('messageChunk', (text: string, sessionId: string) => {
      this.emitTyped('messageChunk', text, sessionId);
    });
    connection.on('thoughtChunk', (text: string, sessionId: string) => {
      this.emitTyped('thoughtChunk', text, sessionId);
    });
    connection.on('toolCall', (title: string, status: string, sessionId: string, data?: unknown) => {
      this.emitTyped('toolCall', title, status, sessionId, data as AcpToolCall | undefined);
    });
    connection.on('toolCallUpdate', (title: string, status: string, sessionId: string, data?: unknown) => {
      this.emitTyped('toolCallUpdate', title, status, sessionId, data as AcpToolCallUpdate | undefined);
    });
    connection.on('plan', (plan: string, sessionId: string) => {
      this.emitTyped('plan', plan, sessionId);
    });
    connection.on('promptComplete', (sessionId: string) => {
      this.emitTyped('promptComplete', sessionId);
    });
    connection.on('permissionRequest', (params, resolve) => {
      this.emitTyped(
        'permissionRequest',
        params as AcpPermissionRequestParams,
        resolve as (response: AcpPermissionResponse) => void,
      );
    });
    connection.on('sessionUpdate', (update: unknown) => {
      this.emitTyped('sessionUpdate', update as AcpSessionUpdateParams);
    });
    connection.on('error', (err: Error) => {
      this.emitTyped('error', err);
    });
    connection.on('exit', (code: number | null, signal: string | null) => {
      this.emitTyped('exit', code, signal);
    });
    connection.on('log', (msg: string) => {
      this.emitTyped('log', msg);
    });
    connection.on('logEntry', (entry: StructuredLogEntry) => {
      this.emitTyped('logEntry', entry);
    });
  }

  private ensurePendingOverrides(): CodexPendingOverrides {
    if (!this.pendingOverrides) {
      this.pendingOverrides = {
        turnConfig: {},
        threadConfig: {},
      };
    }
    return this.pendingOverrides;
  }

  private applyPendingOverrides(): void {
    if (!this.pendingOverrides || !this.connection) {
      return;
    }

    if (this.connection instanceof AcpConnection) {
      return;
    }

    if (this.pendingOverrides.model) {
      this.connection.setPendingModel(this.pendingOverrides.model);
      this.pendingOverrides.model = undefined;
    }

    if (this.pendingOverrides.turnConfig.model) {
      this.connection.setPendingModel(this.pendingOverrides.turnConfig.model);
      delete this.pendingOverrides.turnConfig.model;
    }

    if (this.pendingOverrides.turnConfig.effort) {
      this.connection.setPendingEffort(this.pendingOverrides.turnConfig.effort);
      delete this.pendingOverrides.turnConfig.effort;
    }

  }

  private buildCodexThreadDefaultsForReset(cwd: string): CodexThreadDefaultsForReset {
    const threadConfig = this.pendingOverrides?.threadConfig ?? {};
    const { approvalPolicy, sandbox } = threadConfig;
    const configEntries = Object.entries(threadConfig)
      .filter(([key]) => !CODEX_THREAD_POLICY_CONFIG_KEYS.has(key));
    const config = configEntries.length > 0
      ? Object.fromEntries(configEntries) as Record<string, CodexJsonValue>
      : undefined;

    return {
      cwd,
      approvalPolicy,
      sandbox,
      developerInstructions: this.currentSystemPrompt ?? undefined,
      config,
    };
  }

  private buildCodexThreadDefaultsForResume(
    cwd: string,
    model: string | undefined,
    systemPrompt: string | null,
    threadConfig: Partial<CodexModeMapping> | Record<string, string>,
  ): CodexThreadDefaultsForResume {
    const { approvalPolicy, sandbox } = threadConfig;
    const configEntries = Object.entries(threadConfig)
      .filter(([key]) => !CODEX_THREAD_POLICY_CONFIG_KEYS.has(key));
    const config = configEntries.length > 0
      ? Object.fromEntries(configEntries) as Record<string, CodexJsonValue>
      : undefined;

    return {
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy,
      sandbox,
      developerInstructions: systemPrompt ?? undefined,
      config,
    };
  }

  private resolveMode(modeId: string): CodexModeMapping {
    switch (modeId) {
      case 'autoEdit':
        return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
      case 'yolo':
        return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
      default:
        return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    }
  }

  private resolveAcpMode(modeId: string): string {
    switch (modeId) {
      case 'autoEdit':
        return 'auto';
      case 'yolo':
        return 'full-access';
      default:
        return 'read-only';
    }
  }

  private buildStartupConfigArgs(
    overrides?: string[],
    servers?: McpServerConfig[],
    modeMapping?: CodexModeMapping,
    developerInstructions?: string | null,
  ): string[] {
    const configArgs = [
      ...buildCodexDeveloperInstructionConfig(developerInstructions),
      ...(modeMapping ? [
        `approval_policy="${modeMapping.approvalPolicy}"`,
        `sandbox_mode="${modeMapping.sandbox}"`,
      ] : []),
      ...(overrides ?? []),
      ...(servers?.length ? mcpServerConfigsToCodexArgs(servers) : []),
    ];

    return buildConfigOverrideArgs(configArgs);
  }

  private resolveMcpServerNames(
    overrides?: string[],
    servers?: McpServerConfig[],
  ): string[] {
    const names = new Set<string>();
    for (const server of servers ?? []) {
      names.add(server.name);
    }
    for (const override of overrides ?? []) {
      const match = /^mcp_servers\.([^.]+)\./.exec(override);
      if (match) {
        names.add(match[1]);
      }
    }
    return [...names];
  }

  private async cleanupFailedConnection(): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      await this.connection.disconnect();
    } catch {
    }

    this.connection.removeAllListeners();
    this.connection = null;
    this.clearSessionState();
  }

  private buildConnectionError(error: unknown, recentLogs: string[]): Error {
    if (getBackendConfig('codex').authRequired && this.isAuthenticationError(error, recentLogs)) {
      return new Error(
        '[codex] 인증이 필요하거나 인증이 만료되었습니다. 먼저 해당 CLI에서 로그인/인증을 완료한 뒤 다시 시도해주세요.',
      );
    }

    if (error instanceof Error) {
      return error;
    }

    if (typeof error === 'object' && error !== null) {
      const obj = error as Record<string, unknown>;
      if (typeof obj.message === 'string') {
        const code = typeof obj.code === 'number' ? ` (code: ${obj.code})` : '';
        const data = obj.data ? ` — ${JSON.stringify(obj.data)}` : '';
        return new Error(`${obj.message}${code}${data}`);
      }
      return new Error(JSON.stringify(error));
    }

    return new Error(String(error));
  }

  private isAuthenticationError(error: unknown, recentLogs: string[]): boolean {
    const authPatterns = [
      /auth_required/i,
      /authentication required/i,
      /not authenticated/i,
      /please login/i,
      /please log in/i,
      /sign in/i,
      /reauth/i,
      /unauthorized/i,
      /invalid api key/i,
    ];

    if (this.matchAnyPattern(this.extractErrorText(error), authPatterns)) {
      return true;
    }

    return recentLogs.some((log) => this.matchAnyPattern(log, authPatterns));
  }

  private extractErrorText(error: unknown): string {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      if (code === -32000) {
        return `auth_required ${error.message}`;
      }
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return String(error);
  }

  private matchAnyPattern(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
  }
}
