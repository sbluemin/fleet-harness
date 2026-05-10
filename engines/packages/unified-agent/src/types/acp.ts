import type { SessionUpdate } from '@agentclientprotocol/sdk';

/**
 * ACP (Agent Communication Protocol) 타입 정의
 * 공식 ACP SDK의 타입을 re-export하고, 하위 호환용 alias를 제공합니다.
 *
 * 프로토콜 공식: https://agentclientprotocol.com/get-started/introduction
 */

/** session/update의 sessionUpdate 타입 (하위 호환) */
export type AcpSessionUpdateType =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'config_option_update';

/** available_commands_update payload 타입 */
export type AcpAvailableCommandsUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: 'available_commands_update' }
>;

/** available_commands_update 내부 개별 command 타입 */
export type AcpAvailableCommand =
  AcpAvailableCommandsUpdate['availableCommands'][number];

/** ACP 이벤트 타입 (하위 호환) */
export interface AcpEvents {
  /** AI 응답 텍스트 청크 */
  messageChunk: (text: string, sessionId: string) => void;
  /** AI 사고 과정 청크 */
  thoughtChunk: (text: string, sessionId: string) => void;
  /** 도구 호출 */
  toolCall: (title: string, status: string, sessionId: string) => void;
  /** 계획 업데이트 */
  plan: (plan: string, sessionId: string) => void;
  /** 사용 가능한 커맨드 목록 업데이트 */
  availableCommandsUpdate: (
    commands: AcpAvailableCommand[],
    sessionId: string,
  ) => void;
  /** 세션 업데이트 (원자적) */
  sessionUpdate: (update: unknown, sessionId: string) => void;
}

// 공식 SDK 타입 re-export
export type {
  InitializeRequest as AcpInitializeParams,
  InitializeResponse as AcpInitializeResult,
  NewSessionRequest as AcpSessionNewParams,
  NewSessionResponse as AcpSessionNewResult,
  LoadSessionRequest as AcpSessionLoadParams,
  LoadSessionResponse as AcpSessionLoadResult,
  CancelNotification as AcpSessionCancelParams,
  PromptRequest as AcpSessionPromptParams,
  PromptResponse as AcpPromptResponse,
  SetSessionModeRequest as AcpSessionSetModeParams,
  SetSessionModelRequest as AcpSessionSetModelParams,
  SetSessionConfigOptionRequest as AcpSessionSetConfigParams,
  SessionNotification as AcpSessionUpdateParams,
  SessionUpdate as AcpSessionUpdate,
  RequestPermissionRequest as AcpPermissionRequestParams,
  PermissionOption as AcpPermissionOption,
  RequestPermissionResponse as AcpPermissionResponse,
  ReadTextFileRequest as AcpFileReadParams,
  ReadTextFileResponse as AcpFileReadResponse,
  WriteTextFileRequest as AcpFileWriteParams,
  WriteTextFileResponse as AcpFileWriteResponse,
  ContentBlock as AcpContentBlock,
  TextContent as AcpTextContent,
  ImageContent as AcpImageContent,
  ResourceLink as AcpResourceLink,
  SessionConfigOption as AcpConfigOption,
  SessionMode as AcpSessionMode,
  StopReason as AcpStopReason,
  SessionModelState as AcpSessionModelState,
  ModelInfo as AcpModelInfo,
  ModelId as AcpModelId,
} from '@agentclientprotocol/sdk';

// 공식 SDK의 주요 클래스/함수 re-export
export {
  ClientSideConnection,
  AgentSideConnection,
  ndJsonStream,
  RequestError,
} from '@agentclientprotocol/sdk';

export type {
  Client as AcpClient,
  Agent as AcpAgent,
  Stream as AcpStream,
} from '@agentclientprotocol/sdk';

// 도구 호출 관련 타입 re-export
export type {
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  ToolCallContent as AcpToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk';
