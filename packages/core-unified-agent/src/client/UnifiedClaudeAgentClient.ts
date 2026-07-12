import { EventEmitter } from 'events';
import type { PromptResponse, McpServer } from '@agentclientprotocol/sdk';

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
import type { ConnectionState, StructuredLogEntry } from '../types/common.js';
import type {
  ConnectResult,
  ConnectionInfo,
  IUnifiedAgentClient,
  UnifiedClientEvents,
} from './IUnifiedAgentClient.js';
import { AcpConnection } from '../connection/AcpConnection.js';
import { CliDetector } from '../detector/CliDetector.js';
import {
  createSpawnConfig,
  getBackendConfig,
  getYoloModeId,
  mcpServerConfigsToAcp,
  type CliType,
} from '../config/CliConfigs.js';
import { cleanEnvironment } from '../utils/env.js';
import { getProviderModels, getProviderModelsMapping } from '../models/ModelRegistry.js';
import type { ProviderModelInfo } from '../models/schemas.js';

/**
 * Claude Code ACP 전용 내부 클라이언트.
 * Claude의 system prompt, mode, model 계약을 이 클래스 안에서 완결합니다.
 */
export class UnifiedClaudeAgentClient extends EventEmitter implements IUnifiedAgentClient {
  private connection: AcpConnection | null = null;
  private sessionId: string | null = null;
  private sessionCwd: string | null = null;
  private currentSystemPrompt: string | null = null;
  private firstPromptPending: string | null = null;
  private currentEffort: string | null = null;
  private detector = new CliDetector();
  private readonly cliType: CliType & 'claude';

  constructor(cliType: CliType & 'claude' = 'claude') {
    super();
    this.cliType = cliType;
  }

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
    if (options.cli && options.cli !== this.cliType) {
      throw new Error(`UnifiedClaudeAgentClient는 ${this.cliType} CLI만 지원합니다.`);
    }

    const acpMcpServers = this.resolveMcpServers(options.mcpServers);
    const spawnConfig = createSpawnConfig(this.cliType, options);

    // modelsMapping에서 환경변수 기본값 생성
    const modelsMapping = getProviderModelsMapping(this.cliType);
    const mappingEnv: Record<string, string> = {};
    if (modelsMapping) {
      // modelId → ANTHROPIC_DEFAULT_*_MODEL 환경변수 매핑
      for (const [modelId, mappedModel] of Object.entries(modelsMapping)) {
        const envKey = `ANTHROPIC_DEFAULT_${modelId.toUpperCase()}_MODEL`;
        mappingEnv[envKey] = mappedModel;
      }
    }

    // 백엔드 기본 환경변수 (프록시 설정 등)
    const backendConfig = getBackendConfig(this.cliType);
    const defaultEnv = backendConfig.defaultEnv ?? {};

    // 사용자 설정(options.env) > modelsMapping 기본값(mappingEnv) > 백엔드 기본값(defaultEnv) > process.env
    const cleanEnv = cleanEnvironment(process.env, { ...defaultEnv, ...mappingEnv, ...options.env });

    // Anthropic 호환 커스텀 백엔드는 별도 API 토큰이 필요합니다.
    if (defaultEnv.ANTHROPIC_BASE_URL && !cleanEnv.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        `[${this.cliType}] ANTHROPIC_AUTH_TOKEN 환경변수가 설정되지 않았습니다. ${getProviderModels(this.cliType).name} API 키를 환경변수로 설정해주세요.`,
      );
    }

    const connection = new AcpConnection({
      command: spawnConfig.command,
      args: spawnConfig.args,
      cliType: this.cliType,
      cwd: options.cwd,
      env: { ...cleanEnv },
      requestTimeout: options.timeout,
      initTimeout: options.timeout,
      promptIdleTimeout: options.promptIdleTimeout,
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
        acpMcpServers,
        undefined,
        options.strictMcp,
        options.effort,
      );
    } catch (error) {
      const connectionError = this.buildConnectionError(error, recentLogs);
      await this.cleanupFailedConnection();
      throw connectionError;
    } finally {
      connection.off('log', collectLog);
    }

    return this.finalizeConnect(options, session);
  }

  async disconnect(): Promise<void> {
    if (!this.connection) {
      this.clearSessionState();
      return;
    }

    const conn = this.connection;
    if (this.sessionId && conn.canResetSession) {
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
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    await this.connection.endSession(this.sessionId);
    this.sessionId = null;
  }

  getConnectionInfo(): ConnectionInfo {
    return {
      cli: this.connection ? this.cliType : null,
      protocol: this.connection ? 'acp' : null,
      sessionId: this.sessionId,
      state: this.connection ? this.connection.connectionState : 'disconnected',
    };
  }

  async detectClis(): Promise<CliDetectionResult[]> {
    return this.detector.detectAll(true);
  }

  async sendMessage(content: string | AcpContentBlock[]): Promise<PromptResponse> {
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    const systemPrompt = this.firstPromptPending;
    if (!systemPrompt) {
      return this.connection.sendPrompt(this.sessionId, content);
    }

    const userBlocks: AcpContentBlock[] = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : content;
    const response = await this.connection.sendPrompt(this.sessionId, [
      { type: 'text', text: systemPrompt },
      ...userBlocks,
    ]);
    this.firstPromptPending = null;
    return response;
  }

  async cancelPrompt(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    await this.connection.cancelSession(this.sessionId);
  }

  async setModel(model: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    await this.connection.setModel(this.sessionId, model);
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    if (configId === 'effort') {
      this.currentEffort = value;
      return;
    }

    await this.connection.setConfigOption(this.sessionId, configId, value);
  }

  async setMode(mode: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    await this.connection.setMode(this.sessionId, mode);
  }

  async setYoloMode(enabled: boolean): Promise<void> {
    return this.setMode(enabled ? getYoloModeId(this.cliType) : 'default');
  }

  getAvailableModes(): AgentMode[] {
    return getBackendConfig(this.cliType).modes ?? [];
  }

  getAvailableModels(): ProviderModelInfo | null {
    return getProviderModels(this.cliType);
  }

  getCurrentSystemPrompt(): string | null {
    return this.currentSystemPrompt;
  }

  async loadSession(sessionId: string, mcpServers?: McpServerConfig[]): Promise<void> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    await this.connection.loadSession({
      sessionId,
      cwd: this.sessionCwd ?? process.cwd(),
      mcpServers: this.resolveMcpServers(mcpServers),
    }, this.currentEffort ?? undefined);
    this.sessionId = sessionId;
    this.currentSystemPrompt = null;
    this.firstPromptPending = null;
  }

  async resetSession(cwd?: string): Promise<ConnectResult> {
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    const targetCwd = cwd ?? this.sessionCwd ?? process.cwd();
    if (!this.connection.canResetSession) {
      throw new Error(`[${this.cliType}] 세션 리셋을 지원하지 않습니다. disconnect() 후 재연결하세요.`);
    }

    await this.connection.endSession(this.sessionId);
    this.sessionId = null;

    const session = await this.connection.reconnectSession(
      targetCwd,
      undefined,
      undefined,
      undefined,
      undefined,
      this.currentEffort ?? undefined,
    );

    this.sessionId = session.sessionId;
    this.sessionCwd = targetCwd;
    this.firstPromptPending = this.currentSystemPrompt;

    return {
      cli: this.cliType,
      protocol: 'acp',
      session,
    };
  }

  private resolveMcpServers(servers?: McpServerConfig[]): McpServer[] {
    return servers?.length ? mcpServerConfigsToAcp(servers) : [];
  }

  private async finalizeConnect(
    options: UnifiedClientOptions,
    session: AcpSessionNewResult,
  ): Promise<ConnectResult> {
    if (options.yoloMode && session.sessionId) {
      try {
        await this.connection!.setMode(session.sessionId, getYoloModeId(this.cliType));
      } catch {
        // YOLO 모드 미지원 상황은 연결 성공을 막지 않습니다.
      }
    }

    if (options.model && session.sessionId) {
      try {
        await this.connection!.setModel(session.sessionId, options.model);
      } catch {
        // 모델 설정 미지원 상황은 연결 성공을 막지 않습니다.
      }
    }

    this.sessionId = session.sessionId;
    this.sessionCwd = options.cwd;
    this.currentSystemPrompt = options.systemPrompt ?? null;
    this.firstPromptPending = options.sessionId ? null : this.currentSystemPrompt;
    this.currentEffort = options.effort ?? null;

    return {
      cli: this.cliType,
      protocol: 'acp',
      session,
    };
  }

  private clearSessionState(): void {
    this.sessionId = null;
    this.sessionCwd = null;
    this.currentSystemPrompt = null;
    this.firstPromptPending = null;
    this.currentEffort = null;
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
    this.connection.on('toolCall', (title: string, status: string, sessionId: string, data?: AcpToolCall) => {
      this.emitTyped('toolCall', title, status, sessionId, data);
    });
    this.connection.on('toolCallUpdate', (title: string, status: string, sessionId: string, data?: AcpToolCallUpdate) => {
      this.emitTyped('toolCallUpdate', title, status, sessionId, data);
    });
    this.connection.on('plan', (plan: string, sessionId: string) => {
      this.emitTyped('plan', plan, sessionId);
    });
    this.connection.on('availableCommandsUpdate', (commands: AcpAvailableCommand[], sessionId: string) => {
      this.emitTyped('availableCommandsUpdate', commands, sessionId);
    });
    this.connection.on('sessionUpdate', (update: AcpSessionUpdateParams) => {
      this.emitTyped('sessionUpdate', update);
    });
    this.connection.on('permissionRequest', (params: AcpPermissionRequestParams, resolve: (response: AcpPermissionResponse) => void) => {
      this.emitTyped('permissionRequest', params, resolve);
    });
    this.connection.on('fileRead', (params: AcpFileReadParams, resolve: (response: AcpFileReadResponse) => void) => {
      this.emitTyped('fileRead', params, resolve);
    });
    this.connection.on('fileWrite', (params: AcpFileWriteParams, resolve: (response: AcpFileWriteResponse) => void) => {
      this.emitTyped('fileWrite', params, resolve);
    });
    this.connection.on('promptComplete', (sessionId: string) => {
      this.emitTyped('promptComplete', sessionId);
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
    if (getBackendConfig(this.cliType).authRequired && this.isAuthenticationError(error, recentLogs)) {
      return new Error(
        `[${this.cliType}] 인증이 필요하거나 인증이 만료되었습니다. 먼저 해당 CLI에서 로그인/인증을 완료한 뒤 다시 시도해주세요.`,
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
