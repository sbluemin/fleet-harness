/**
 * admiral/agent/internal/event-normalizer — unified-agent 이벤트 → AgentStreamEvent 정규화.
 *
 * ACP 클라이언트 이벤트(messageChunk, thoughtChunk, toolCall 등)를
 * admiral.agent.events 모듈 채널로 emit. CLI 내장 tool 완료 시
 * text delta 경로로 한 줄 렌더링 데이터를 보존.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import type { IUnifiedAgentClient } from "@sbluemin/fleet-unified-agent";
import type { CliToolCall, CliToolCallUpdate } from "../../_shared/cli-tool-types.js";

import { emitStreamEvent } from "../events.js";
import type { AgentStreamEvent } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface StreamEmitter {
  readonly sessionId: string;
  emit(event: AgentStreamEvent): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const GENERIC_TITLES = new Set<string>();

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ACP 클라이언트에 이벤트 리스너를 등록하고, 수신 이벤트를 AgentStreamEvent로 변환해 emit.
 *
 * @param client - ACP 클라이언트
 * @param sessionId - 타겟 ACP 세션 ID (이 세션의 이벤트만 처리)
 * @param piToolNames - MCP(pi) tool 이름 Set (CLI 내장 tool과 구분용)
 * @returns 리스너 해제 함수
 */
export function wireStreamEmitter(
  client: IUnifiedAgentClient,
  sessionId: string,
  piToolNames: Set<string>,
): () => void {
  const activeCliTools = new Map<string, { toolName: string; title: string }>();
  let lastCliToolStart: { toolName: string; title: string } | null = null;

  const onMessageChunk = (text: string, sid: string): void => {
    if (sid !== sessionId) return;
    emitStreamEvent({ type: "text", sessionId: sid, text });
  };

  const onThoughtChunk = (text: string, sid: string): void => {
    if (sid !== sessionId) return;
    emitStreamEvent({ type: "thought", sessionId: sid, text });
  };

  const onToolCall = (
    title: string,
    status: string,
    sid: string,
    data?: CliToolCall,
  ): void => {
    if (sid !== sessionId) return;

    const rawToolName = (data?.rawInput as Record<string, unknown> | undefined)?.tool;
    const actualToolName = typeof rawToolName === "string" ? rawToolName : null;
    const parsedTitle = extractMcpToolName(title);
    const toolName = actualToolName || parsedTitle || title || (data?.kind ?? "tool");
    const isMcpTool = piToolNames.has(toolName);

    if (isMcpTool) return;

    // ACP 표준 toolCallId를 1순위 머지 키로 사용. rawInput.call_id는 Codex 등 비-ACP fallback.
    const callId = data?.toolCallId || extractCallId(data?.rawInput);
    if (callId) {
      activeCliTools.set(callId, { toolName, title });
    }
    lastCliToolStart = { toolName, title };

    // ACP 분할 도착 UX 개선: 1차 빈약 toolCall(status=pending)은 emit 보류.
    // 풍부 title은 onToolCallUpdate에서 status=completed/error 도달 시 text delta로 한 번 emit됨.
    if (status === "pending") return;

    emitStreamEvent({
      type: "toolCall",
      sessionId: sid,
      toolCallId: callId ?? crypto.randomUUID(),
      title: toolName,
      status,
    });
  };

  const onToolCallUpdate = (
    title: string,
    status: string,
    sid: string,
    data?: CliToolCallUpdate,
  ): void => {
    if (sid !== sessionId) return;

    const rawToolName = (data as Record<string, unknown> | undefined)?.tool;
    const actualToolName = typeof rawToolName === "string" ? rawToolName : null;
    const parsedTitle = extractMcpToolName(title);
    const toolName = actualToolName || parsedTitle || title || "";
    const isMcpTool = piToolNames.has(toolName);

    if (isMcpTool) return;

    // ACP 표준 toolCallId를 1순위 머지 키로 사용. rawOutput.call_id는 Codex 등 비-ACP fallback.
    const callId = data?.toolCallId || extractCallId(data?.rawOutput);

    if (title && lastCliToolStart) {
      lastCliToolStart.title = title;
    }
    // 풍부 title이 도착했을 때 activeCliTools도 갱신 — 4차 status=completed에서 lookup 정확성 보장.
    // 이 갱신이 없으면 1차 onToolCall에서 set된 빈약 title("Read File")이 그대로 fallback 사용됨.
    if (callId && title) {
      const tracked = activeCliTools.get(callId);
      if (tracked) {
        tracked.title = title;
      } else {
        activeCliTools.set(callId, { toolName, title });
      }
    }

    let resolvedTitle = title;
    const isError = status === "error" || status === "failed";

    if (status === "completed" || isError) {
      const tracked = callId ? activeCliTools.get(callId) : null;
      const fallback = tracked ?? lastCliToolStart;
      resolvedTitle = title || fallback?.title || toolName;
      if (isGenericTitle(resolvedTitle) && data?.rawOutput) {
        const hint = extractHintFromRawOutput(data.rawOutput, resolvedTitle);
        if (hint) resolvedTitle = hint;
      }

      // CLI 내장 tool 완료 — text delta 경로로 한 줄 렌더링 보존
      if (resolvedTitle) {
        const tag = isError ? "**✘**" : "**✔**";
        const truncated = truncateMid(resolvedTitle, 80);
        const delta = `\n\n\`${truncated}\` ${tag}\n\n`;
        emitStreamEvent({ type: "text", sessionId: sid, text: delta });
      }

      if (callId) activeCliTools.delete(callId);
      lastCliToolStart = null;
    }

    emitStreamEvent({
      type: "toolCallUpdate",
      sessionId: sid,
      toolCallId: callId ?? "",
      title: resolvedTitle,
      status,
    });
  };

  const onPromptComplete = (sid: string): void => {
    if (sid !== sessionId) return;
    emitStreamEvent({ type: "complete", sessionId: sid, done: "stop" });
  };

  const onError = (error: Error): void => {
    emitStreamEvent({ type: "error", sessionId, error: error.message });
  };

  const onExit = (code: number | null, signal: string | null): void => {
    emitStreamEvent({ type: "error", sessionId, error: `ACP 종료 (code=${code}, signal=${signal})` });
  };

  client.on("messageChunk", onMessageChunk);
  client.on("thoughtChunk", onThoughtChunk);
  client.on("toolCall", onToolCall);
  client.on("toolCallUpdate", onToolCallUpdate);
  client.on("promptComplete", onPromptComplete);
  client.on("error", onError);
  client.on("exit", onExit);

  return (): void => {
    client.off("messageChunk", onMessageChunk);
    client.off("thoughtChunk", onThoughtChunk);
    client.off("toolCall", onToolCall);
    client.off("toolCallUpdate", onToolCallUpdate);
    client.off("promptComplete", onPromptComplete);
    client.off("error", onError);
    client.off("exit", onExit);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function extractMcpToolName(title: string): string | null {
  const mcpMatch = title.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) return mcpMatch[1];
  const toolMatch = title.match(/^Tool:\s*[^/]+\/(.+)$/);
  if (toolMatch) return toolMatch[1];
  const geminiMatch = title.match(/^(.+?)\s+\([^)]+\s+MCP Server\)$/);
  if (geminiMatch) return geminiMatch[1];
  return null;
}

function extractCallId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  return typeof obj.call_id === "string" ? obj.call_id : undefined;
}

function truncateMid(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const half = Math.floor((maxLen - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

function isGenericTitle(title: string): boolean {
  return GENERIC_TITLES.has(title);
}

function extractHintFromRawOutput(rawOutput: unknown, fallbackTitle: string): string | null {
  if (typeof rawOutput !== "string" || !rawOutput) return null;
  const firstLine = rawOutput.split("\n")[0]?.trim() ?? "";
  if (/^\d+\t/.test(firstLine)) return null;
  if (firstLine.startsWith("/")) {
    return `${fallbackTitle} ${firstLine.split("\n")[0].slice(0, 60)}`;
  }
  return null;
}
