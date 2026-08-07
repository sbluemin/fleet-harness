import { describe, expect, it } from "vitest";

import { resolveBackgroundPendingFromHookInput } from "../server/agent-api/background-report.js";

// 아래 payload는 Claude Code 2.1.224의 Stop·SubagentStop hook stdin을 실측해 옮긴 것이다.
const WORKFLOW_TASK = { id: "wxw9qo012", type: "workflow", status: "running", name: "ok-three" };

function hookInput(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("background report", () => {
  it("keeps pending while a workflow outlives the turn, across one stop per workflow agent", () => {
    // Workflow 도구 1회 호출 = PreToolUse 1회지만 SubagentStop은 에이전트 수만큼 발화한다.
    // 워크플로우는 개별 에이전트가 아니라 항목 하나로 잡히므로 agent_id와 절대 겹치지 않는다.
    const turnEnd = hookInput({ hook_event_name: "Stop", background_tasks: [WORKFLOW_TASK] });
    expect(resolveBackgroundPendingFromHookInput(turnEnd)).toBe(true);

    for (const agentId of ["a8dfa1f1776293c7f", "ac1789a75950c0c8c", "a2882fdee53416251"]) {
      const agentStop = hookInput({
        hook_event_name: "SubagentStop",
        agent_id: agentId,
        agent_type: "workflow-subagent",
        background_tasks: [WORKFLOW_TASK],
      });
      expect(resolveBackgroundPendingFromHookInput(agentStop)).toBe(true);
    }

    const afterWorkflow = hookInput({ hook_event_name: "Stop", background_tasks: [] });
    expect(resolveBackgroundPendingFromHookInput(afterWorkflow)).toBe(false);
  });

  it("excludes the subagent that is stopping, because its own entry is still listed as live", () => {
    const soleAgentStop = hookInput({
      hook_event_name: "SubagentStop",
      agent_id: "ac485376e3437e69f",
      background_tasks: [{ id: "ac485376e3437e69f", type: "subagent", status: "running" }],
    });
    expect(resolveBackgroundPendingFromHookInput(soleAgentStop)).toBe(false);

    const siblingStillRunning = hookInput({
      hook_event_name: "SubagentStop",
      agent_id: "ac485376e3437e69f",
      background_tasks: [
        { id: "ac485376e3437e69f", type: "subagent", status: "running" },
        { id: "b1234567890abcdef", type: "subagent", status: "running" },
      ],
    });
    expect(resolveBackgroundPendingFromHookInput(siblingStillRunning)).toBe(true);
  });

  it("leaves shell background tasks out of the agent background axis", () => {
    const shellOnly = hookInput({
      hook_event_name: "Stop",
      background_tasks: [{ id: "bufmg7ciq", type: "shell", status: "running", command: "sleep 25" }],
    });
    expect(resolveBackgroundPendingFromHookInput(shellOnly)).toBe(false);
  });

  it("stays opinionless when the live task list cannot be read", () => {
    expect(resolveBackgroundPendingFromHookInput(undefined)).toBeUndefined();
    expect(resolveBackgroundPendingFromHookInput("")).toBeUndefined();
    expect(resolveBackgroundPendingFromHookInput("not json")).toBeUndefined();
    expect(resolveBackgroundPendingFromHookInput("null")).toBeUndefined();
    expect(resolveBackgroundPendingFromHookInput(hookInput({ hook_event_name: "PreToolUse" }))).toBeUndefined();
    expect(resolveBackgroundPendingFromHookInput(hookInput({ background_tasks: "running" }))).toBeUndefined();
  });
});
