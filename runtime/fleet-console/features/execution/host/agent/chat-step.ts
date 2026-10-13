import { AGENT_CHAT_ASK_TOOLS, type AgentChatStreamEvent } from "./chat-events.js";
import type { AgentWorkStep } from "./types.js";

/**
 * Chat 세션이 지금 하는 일의 계열 — 세션 스냅샷의 `step` 으로 실려 사이드바·패널의 몽글 아바타가 활동별로 연기한다.
 *
 * 채팅 소켓은 그 본문이 열려 있을 때만 붙으므로, 여러 Operation 을 함께 보는 표면은 이 값을 세션 스트림으로만 받는다.
 * 도구마다 프레임을 늘리지 않게 계열이 바뀔 때만, 최소 간격을 두고 마지막 값 하나만 보낸다. 표시 쪽이 한 활동에 최소 시간
 * 머무르므로, 그보다 짧게 스친 계열은 보내지 않아도 화면이 잃는 것이 없다.
 *
 * 생각 중에는 이벤트가 없다(thinking 블록은 버린다). 그래서 도구도 글자도 흐르지 않는 공백이 1초를 넘으면 생각으로 본다.
 * 도구가 도는 동안의 공백은 그 도구의 것이다.
 */

/** 이름으로 계열이 정해지는 도구. 표에 없는 내장 도구는 모른다(null) — 기본 리듬으로 움직인다. */
const TOOL_STEPS: Readonly<Record<string, AgentWorkStep>> = {
  Read: "read",
  NotebookRead: "read",
  Glob: "read",
  Grep: "read",
  Skill: "read",
  ToolSearch: "read",
  ListMcpResourcesTool: "read",
  // 배경 작업의 출력을 들여다보는 호출은 실행이 아니라 읽기다.
  BashOutput: "read",
  TaskOutput: "read",
  Monitor: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "edit",
  TodoWrite: "edit",
  Artifact: "edit",
  Bash: "run",
  Workflow: "run",
  WebFetch: "fetch",
  WebSearch: "fetch",
  ReadMcpResourceTool: "fetch",
  Agent: "delegate",
  Task: "delegate",
  ListAgents: "delegate",
  SendMessage: "text",
};

export function agentWorkStepOfTool(name: string): AgentWorkStep | null {
  // MCP 호출은 바깥 도구다 — 웹과 같은 연기를 쓴다.
  if (name.startsWith("mcp__")) return "fetch";
  return TOOL_STEPS[name] ?? null;
}

export const CHAT_STEP_THINK_AFTER_MS = 1_000;
export const CHAT_STEP_MIN_INTERVAL_MS = 500;

export interface ChatStepReporter {
  /** 열린 턴 안에서 흐른 이벤트 하나를 본다. */
  observe(event: AgentChatStreamEvent): void;
  /** 턴이 열렸다 — 모델이 첫 출력을 내기 전의 공백도 생각이다. */
  turnOpened(): void;
  /** 턴이 닫혔다. 축은 턴 종료 보고와 함께 계열을 지우므로 여기서는 보내지 않고 기억만 비운다. */
  turnClosed(): void;
  dispose(): void;
}

export function createChatStepReporter(report: (step: AgentWorkStep | null) => void, now: () => number = Date.now): ChatStepReporter {
  const inFlight = new Set<string>();
  let desired: AgentWorkStep | null = null;
  let sent: AgentWorkStep | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let open = false;
  let thinkTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearThink = () => {
    if (thinkTimer !== null) clearTimeout(thinkTimer);
    thinkTimer = null;
  };
  const clearFlush = () => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
  };
  const flush = () => {
    flushTimer = null;
    if (!open || desired === sent) return;
    sent = desired;
    sentAt = now();
    report(sent);
  };
  const want = (step: AgentWorkStep | null) => {
    desired = step;
    if (desired === sent) {
      clearFlush();
      return;
    }
    if (flushTimer !== null) return;
    const wait = sentAt + CHAT_STEP_MIN_INTERVAL_MS - now();
    if (wait <= 0) flush();
    else {
      flushTimer = setTimeout(flush, wait);
      flushTimer.unref?.();
    }
  };
  const armThink = () => {
    clearThink();
    if (inFlight.size > 0) return;
    thinkTimer = setTimeout(() => {
      thinkTimer = null;
      if (open && inFlight.size === 0) want("think");
    }, CHAT_STEP_THINK_AFTER_MS);
    thinkTimer.unref?.();
  };
  const reset = () => {
    clearThink();
    clearFlush();
    inFlight.clear();
    desired = null;
    sent = null;
  };

  return {
    observe(event) {
      if (!open) return;
      switch (event.kind) {
        case "tool":
        case "tool-start": {
          // 질문·계획 카드는 대기 상태가 말한다 — 활동을 바꾸지 않는다.
          if (AGENT_CHAT_ASK_TOOLS.has(event.name)) return;
          clearThink();
          if (event.id !== undefined) inFlight.add(event.id);
          want(agentWorkStepOfTool(event.name));
          return;
        }
        case "tool-result":
          inFlight.delete(event.id);
          armThink();
          return;
        case "text-delta":
          if (inFlight.size === 0) want("text");
          armThink();
          return;
        case "command-progress":
          clearThink();
          want("compact");
          return;
        case "request-start":
          armThink();
          return;
        default:
          return;
      }
    },
    turnOpened() {
      reset();
      open = true;
      armThink();
    },
    turnClosed() {
      open = false;
      reset();
    },
    dispose() {
      open = false;
      reset();
    },
  };
}
