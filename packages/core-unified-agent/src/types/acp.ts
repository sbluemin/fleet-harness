import type { SessionUpdate } from '@agentclientprotocol/sdk';

/**
 * ACP (Agent Communication Protocol) 타입 정의
 * 공식 ACP SDK의 타입을 re-export하고, 하위 호환용 alias를 제공합니다.
 *
 * 프로토콜 공식: https://agentclientprotocol.com/get-started/introduction
 */

/** available_commands_update payload 타입 */
export type AcpAvailableCommandsUpdate = Extract<
  SessionUpdate,
  { sessionUpdate: 'available_commands_update' }
>;

/** available_commands_update 내부 개별 command 타입 */
export type AcpAvailableCommand =
  AcpAvailableCommandsUpdate['availableCommands'][number];

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

// 도구 호출 관련 타입 re-export
export type {
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  ToolCallContent as AcpToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk';
