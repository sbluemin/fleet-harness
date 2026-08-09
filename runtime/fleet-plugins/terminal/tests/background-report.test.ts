import { describe, expect, it } from "vitest";

import { readBackgroundHookReport } from "../server/agent-api/background-report.js";

// 아래 payload는 Claude Code 2.1.224~2.1.226의 Stop·SubagentStop hook stdin을 실측해 옮긴 것이다.
const WORKFLOW_TASK = { id: "wxw9qo012", type: "workflow", status: "running", name: "ok-three" };

function hookInput(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function pendingOf(input: unknown, settledAgentIds?: ReadonlySet<string>): boolean | undefined {
  return readBackgroundHookReport(input, settledAgentIds).pending;
}

describe("background report", () => {
  it("keeps pending while a workflow outlives the turn, across one stop per workflow agent", () => {
    // Workflow 도구 1회 호출 = PreToolUse 1회지만 SubagentStop은 에이전트 수만큼 발화한다.
    // 워크플로우는 개별 에이전트가 아니라 항목 하나로 잡히므로 agent_id와 절대 겹치지 않는다.
    const turnEnd = hookInput({ hook_event_name: "Stop", background_tasks: [WORKFLOW_TASK] });
    expect(pendingOf(turnEnd)).toBe(true);

    let settled: ReadonlySet<string> | undefined;
    for (const agentId of ["a8dfa1f1776293c7f", "ac1789a75950c0c8c", "a2882fdee53416251"]) {
      const agentStop = hookInput({
        hook_event_name: "SubagentStop",
        agent_id: agentId,
        agent_type: "workflow-subagent",
        background_tasks: [WORKFLOW_TASK],
      });
      const report = readBackgroundHookReport(agentStop, settled);
      expect(report.pending).toBe(true);
      settled = report.settledAgentIds;
    }

    const afterWorkflow = hookInput({ hook_event_name: "Stop", background_tasks: [] });
    expect(pendingOf(afterWorkflow, settled)).toBe(false);
  });

  it("excludes the subagent that is stopping, because its own entry is still listed as live", () => {
    const soleAgentStop = hookInput({
      hook_event_name: "SubagentStop",
      agent_id: "ac485376e3437e69f",
      background_tasks: [{ id: "ac485376e3437e69f", type: "subagent", status: "running" }],
    });
    expect(pendingOf(soleAgentStop)).toBe(false);

    const siblingStillRunning = hookInput({
      hook_event_name: "SubagentStop",
      agent_id: "ac485376e3437e69f",
      background_tasks: [
        { id: "ac485376e3437e69f", type: "subagent", status: "running" },
        { id: "b1234567890abcdef", type: "subagent", status: "running" },
      ],
    });
    expect(pendingOf(siblingStillRunning)).toBe(true);
  });

  it("keeps a resident agent excluded on later turn ends, once its own stop has been reported", () => {
    // 이름 붙은 에이전트는 일을 마쳐도 다음 지시를 기다리며 세션에 남는다. payload에는 그 idle 표시가 없어서
    // 항목만 보면 여전히 running이다. 그 뒤 턴이 끝날 때마다 같은 항목을 살아 있는 작업으로 다시 읽으면
    // 유휴·입력 대기 전이가 통째로 막힌다.
    const resident = { id: "a5c0d92a34c49dcfe", type: "teammate", status: "running", description: "probe" };
    const teammateStop = readBackgroundHookReport(
      hookInput({ hook_event_name: "SubagentStop", agent_id: resident.id, background_tasks: [resident] }),
    );
    expect(teammateStop.pending).toBe(false);
    expect(teammateStop.settledAgentIds).toEqual(new Set([resident.id]));

    const turnEnd = hookInput({ hook_event_name: "Stop", background_tasks: [resident] });
    expect(pendingOf(turnEnd, teammateStop.settledAgentIds)).toBe(false);
    // 기억이 없으면 같은 payload가 거짓 백그라운드로 읽힌다 — 이 회귀가 막으려는 바로 그 상태다.
    expect(pendingOf(turnEnd)).toBe(true);

    // 상주 에이전트가 다시 일을 받는 것과 별개로, 새로 뜬 에이전트는 기억에 없으므로 정상적으로 잡힌다.
    const newAgent = hookInput({
      hook_event_name: "Stop",
      background_tasks: [resident, { id: "b77c0de1", type: "subagent", status: "running" }],
    });
    expect(pendingOf(newAgent, teammateStop.settledAgentIds)).toBe(true);
  });

  it("forgets a settled agent once the live task list no longer lists it", () => {
    // 기억이 세션이 사는 동안 무한히 쌓이면 안 된다. 목록을 전부 읽어낸 보고에서 사라진 id는 버린다.
    const stop = readBackgroundHookReport(
      hookInput({
        hook_event_name: "SubagentStop",
        agent_id: "a1",
        background_tasks: [{ id: "a1", type: "subagent", status: "running" }],
      }),
    );
    expect(stop.settledAgentIds).toEqual(new Set(["a1"]));

    const listEmptied = readBackgroundHookReport(hookInput({ hook_event_name: "Stop", background_tasks: [] }), stop.settledAgentIds);
    expect(listEmptied.pending).toBe(false);
    expect(listEmptied.settledAgentIds).toEqual(new Set());

    // 못 읽은 항목이 섞인 목록은 "사라졌다"의 근거가 될 수 없으므로 기억을 그대로 둔다.
    const partiallyUnreadable = readBackgroundHookReport(
      hookInput({ hook_event_name: "Stop", background_tasks: [WORKFLOW_TASK, null] }),
      stop.settledAgentIds,
    );
    expect(partiallyUnreadable.pending).toBe(true);
    expect(partiallyUnreadable.settledAgentIds).toEqual(new Set(["a1"]));
  });

  it("never reads an unrecognized task entry as proof that no work remains", () => {
    // 어휘가 드리프트해 항목 모양을 알아볼 수 없게 되면, 그것을 "남은 작업 없음"으로 접는 순간 거짓 유휴다.
    for (const entry of [null, "running", 7, ["wf-1"]]) {
      expect(pendingOf(hookInput({ background_tasks: [entry] }))).toBeUndefined();
    }
    // 남아 있음이 확인된 항목이 하나라도 있으면 답은 이미 정해진다 — 옆에 못 읽은 항목이 있어도 true를 잃지 않는다.
    expect(pendingOf(hookInput({ background_tasks: [WORKFLOW_TASK, null] }))).toBe(true);
    // 셸만 남은 목록은 알아본 결과가 "에이전트 작업 없음"이므로 그대로 해제한다.
    expect(pendingOf(hookInput({ background_tasks: [{ id: "s", type: "shell" }] }))).toBe(false);
  });

  it("stays opinionless when the live task list cannot be read", () => {
    for (const input of [undefined, "", "not json", "null"]) {
      const report = readBackgroundHookReport(input);
      expect(report.pending).toBeUndefined();
      expect(report.settledAgentIds).toBeUndefined();
    }
    expect(pendingOf(hookInput({ hook_event_name: "PreToolUse" }))).toBeUndefined();
    expect(pendingOf(hookInput({ background_tasks: "running" }))).toBeUndefined();
  });
});
