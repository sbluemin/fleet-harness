import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsoleUseMcpConnection } from "@fleet-console/sdk/mcp";
import { defineConsoleTool } from "@fleet-console/sdk/mcp/actions";
import { z } from "zod";
import { createConsoleControl } from "../features/console-use/host/console-control.js";
import { createConsoleUseMcpHost, type ConsoleUseActions } from "../features/console-use/host/console-use.js";

let connection: ConsoleUseMcpConnection | undefined;

afterEach(async () => {
  await connection?.dispose();
  connection = undefined;
});

/**
 * 확장면의 권한 경계 — 자식이 아닌 Operation 의 질문에는 답하지 못하고, 계획 승인은 형식으로 거부되며,
 * 플러그인이 실은 도구도 호스트 도구와 같은 게이트를 지난다. 다른 도구는 같은 래퍼를 타므로 대표 사례만 둔다.
 */
describe("Console Use surface boundaries", () => {
  it("answers only input questions of Operations the caller launched, and gates contributed tools alike", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "console-surface-"));
    const me = { kind: "operation" as const, operationId: "op-parent" };
    const operations = [
      { id: "op-parent", title: "Parent", theaterId: "theater-a", type: "agent", pluginId: null, payload: { consoleUse: { enabled: true, language: "en" } } as Record<string, unknown>, childSessions: [{ id: "op-member", payload: { session: { sessionName: "objective-member-1" } }, ts: { createdAt: 4, updatedAt: 4 } }], geometry: null, ts: { createdAt: 1, updatedAt: 1 } },
      { id: "op-child", title: "Child", theaterId: "theater-a", type: "agent", pluginId: null, payload: { launchedBy: me } as Record<string, unknown>, geometry: null, ts: { createdAt: 2, updatedAt: 2 } },
      { id: "op-human", title: "Human's", theaterId: "theater-a", type: "agent", pluginId: null, payload: {} as Record<string, unknown>, geometry: null, ts: { createdAt: 3, updatedAt: 3 } },
    ];
    const answered: string[] = [];
    const slept: string[] = [];
    const surface: ConsoleUseActions = {
      pendingAsks: (id) => id === "op-child" ? [{ id: "ask-q", form: "question", questions: [] }, { id: "ask-plan", form: "plan", questions: [] }] : id === "op-human" ? [{ id: "ask-h", form: "question", questions: [] }] : [],
      answer: (id, askId) => { answered.push(`${id}:${askId}`); return { ok: true, outcome: "answered" }; },
      sleep: async (id) => { slept.push(id); return { ok: true, lifecycle: "dormant" }; },
    };
    const deps = { directory, operations: () => operations, resolveOperation: (id: string) => operations.find((op) => op.id === id) ?? (id === "op-member" ? { id, title: "objective-member-1", theaterId: "theater-a", type: "agent", pluginId: null, parentOperationId: "op-parent", payload: operations[0]!.childSessions![0]!.payload, geometry: null, ts: operations[0]!.childSessions![0]!.ts } : null), theaters: () => [{ id: "theater-a", name: "Project" }] };
    const control = createConsoleControl(deps);
    // 관측: 자식은 도는 중, 사람의 것은 유휴 터미널. 휴면은 프로세스를 죽이므로 유휴 터미널만 통과한다.
    // 부모(호출자)는 쉬고 그 구성원이 입력을 기다린다 — 스캔에서는 부모 행이 구성원의 대기를 대표해야 한다.
    const observation = (activity: "running" | "idle" | "awaiting") => ({ activity, lifecycle: "live" as const, observedAt: new Date().toISOString(), source: "host" as const, attention: { kind: activity === "awaiting" ? "input" as const : "none" as const }, surface: "terminal" as const, supportedActions: [], output: { status: "unavailable" as const, outcome: "unknown" as const } });
    control.attach({ observe: (id) => id === "op-child" ? observation("running") : id === "op-human" ? observation("idle") : id === "op-parent" ? observation("idle") : id === "op-member" ? observation("awaiting") : null, execute: async () => { throw new Error("not used"); } });
    let contributedCalls = 0;
    const calls: unknown[] = [];
    const hostWithCalls = createConsoleUseMcpHost({ ...deps, control, surface, language: () => "en", onCall: (event) => calls.push(event) });
    const repoSurface = { panelId: "repository", describe: (args: Record<string, unknown>) => ({ theaterId: String(args.theaterId), summary: "저장소 상태 봄", view: String(args.action) }) };
    const repository = (name: string) => defineConsoleTool({ name, description: "Repository panel.", actions: { status: { kind: "read", input: z.object({ theaterId: z.string() }) }, log: { kind: "read", input: z.object({ theaterId: z.string(), limit: z.number().int().max(100).optional() }) } } });
    const releaseContribution = hostWithCalls.forPlugin("repository").contribute!([repository("console_repository").plugin({ surface: repoSurface, execute: async () => { contributedCalls += 1; return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }; } })]);
    // 자리(레일 패널)·action 선언이 없거나, 화면 이름 규칙을 어기거나, 기본 도구·이미 기여된 이름과 겹치는 기여는 등록 자체가 실패한다.
    const noop = async () => ({});
    expect(() => hostWithCalls.forPlugin("other").contribute!([{ name: "console_x", description: "x", inputSchema: { type: "object" }, execute: noop }])).toThrow(/declare its panel/);
    expect(() => hostWithCalls.forPlugin("other").contribute!([{ name: "console_x", description: "x", inputSchema: { type: "object", properties: { view: { type: "string" } } }, surface: repoSurface, execute: noop }])).toThrow(/declare its actions/);
    expect(() => hostWithCalls.forPlugin("other").contribute!([{ ...repository("console_repository").plugin({ surface: repoSurface, execute: noop }), name: "console_repo_view_x" }])).toThrow(/Invalid Console Use tool name/);
    expect(() => hostWithCalls.forPlugin("other").contribute!([repository("console_launcher").plugin({ surface: repoSurface, execute: noop })])).toThrow(/already registered/);
    // 설명은 매 요청 모든 연결에 실린다 — 한도를 넘는 도구·필드 설명은 정의 단계에서 막는다.
    expect(() => defineConsoleTool({ name: "console_x", description: "x".repeat(201), kind: "read", input: z.object({}) })).toThrow(/description exceeds/);
    expect(() => defineConsoleTool({ name: "console_x", description: "x", kind: "read", input: z.object({ field: z.string().describe("x".repeat(121)) }) })).toThrow(/field description exceeds/);
    expect(() => hostWithCalls.forPlugin("other").contribute!([repository("console_repository").plugin({ surface: repoSurface, execute: noop })])).toThrow(/already registered/);
    connection = hostWithCalls.connect({ allowControl: true, operationCallers: true });
    const endpoint = (await connection.getEndpoint()).servers[0]!;
    const call = async (label: string, name: string, args: unknown) => {
      const token = connection!.issueSessionToken({ label, cwd: directory })[0]!;
      const response = await fetch(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const json = await response.json();
      connection!.releaseSessionToken(label);
      return JSON.parse(json.result.content[0].text);
    };
    // 남의 Operation 은 답하지 못하고, 자식이라도 계획 승인은 거부되며, 자식의 입력 질문만 통과한다.
    expect((await call("op-parent", "console_operation", { action: "answer", operationId: "op-human", askId: "ask-h", answers: ["yes"] })).error).toBe("not_launched_by_caller");
    expect((await call("op-parent", "console_operation", { action: "answer", operationId: "op-child", askId: "ask-plan", answers: ["yes"] })).error).toBe("unsupported_ask");
    expect(await call("op-parent", "console_operation", { action: "answer", operationId: "op-child", askId: "ask-q", answers: ["internal links only"] })).toMatchObject({ outcome: "answered" });
    expect(answered).toEqual(["op-child:ask-q"]);
    // 한 호출은 한 제스처다 — 답(answer)에 보낼 말(text)을 함께 싣지 못한다.
    expect((await call("op-parent", "console_operation", { action: "answer", operationId: "op-child", askId: "ask-q", answers: ["yes"], text: "and this" })).error).toBe("invalid_arguments");
    // 자기 자신은 닫지 못한다. 닫기 어댑터가 없으면 capability_unavailable 로 답한다.
    expect((await call("op-parent", "console_operation", { action: "close", operationId: "op-parent" })).error).toBe("cannot_close_self");
    expect((await call("op-parent", "console_operation", { action: "close", operationId: "op-child" })).error).toBe("capability_unavailable");
    // 휴면은 프로세스를 끝내는 일이다 — 자기 자신과 도는 중인 Operation 은 거절하고, 유휴 터미널만 재개 가능한 휴면으로 보낸다.
    expect((await call("op-parent", "console_operation", { action: "sleep", operationId: "op-parent" })).error).toBe("cannot_sleep_self");
    expect((await call("op-parent", "console_operation", { action: "sleep", operationId: "op-child" })).error).toBe("not_idle");
    expect(await call("op-parent", "console_operation", { action: "sleep", operationId: "op-human" })).toMatchObject({ action: "sleep", lifecycle: "dormant" });
    expect(slept).toEqual(["op-human"]);
    // 플러그인이 실은 도구는 같은 게이트를 지난다: 허용된 호출자는 통과, 토글이 없는 호출자는 거부.
    expect(await call("op-parent", "console_repository", { action: "status", theaterId: "theater-a" })).toMatchObject({ ok: true });
    expect((await call("op-human", "console_repository", { action: "status", theaterId: "theater-a" })).error).toBe("console_use_not_authorized");
    // 기여 도구도 action 별 strict — 다른 action 의 필드는 플러그인에 닿기 전에 거절된다.
    expect((await call("op-parent", "console_repository", { action: "status", theaterId: "theater-a", limit: 5 })).error).toBe("invalid_arguments");
    expect(contributedCalls).toBe(1);
    // 호출은 제스처 사건을 남긴다 — 답한 것(press, 대상 Operation)과 기여 도구(gaze, 레일 패널). 내용은 싣지 않는다.
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "console_operation", gesture: "press", caller: me, target: { kind: "operation", operationId: "op-child" } }),
      expect.objectContaining({ tool: "console_repository", gesture: "gaze", caller: me, target: { kind: "panel", panelId: "repository", theaterId: "theater-a", view: "status" } }),
    ]));
    expect(JSON.stringify(calls)).not.toContain("internal links only");
    // 등록 해제(플러그인 롤백)된 기여는 이미 실린 레지스트리에서도 답하지 않는다.
    releaseContribution();
    expect((await call("op-parent", "console_repository", { action: "status", theaterId: "theater-a" })).error).toBe("plugin_tool_unavailable");
    expect(contributedCalls).toBe(1);
    // 구성원은 스캔의 기본 목록에서 빠지고(부관·Admiral 이 평범한 행으로 보지 않는다) nested 로 물을 때만 부모와 함께 선다.
    expect((await call("op-parent", "console_sidebar", { action: "list" })).operations.map((row: { id: string }) => row.id)).toEqual(["op-child", "op-human", "op-parent"]);
    expect((await call("op-parent", "console_sidebar", { action: "list", nested: true })).operations).toEqual(expect.arrayContaining([expect.objectContaining({ id: "op-member", title: "objective-member-1", parentOperationId: "op-parent", activity: "awaiting" })]));
    expect(await call("op-parent", "console_operation", { action: "summary", operationId: "op-member" })).toMatchObject({ id: "op-member", parentOperationId: "op-parent", activity: "awaiting" });
    // 기본 스캔의 부모 행은 구성원의 대기를 대표한다 — 사이드바처럼 「누가 기다리나」 스캔이 비지 않는다.
    expect((await call("op-parent", "console_sidebar", { action: "list", activity: "awaiting" })).operations).toEqual([expect.objectContaining({ id: "op-parent", activity: "awaiting", attention: { kind: "input" } })]);
    // console_operation 은 자식의 열린 질문과 계보를 함께 싣는다.
    expect(await call("op-parent", "console_operation", { action: "summary", operationId: "op-child" })).toMatchObject({ launchedBy: me, asks: [{ id: "ask-q", form: "question" }, { id: "ask-plan", form: "plan" }] });
    control.dispose();
  });
});
