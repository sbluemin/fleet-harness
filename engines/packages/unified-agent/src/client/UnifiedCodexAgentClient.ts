import { EventEmitter } from 'events';
import type { PromptResponse } from '@agentclientprotocol/sdk';

import type {
  AgentMode,
  CliDetectionResult,
  McpServerConfig,
  UnifiedClientOptions,
} from '../types/config.js';
import type {
  AcpContentBlock,
  AcpPermissionRequestParams,
  AcpPermissionResponse,
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
import { CodexAppServerConnection } from '../connection/CodexAppServerConnection.js';
import { CliDetector } from '../detector/CliDetector.js';
import {
  getBackendConfig,
  getYoloModeId,
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

/**
 * Codex app-server 전용 내부 클라이언트.
 * Codex 특수화는 이 클래스가 담당합니다.
 */
export class UnifiedCodexAgentClient extends EventEmitter implements IUnifiedAgentClient {
  private connection: CodexAppServerConnection | null = null;
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

  async disconnect(): Promise<void> {
    if (!this.connection) {
      this.clearSessionState();
      return;
    }

    const conn = this.connection;
    await conn.disconnect();
    conn.removeAllListeners();
    this.connection = null;
    this.clearSessionState();
  }

  async endSession(): Promise<void> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    await this.connection.endSession();
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
      protocol: 'codex-app-server',
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

    await this.connection.cancelPrompt();
  }

  async setModel(model: string): Promise<void> {
    this.ensurePendingOverrides().model = model;
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const pending = this.ensurePendingOverrides();
    if (CODEX_TURN_LEVEL_CONFIG_KEYS.has(configId)) {
      pending.turnConfig[configId] = value;
      return;
    }

    pending.threadConfig[configId] = value;
    this.emitTyped('log', `[codex] config '${configId}' will apply on next thread/start or thread/resume`);
  }

  async setMode(mode: string): Promise<void> {
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

  private clearSessionState(): void {
    this.sessionId = null;
    this.sessionCwd = null;
    this.currentSystemPrompt = null;
    this.pendingOverrides = null;
  }

  private setupEventForwarding(): void {
    if (!this.connection) return;

    this.connection.on('stateChange', (state: ConnectionState) => {
      this.emitTyped('stateChange', state);
    });
    this.connection.on('userMessageChunk', (text: string, sessionId: string) => {
      this.emitTyped('userMessageChunk', text, sessionId);
    });
    this.connection.on('messageChunk', (text: string, sessionId: string) => {
      this.emitTyped('messageChunk', text, sessionId);
    });
    this.connection.on('thoughtChunk', (text: string, sessionId: string) => {
      this.emitTyped('thoughtChunk', text, sessionId);
    });
    this.connection.on('toolCall', (title: string, status: string, sessionId: string, data?: unknown) => {
      this.emitTyped('toolCall', title, status, sessionId, data as AcpToolCall | undefined);
    });
    this.connection.on('toolCallUpdate', (title: string, status: string, sessionId: string, data?: unknown) => {
      this.emitTyped('toolCallUpdate', title, status, sessionId, data as AcpToolCallUpdate | undefined);
    });
    this.connection.on('plan', (plan: string, sessionId: string) => {
      this.emitTyped('plan', plan, sessionId);
    });
    this.connection.on('promptComplete', (sessionId: string) => {
      this.emitTyped('promptComplete', sessionId);
    });
    this.connection.on('permissionRequest', (params, resolve) => {
      this.emitTyped(
        'permissionRequest',
        params as AcpPermissionRequestParams,
        resolve as (response: AcpPermissionResponse) => void,
      );
    });
    this.connection.on('sessionUpdate', (update: unknown) => {
      this.emitTyped('sessionUpdate', update as AcpSessionUpdateParams);
    });
    this.connection.on('error', (err: Error) => {
      this.emitTyped('error', err);
    });
    this.connection.on('exit', (code: number | null, signal: string | null) => {
      this.emitTyped('exit', code, signal);
    });
    this.connection.on('log', (msg: string) => {
      this.emitTyped('log', msg);
    });
    this.connection.on('logEntry', (entry: StructuredLogEntry) => {
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

  private buildStartupConfigArgs(
    overrides?: string[],
    servers?: McpServerConfig[],
    modeMapping?: CodexModeMapping,
  ): string[] {
    const configArgs = [
      ...(modeMapping ? [
        `approval_policy="${modeMapping.approvalPolicy}"`,
        `sandbox_mode="${modeMapping.sandbox}"`,
      ] : []),
      ...(overrides ?? []),
      ...(servers?.length ? mcpServerConfigsToCodexArgs(servers) : []),
    ];

    return configArgs.flatMap((override) => ['-c', override]);
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
}
