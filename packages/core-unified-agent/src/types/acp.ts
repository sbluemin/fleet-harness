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

/**
 * @deprecated SDK 1.2에서는 model 전용 RPC 타입이 제거되었습니다.
 * 모델 변경은 `AcpSessionSetConfigParams`에 `configId: "model"`을 사용하세요.
 */
export type AcpModelId = string;

/**
 * @deprecated SDK 1.2에서는 model 전용 상태 타입이 제거되었습니다.
 * 모델 정보는 provider registry 또는 config option surface를 사용하세요.
 */
export type AcpModelInfo = {
  _meta?: Record<string, unknown> | null;
  description?: string | null;
  modelId: AcpModelId;
  name: string;
};

/**
 * @deprecated SDK 1.2에서는 model 전용 상태 타입이 제거되었습니다.
 * 현재 모델 조회는 각 bridge의 config option surface로 이관하세요.
 */
export type AcpSessionModelState = {
  _meta?: Record<string, unknown> | null;
  availableModels: AcpModelInfo[];
  currentModelId: AcpModelId;
};

/**
 * @deprecated SDK 1.2에서는 `session/set_model`이 제거되었습니다.
 * 모델 변경은 `AcpSessionSetConfigParams`에 `configId: "model"`을 사용하세요.
 */
export type AcpSessionSetModelParams = {
  _meta?: Record<string, unknown> | null;
  modelId: AcpModelId;
  sessionId: string;
};

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
} from '@agentclientprotocol/sdk';

// 도구 호출 관련 타입 re-export
export type {
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  ToolCallContent as AcpToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk';
