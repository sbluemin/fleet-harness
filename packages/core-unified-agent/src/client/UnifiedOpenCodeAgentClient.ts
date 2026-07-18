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
import { getProviderModels } from '../models/ModelRegistry.js';
import type { ProviderModelInfo } from '../models/schemas.js';

/**
 * OpenCode ACP 전용 내부 클라이언트.
 * OpenCode의 spawn option, system prompt prefix, reset 제한을 이 클래스 안에서 완결합니다.
 *
 * OpenCode ACP 특성:
 * - 직접 spawn: `opencode acp` (npx 브릿지 없음)
 * - 세션 교체: closeSession은 best-effort로 호출하고 resetSession은 disconnect + reconnect 사용
 * - systemPrompt: `_meta.systemPrompt.append` 미지원 → firstPromptPending 방식
 * - authRequired: false (자체 인증 스텁)
 * - YOLO 모드: `build` 모드로 매핑
 */
export class UnifiedOpenCodeAgentClient extends EventEmitter implements IUnifiedAgentClient {
  private readonly providerId: Extract<CliType, 'opencode-go'>;
  private connection: AcpConnection | null = null;
  private sessionId: string | null = null;
  private sessionCwd: string | null = null;
  private currentSystemPrompt: string | null = null;
  /** 첫 프롬프트 전송 시 systemPrompt를 텍스트 블록으로 앞에 붙이기 위한 플래그 */
  private firstPromptPending: string | null = null;
  private detector = new CliDetector();

  constructor(providerId: Extract<CliType, 'opencode-go'>) {
    super();
    this.providerId = providerId;
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
    if (options.cli && options.cli !== this.providerId) {
      throw new Error(`UnifiedOpenCodeAgentClient는 ${this.providerId} CLI만 지원합니다.`);
    }

    const acpMcpServers = this.resolveMcpServers(options.mcpServers);
    const spawnConfig = createSpawnConfig(this.providerId, options);
    const cleanEnv = cleanEnvironment(process.env, options.env);

    // OpenCode 내장 에이전트 비활성화 설정 주입 (explore, plan, general)
    cleanEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      agent: {
        explore: { disable: true },
        plan: { disable: true },
        general: { disable: true },
      },
    });

    const connection = new AcpConnection({
      command: spawnConfig.command,
      args: spawnConfig.args,
      cliType: this.providerId,
      cwd: options.cwd,
      env: cleanEnv,
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
      // OpenCode는 _meta.systemPrompt.append를 지원하지 않으므로
      // systemPrompt를 세션 생성 시 전달하지 않고 firstPromptPending으로 처리합니다.
      session = await connection.connect(
        options.cwd,
        options.sessionId,
        acpMcpServers,
        undefined,
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

    // OpenCode 계열은 disconnect 경로에서 프로세스 종료를 우선합니다.
    const conn = this.connection;
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
      cli: this.connection ? this.providerId : null,
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

    // OpenCode는 _meta.systemPrompt.append를 지원하지 않아
    // 첫 프롬프트에 systemPrompt를 텍스트 블록으로 앞에 붙입니다.
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

    await this.connection.setConfigOption(this.sessionId, configId, value);
  }

  async setMode(mode: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('연결되어 있지 않습니다');
    }

    await this.connection.setMode(this.sessionId, mode);
  }

  async setYoloMode(enabled: boolean): Promise<void> {
    // OpenCode의 YOLO 모드는 'build' 모드로 매핑됩니다.
    return this.setMode(enabled ? getYoloModeId(this.providerId) : 'plan');
  }

  getAvailableModes(): AgentMode[] {
    return getBackendConfig(this.providerId).modes ?? [];
  }

  getAvailableModels(): ProviderModelInfo | null {
    return getProviderModels(this.providerId);
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
    });
    this.sessionId = sessionId;
    // 세션 로드 시 기존 systemPrompt 컨텍스트를 유지하지 않습니다.
    this.currentSystemPrompt = null;
    this.firstPromptPending = null;
  }

  async resetSession(cwd?: string): Promise<ConnectResult> {
    if (!this.connection) {
      throw new Error('연결되어 있지 않습니다');
    }

    // OpenCode 계열은 disconnect 후 재연결하는 방식으로 세션을 교체합니다.
    const targetCwd = cwd ?? this.sessionCwd ?? process.cwd();
    await this.disconnect();

    const newClient = new UnifiedOpenCodeAgentClient(this.providerId);
    const result = await newClient.connect({
      cwd: targetCwd,
      autoApprove: true,
      systemPrompt: this.currentSystemPrompt ?? undefined,
    });

    // 새 클라이언트의 내부 상태를 현재 인스턴스로 이전합니다.
    this.connection = newClient.connection;
    this.sessionId = newClient.sessionId;
    this.sessionCwd = newClient.sessionCwd;
    this.currentSystemPrompt = newClient.currentSystemPrompt;
    this.firstPromptPending = newClient.firstPromptPending;

    // 새 클라이언트의 이벤트 리스너를 현재 인스턴스로 재설정합니다.
    this.setupEventForwarding();

    // 임시 클라이언트의 리스너를 정리합니다.
    newClient.removeAllListeners();

    return {
      cli: this.providerId,
      protocol: 'acp',
      session: result.session,
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
        await this.connection!.setMode(session.sessionId, getYoloModeId(this.providerId));
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
    // 세션 재개가 아닌 경우 systemPrompt를 첫 프롬프트에 주입합니다.
    this.firstPromptPending = options.sessionId ? null : this.currentSystemPrompt;

    return {
      cli: this.providerId,
      protocol: 'acp',
      session,
    };
  }

  private clearSessionState(): void {
    this.sessionId = null;
    this.sessionCwd = null;
    this.currentSystemPrompt = null;
    this.firstPromptPending = null;
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

  private buildConnectionError(error: unknown, _recentLogs: string[]): Error {
    // OpenCode는 authRequired: false이므로 인증 에러 패턴 매칭이 불필요합니다.
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
}
