import type {
  AdapterCallOptions,
  CanonicalCompactionOutputItem,
  CanonicalInputItem,
  CanonicalResponseRequest,
  CanonicalResponseSnapshot,
  ReasoningEffort,
} from "../../canonical/index.js";
import { clampReasoningEffort } from "../../canonical/index.js";

import type { CodexResponsesAdapter } from "./responses/adapter.js";

export interface CodexCompactionResult {
  readonly encryptedContent?: string;
  readonly nativeCompaction: boolean;
  readonly summary: string;
  readonly summaryResponse: CanonicalResponseSnapshot;
}

const SUMMARY_INSTRUCTION = [
  "Create a detailed plaintext handoff summary for another coding agent.",
  "Preserve exact identifiers, durable state, user constraints, completed work, pending work, and errors.",
  "Return only the handoff summary.",
].join(" ");

const OPAQUE_SUMMARY_INSTRUCTION = [
  "Render the compacted conversation as a detailed plaintext handoff summary for another coding agent.",
  "Preserve exact identifiers, durable state, user constraints, completed work, pending work, and errors.",
  "Return only the handoff summary and do not mention opaque provider state.",
].join(" ");

export async function compactCodexConversation(options: {
  readonly adapter: CodexResponsesAdapter;
  readonly request: CanonicalResponseRequest;
  readonly call: AdapterCallOptions;
  readonly customInstructions?: string;
  readonly supportedEfforts?: readonly ReasoningEffort[];
}): Promise<CodexCompactionResult> {
  let encryptedContent: string | undefined;
  try {
    encryptedContent = await requestNativeCompaction(options);
  } catch {
    // The plaintext fallback is an explicit second contract. Claude Code's own compact
    // prompt was measured to produce a 14-byte summary on Luna and lose durable state.
  }

  const rendered = encryptedContent
    ? await renderOpaqueSummary(options, encryptedContent).catch(() => summarizePlaintext(options))
    : await summarizePlaintext(options);
  return {
    ...(encryptedContent ? { encryptedContent } : {}),
    nativeCompaction: encryptedContent !== undefined,
    summary: rendered.summary,
    summaryResponse: rendered.response,
  };
}

async function requestNativeCompaction(options: {
  readonly adapter: CodexResponsesAdapter;
  readonly request: CanonicalResponseRequest;
  readonly call: AdapterCallOptions;
  readonly customInstructions?: string;
}): Promise<string> {
  const customInstructions = options.customInstructions?.trim();
  const request = {
    ...options.request,
    input: [
      ...options.request.input,
      ...(customInstructions
        ? [{
            type: "message",
            role: "user",
            content: `Additional compact instructions. Obey these instructions and preserve their durable content in the checkpoint:\n${customInstructions}`,
          }]
        : []),
      { type: "compaction_trigger" },
    ],
    instructions: joinInstructions(options.request.instructions, customInstructions),
  } as unknown as CanonicalResponseRequest;
  const response = await options.adapter.stream(request, options.call);
  if (!response.ok) throw new Error(`Codex compaction failed with status ${response.status}`);

  let completed = false;
  const compacted: CanonicalCompactionOutputItem[] = [];
  for await (const event of response.events) {
    if (event.type === "response.output_item.done" && event.item.type === "compaction") {
      compacted.push(event.item);
    } else if (event.type === "response.completed") {
      completed = true;
    } else if (event.type === "response.failed") {
      throw new Error(event.response.error.message);
    } else if (event.type === "error") {
      throw new Error(event.error.message);
    }
  }
  if (!completed || compacted.length !== 1 || compacted[0]!.encrypted_content.length === 0) {
    throw new Error(`Codex compaction expected one completed item, got ${compacted.length}`);
  }
  return compacted[0]!.encrypted_content;
}

async function renderOpaqueSummary(
  options: {
    readonly adapter: CodexResponsesAdapter;
    readonly request: CanonicalResponseRequest;
    readonly call: AdapterCallOptions;
    readonly customInstructions?: string;
    readonly supportedEfforts?: readonly ReasoningEffort[];
  },
  encryptedContent: string,
): Promise<{ readonly summary: string; readonly response: CanonicalResponseSnapshot }> {
  return collectSummary(
    options.adapter,
    {
      model: options.request.model,
      input: [
        { type: "compaction", encrypted_content: encryptedContent },
        {
          type: "message",
          role: "user",
          content: options.customInstructions?.trim()
            ? `${OPAQUE_SUMMARY_INSTRUCTION}\n\nPreserve this compact instruction in the handoff:\n${options.customInstructions.trim()}`
            : OPAQUE_SUMMARY_INSTRUCTION,
        },
      ] as unknown as CanonicalInputItem[],
      instructions: "Render the authoritative compacted state for another coding-agent harness.",
      parallel_tool_calls: false,
      tool_choice: "none",
      reasoning: {
        summary: "auto",
        effort: lowEffort(options.supportedEfforts),
      },
      metadata: options.request.metadata,
      stream: true,
    },
    options.call,
  );
}

async function summarizePlaintext(options: {
  readonly adapter: CodexResponsesAdapter;
  readonly request: CanonicalResponseRequest;
  readonly call: AdapterCallOptions;
  readonly customInstructions?: string;
  readonly supportedEfforts?: readonly ReasoningEffort[];
}): Promise<{ readonly summary: string; readonly response: CanonicalResponseSnapshot }> {
  const instruction = options.customInstructions?.trim();
  return collectSummary(
    options.adapter,
    {
      model: options.request.model,
      input: [
        ...options.request.input,
        {
          type: "message",
          role: "user",
          content: instruction
            ? `${SUMMARY_INSTRUCTION}\n\nAdditional compact instructions:\n${instruction}`
            : SUMMARY_INSTRUCTION,
        },
      ],
      instructions: options.request.instructions,
      parallel_tool_calls: false,
      tool_choice: "none",
      reasoning: {
        summary: "auto",
        effort: lowEffort(options.supportedEfforts),
      },
      metadata: options.request.metadata,
      stream: true,
    },
    options.call,
  );
}

async function collectSummary(
  adapter: CodexResponsesAdapter,
  request: CanonicalResponseRequest,
  call: AdapterCallOptions,
): Promise<{ readonly summary: string; readonly response: CanonicalResponseSnapshot }> {
  const response = await adapter.stream(request, call);
  if (!response.ok) throw new Error(`Codex summary failed with status ${response.status}`);
  let summary = "";
  let completed: CanonicalResponseSnapshot | undefined;
  for await (const event of response.events) {
    if (event.type === "response.output_text.delta") summary += event.delta;
    else if (event.type === "response.output_text.done" && summary.length === 0) summary = event.text;
    else if (event.type === "response.completed") completed = event.response;
    else if (event.type === "response.failed") throw new Error(event.response.error.message);
    else if (event.type === "error") throw new Error(event.error.message);
  }
  if (!completed || summary.trim().length === 0) throw new Error("Codex summary returned no text");
  return { summary, response: completed };
}

function joinInstructions(base: string | undefined, custom: string | undefined): string | undefined {
  const compact = custom?.trim();
  if (!compact) return base;
  return [base, `Compact instructions:\n${compact}`].filter(Boolean).join("\n\n");
}

function lowEffort(
  supported: readonly ReasoningEffort[] | undefined,
): ReasoningEffort {
  return clampReasoningEffort("low", supported);
}
