export interface CanonicalInputTextPart {
  type: "input_text";
  text: string;
}

export interface CanonicalInputImagePart {
  type: "input_image";
  /** Fully qualified URL or `data:<media_type>;base64,...` data URL. */
  image_url: string;
  detail?: "auto" | "low" | "high" | "original";
}

export type CanonicalInputContentPart =
  | CanonicalInputTextPart
  | CanonicalInputImagePart;

export interface CanonicalInputMessage {
  type: "message";
  // ChatGPT Codex 백엔드는 role:"system"을 400으로 거절한다. system 성격 메시지는 developer로 싣는다.
  role: "user" | "assistant" | "developer";
  /** Plain text, or Responses-style multimodal parts when images are present. */
  content: string | CanonicalInputContentPart[];
}

/** Flatten message text for adapters that only accept a string prompt body. */
export function canonicalMessageText(
  content: CanonicalInputMessage["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is CanonicalInputTextPart => part.type === "input_text")
    .map((part) => part.text)
    .join("");
}

export function canonicalMessageImages(
  content: CanonicalInputMessage["content"],
): CanonicalInputImagePart[] {
  if (typeof content === "string") {
    return [];
  }
  return content.filter(
    (part): part is CanonicalInputImagePart => part.type === "input_image",
  );
}

/** Collapse parts back to a string when there are no images. */
export function normalizeCanonicalMessageContent(
  parts: CanonicalInputContentPart[],
): CanonicalInputMessage["content"] {
  const images = parts.filter(
    (part): part is CanonicalInputImagePart => part.type === "input_image",
  );
  if (images.length === 0) {
    return parts
      .filter((part): part is CanonicalInputTextPart => part.type === "input_text")
      .map((part) => part.text)
      .join("");
  }
  return parts;
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

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export class UnsupportedReasoningEffortError extends RangeError {
  constructor(
    readonly requestedEffort: ReasoningEffort,
    readonly supportedEfforts: readonly ReasoningEffort[],
    readonly modelId?: string,
  ) {
    const subject = modelId ? `Model "${modelId}"` : "Selected model";
    super(`${subject} has no supported reasoning effort at or below "${requestedEffort}"`);
    this.name = "UnsupportedReasoningEffortError";
  }
}

const REASONING_EFFORT_RANK = new Map(
  REASONING_EFFORTS.map((effort, index) => [effort, index] as const),
);

/** Clamp to the highest supported rung not above the request; never silently increase effort. */
export function clampReasoningEffort(
  effort: ReasoningEffort,
  supportedEfforts: readonly ReasoningEffort[] | undefined,
  modelId?: string,
): ReasoningEffort {
  if (!supportedEfforts || supportedEfforts.length === 0 || supportedEfforts.includes(effort)) {
    return effort;
  }

  const requestedRank = REASONING_EFFORT_RANK.get(effort) ?? 0;
  const ranked = supportedEfforts
    .map((supported) => ({ supported, rank: REASONING_EFFORT_RANK.get(supported) }))
    .filter((entry): entry is { supported: ReasoningEffort; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank);
  const lower = ranked.filter((entry) => entry.rank <= requestedRank).at(-1);
  if (lower) return lower.supported;
  throw new UnsupportedReasoningEffortError(effort, supportedEfforts, modelId);
}

export interface CanonicalReasoning {
  summary: "auto";
  effort?: ReasoningEffort;
}

export interface CanonicalResponseRequest {
  model: string;
  input: CanonicalInputItem[];
  instructions?: string;
  tools?: CanonicalFunctionTool[];
  tool_choice?: CanonicalToolChoice;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  metadata?: Record<string, string>;
  reasoning?: CanonicalReasoning;
  service_tier?: "priority";
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
