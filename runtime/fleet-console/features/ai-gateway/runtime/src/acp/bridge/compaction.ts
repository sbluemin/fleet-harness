import { randomUUID } from "node:crypto";

import type { CanonicalInputItem, CanonicalResponseSnapshot } from "../../canonical/index.js";
import type { GatewayReasoningEffort } from "../../models.js";
import { estimateTokens } from "../../transport/token-estimate.js";
import { wireLog } from "../../transport/wire-log.js";
import type { AcpSession, AcpSessionPort, AcpThoughtLevel } from "../contract.js";
import {
  agyWarningText,
  classifyAgyOpenFailure,
  classifyAgyUpstreamFailure,
  parseAgyUpstreamError,
} from "../events.js";
import { resolveAcpModelSelection, type AcpModelSelection } from "../models.js";
import { AGY_INERT_TOOL_TITLES, toolOnlyTitlePrefix } from "../tool-only.js";
import { compactionReplayBlocks, REPLAY_SYSTEM_NOTE } from "./history.js";
import type { BridgeMcpServer, McpSessionHandler } from "./mcp-server.js";

export interface AgyCompactionRequest {
  readonly model: string;
  readonly input: readonly CanonicalInputItem[];
  readonly customInstructions?: string;
  readonly reasoningEffort?: AcpThoughtLevel | GatewayReasoningEffort;
}

export interface AgyCompactionResult {
  readonly summary: string;
  readonly summaryResponse: CanonicalResponseSnapshot;
}

export class AgyCompactionError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(message);
    this.name = "AgyCompactionError";
  }
}

const COMPACT_SYSTEM_INSTRUCTION = [
  "Create a detailed plaintext handoff summary for another coding agent.",
  "Preserve exact identifiers, durable state, user constraints, completed work, pending work, and errors.",
  "Respond with plain text only and do not call any tools.",
].join(" ");

const COMPACT_USER_INSTRUCTION = [
  "Create a detailed plaintext handoff summary for another coding agent.",
  "Preserve exact identifiers, durable state, user constraints, completed work, pending work, and errors.",
  "Respond with plain text only and do not call any tools.",
  "Return only the handoff summary.",
].join(" ");

const WARNING_HOLD_MAX_CHARS = 400;

export async function compactAgyConversation(options: {
  readonly port: AcpSessionPort;
  readonly mcp: BridgeMcpServer;
  readonly serverName: string;
  readonly replayBudgetChars: number;
  readonly callTimeoutSeconds: number;
  readonly silenceMs: number;
  readonly request: AgyCompactionRequest;
  readonly signal?: AbortSignal;
}): Promise<AgyCompactionResult> {
  let selection: AcpModelSelection;
  try {
    selection = resolveAcpModelSelection(options.request.model, options.request.reasoningEffort ?? "low");
  } catch (error) {
    throw new AgyCompactionError(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }

  const custom = options.request.customInstructions?.trim();
  const summaryPrompt = custom
    ? `${COMPACT_USER_INSTRUCTION}\n\nAdditional compact instructions:\n${custom}`
    : COMPACT_USER_INSTRUCTION;
  const { blocks, replayChars, omittedTurns } = compactionReplayBlocks(
    options.request.input,
    options.replayBudgetChars,
    summaryPrompt,
  );
  const promptChars = blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.text.length : 0), 0);
  const estimatedInputTokens = estimateTokens(
    blocks.map((block) => (block.kind === "text" ? block.text : "")).join("\n"),
    options.request.model,
  );

  const key = `br-compact-${randomUUID()}`;
  wireLog("bridge.compact_start", {
    session: key,
    model: selection.catalogId,
    thoughtLevel: selection.thoughtLevel,
    items: options.request.input.length,
    promptChars,
    replayChars,
    ...(omittedTurns > 0 ? { omittedTurns } : {}),
  });

  let attemptedTool: string | undefined;
  let acp: AcpSession | undefined;
  const handler: McpSessionHandler = {
    tools: () => [],
    onCall: (call) => {
      attemptedTool ??= call.name;
      call.settle({ content: [{ type: "text", text: "Tools are disabled during compaction." }], isError: true });
      void acp?.cancel().catch(() => undefined);
    },
    onAbandon: () => {},
  };
  const registration = await options.mcp.register(key, handler);

  const opening = new AbortController();
  const relay = (): void => opening.abort(options.signal?.reason);
  if (options.signal?.aborted) relay();
  else options.signal?.addEventListener("abort", relay, { once: true });

  try {
    try {
      acp = await options.port.open({
        model: options.request.model,
        thoughtLevel: selection.thoughtLevel,
        systemPrompt: [
          COMPACT_SYSTEM_INSTRUCTION,
          ...(replayChars > 0 ? [REPLAY_SYSTEM_NOTE] : []),
        ].join("\n\n"),
        toolOnly: {
          serverName: options.serverName,
          url: registration.url,
          headers: { Authorization: `Bearer ${registration.token}` },
          toolNames: [],
          callTimeoutSeconds: options.callTimeoutSeconds,
        },
        sessionKey: key,
        signal: opening.signal,
      });
    } catch (error) {
      const failure = classifyAgyOpenFailure(error);
      throw new AgyCompactionError(failure.status, failure.type, failure.message);
    }

    if (options.signal?.aborted) {
      throw new AgyCompactionError(503, "api_error", "Antigravity compaction was aborted.");
    }

    const prefix = toolOnlyTitlePrefix(options.serverName);
    let summary = "";
    let held: string | undefined;
    let peakUsed = 0;

    const releaseHeld = (): void => {
      if (held === undefined) return;
      summary += held;
      held = undefined;
    };

    const iterator = acp.prompt(blocks)[Symbol.asyncIterator]();
    for (;;) {
      const step = await nextWithSilenceTimeout(iterator, options.silenceMs, options.signal);
      if (step === "aborted") {
        await iterator.return?.().catch(() => undefined);
        throw new AgyCompactionError(503, "api_error", "Antigravity compaction was aborted.");
      }
      if (step === "timeout") {
        await iterator.return?.().catch(() => undefined);
        throw new AgyCompactionError(
          503,
          "api_error",
          `agy produced no compaction output for ${Math.round(options.silenceMs / 1000)}s.`,
        );
      }
      if (step.done) break;
      const event = step.value;
      switch (event.kind) {
        case "usage":
          peakUsed = Math.max(peakUsed, event.usage.usedTokens);
          break;
        case "text": {
          const upstream = parseAgyUpstreamError(event.text);
          if (upstream) {
            const failure = classifyAgyUpstreamFailure(upstream);
            wireLog("bridge.compact_upstream_error", { session: key, status: failure.status, type: failure.type });
            throw new AgyCompactionError(failure.status, failure.type, failure.message);
          }
          if (summary.length === 0 && (held !== undefined || agyWarningText(event.text) !== undefined)) {
            held = (held ?? "") + event.text;
            if (held.length <= WARNING_HOLD_MAX_CHARS) break;
            releaseHeld();
            break;
          }
          summary += event.text;
          break;
        }
        case "tool-start":
          if (!AGY_INERT_TOOL_TITLES.has(event.name)) {
            attemptedTool ??= event.name;
            wireLog("bridge.compact_tool_attempt", { session: key, tool: event.name, prefix });
            throw new AgyCompactionError(503, "api_error", `agy attempted to call a tool (${event.name}) during compaction.`);
          }
          break;
        case "exit":
          throw new AgyCompactionError(503, "api_error", `agy exited during compaction${event.detail ? `: ${event.detail}` : ""}`);
        case "turn-end": {
          if (event.stopReason === "cancelled") {
            throw new AgyCompactionError(503, "api_error", "agy cancelled the compaction turn.");
          }
          if (event.stopReason === "error") {
            throw new AgyCompactionError(503, "api_error", `agy failed the compaction turn: ${event.detail ?? "unknown error"}`);
          }
          if (event.stopReason === "max_tokens" || event.stopReason === "refusal") {
            throw new AgyCompactionError(503, "api_error", `Antigravity compaction ended incomplete (${event.stopReason}).`);
          }
          if (held !== undefined) {
            const failure = classifyAgyUpstreamFailure({
              status: undefined,
              code: undefined,
              message: agyWarningText(held) ?? held,
            });
            wireLog("bridge.compact_upstream_error", { session: key, status: failure.status, type: failure.type, kind: "warning-only turn" });
            throw new AgyCompactionError(failure.status, failure.type, failure.message);
          }
          if (attemptedTool !== undefined) {
            throw new AgyCompactionError(503, "api_error", `agy attempted to call a tool (${attemptedTool}) during compaction.`);
          }
          if (summary.trim().length === 0) {
            throw new AgyCompactionError(503, "api_error", "Antigravity compaction returned no text.");
          }
          wireLog("bridge.compact_done", { session: key, chars: summary.length, peakUsed });
          return {
            summary,
            summaryResponse: {
              id: `msg_agy_compact_${randomUUID().replace(/-/g, "")}`,
              model: options.request.model,
              usage: {
                input_tokens: Math.max(peakUsed, estimatedInputTokens),
                output_tokens: estimateTokens(summary, options.request.model),
              },
            },
          };
        }
        case "thought":
        case "tool-end":
          break;
      }
    }

    throw new AgyCompactionError(503, "api_error", "Antigravity compaction stream ended without turn-end.");
  } finally {
    options.signal?.removeEventListener("abort", relay);
    options.mcp.unregister(key);
    if (acp) {
      await acp.cancel().catch(() => undefined);
      await acp.close().catch(() => undefined);
    }
  }
}

async function nextWithSilenceTimeout<T>(
  iterator: AsyncIterator<T>,
  silenceMs: number,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T> | "timeout" | "aborted"> {
  if (signal?.aborted) return "aborted";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), silenceMs);
        timer.unref?.();
      }),
      ...(signal
        ? [new Promise<"aborted">((resolve) => {
            onAbort = () => resolve("aborted");
            signal.addEventListener("abort", onAbort, { once: true });
          })]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
