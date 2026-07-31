export interface CanonicalInputMessage {
  type: "message";
  // ChatGPT Codex 백엔드는 role:"system"을 400으로 거절한다. system 성격 메시지는 developer로 싣는다.
  role: "user" | "assistant" | "developer";
  content: string;
}

export interface CanonicalFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface CanonicalFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type CanonicalInputItem =
  | CanonicalInputMessage
  | CanonicalFunctionCall
  | CanonicalFunctionCallOutput;

export interface CanonicalFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export type CanonicalToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; name: string };

export interface CanonicalResponseRequest {
  model: string;
  input: CanonicalInputItem[];
  instructions?: string;
  tools?: CanonicalFunctionTool[];
  tool_choice?: CanonicalToolChoice;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  metadata?: Record<string, string>;
  stream: true;
}

export interface CanonicalUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface CanonicalResponseSnapshot {
  id: string;
  model: string;
  usage: CanonicalUsage | null;
}

export interface CanonicalMessageOutputItem {
  id: string;
  type: "message";
  role: "assistant";
}

export interface CanonicalFunctionCallOutputItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export type CanonicalOutputItem =
  | CanonicalMessageOutputItem
  | CanonicalFunctionCallOutputItem;

export type CanonicalResponseEvent =
  | {
      type: "response.created";
      response: CanonicalResponseSnapshot;
    }
  | {
      type: "response.content_part.added";
      item_id: string;
      output_index: number;
      content_index: number;
      part: { type: "output_text"; text: string };
    }
  | {
      type: "response.output_text.delta";
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
    }
  | {
      type: "response.output_item.added";
      output_index: number;
      item: CanonicalOutputItem;
    }
  | {
      type: "response.function_call_arguments.delta";
      item_id: string;
      output_index: number;
      delta: string;
    }
  | {
      type: "response.function_call_arguments.done";
      item_id: string;
      output_index: number;
      arguments: string;
    }
  | {
      type: "response.output_item.done";
      output_index: number;
      item: CanonicalOutputItem;
    }
  | {
      type: "response.completed";
      response: CanonicalResponseSnapshot;
    }
  | {
      type: "response.failed";
      response: CanonicalResponseSnapshot & {
        error: CanonicalError;
      };
    }
  | {
      type: "error";
      error: CanonicalError;
    };

export interface CanonicalError {
  type: string;
  message: string;
}

export interface AdapterCallOptions {
  apiKey: string;
  signal?: AbortSignal;
}

export interface SuccessfulAdapterResponse {
  ok: true;
  status: number;
  headers: Headers;
  events: AsyncIterable<CanonicalResponseEvent>;
}

export interface FailedAdapterResponse {
  ok: false;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export type AdapterResponse = SuccessfulAdapterResponse | FailedAdapterResponse;

export interface AiGatewayAdapter {
  stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions
  ): Promise<AdapterResponse>;
}
