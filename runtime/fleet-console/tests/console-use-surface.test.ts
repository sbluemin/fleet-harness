import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSOLE_CONTROL_TOOLS, type ConsoleUseMcpConnection } from "@fleet-console/sdk/mcp";
import { createConsoleControl } from "../core/host/mcp/console-control.js";
import { createConsoleUseMcpHost, type ConsoleSurface } from "../core/host/mcp/console-use.js";

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
      { id: "op-parent", title: "Parent", theaterId: "theater-a", type: "agent", pluginId: null, payload: { consoleUse: { enabled: true, language: "en" } } as Record<string, unknown>, geometry: null, ts: { createdAt: 1, updatedAt: 1 } },
      { id: "op-child", title: "Child", theaterId: "theater-a", type: "agent", pluginId: null, payload: { launchedBy: me } as Record<string, unknown>, geometry: null, ts: { createdAt: 2, updatedAt: 2 } },
      { id: "op-human", title: "Human's", theaterId: "theater-a", type: "agent", pluginId: null, payload: {} as Record<string, unknown>, geometry: null, ts: { createdAt: 3, updatedAt: 3 } },
    ];
    const answered: string[] = [];
    const surface: ConsoleSurface = {
      pendingAsks: (id) => id === "op-child" ? [{ id: "ask-q", form: "question", questions: [] }, { id: "ask-plan", form: "plan", questions: [] }] : id === "op-human" ? [{ id: "ask-h", form: "question", questions: [] }] : [],
      answer: (id, askId) => { answered.push(`${id}:${askId}`); return { ok: true, outcome: "answered" }; },
    };
    const deps = { enabled: () => true, directory, operations: () => operations, theaters: () => [{ id: "theater-a", name: "Project" }] };
    const control = createConsoleControl(deps);
    const host = createConsoleUseMcpHost({ ...deps, control, surface, experimentEnabled: () => true, language: () => "en" });
    let contributedCalls = 0;
    host.forPlugin("repository").contribute!([{ name: "console_repo_status", description: "status", inputSchema: { type: "object", properties: { theaterId: { type: "string" } }, required: ["theaterId"], additionalProperties: false }, execute: async () => { contributedCalls += 1; return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }; } }]);
    expect(() => host.forPlugin("other").contribute!([{ name: "console_launch", description: "x", inputSchema: { type: "object" }, execute: async () => ({}) }])).toThrow(/already registered/);
    connection = host.connect({ tools: CONSOLE_CONTROL_TOOLS, allowControl: true, operationCallers: true });
    const endpoint = (await connection.getEndpoint()).servers[0]!;
    const call = async (label: string, name: string, args: unknown) => {
      const token = connection!.issueSessionToken({ label, cwd: directory })[0]!;
      const response = await fetch(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const json = await response.json();
      connection!.releaseSessionToken(label);
      return JSON.parse(json.result.content[0].text);
    };
    // 남의 Operation 은 답하지 못하고, 자식이라도 계획 승인은 거부되며, 자식의 입력 질문만 통과한다.
    expect((await call("op-parent", "console_answer", { operationId: "op-human", askId: "ask-h", answers: ["yes"] })).error).toBe("not_launched_by_caller");
    expect((await call("op-parent", "console_answer", { operationId: "op-child", askId: "ask-plan", answers: ["yes"] })).error).toBe("unsupported_ask");
    expect(await call("op-parent", "console_answer", { operationId: "op-child", askId: "ask-q", answers: ["internal links only"] })).toMatchObject({ outcome: "answered" });
    expect(answered).toEqual(["op-child:ask-q"]);
    // 자기 자신은 닫지 못한다. 닫기 어댑터가 없으면 capability_unavailable 로 답한다.
    expect((await call("op-parent", "console_close", { operationId: "op-parent" })).error).toBe("cannot_close_self");
    expect((await call("op-parent", "console_close", { operationId: "op-child" })).error).toBe("capability_unavailable");
    // 플러그인이 실은 도구는 같은 게이트를 지난다: 허용된 호출자는 통과, 토글이 없는 호출자는 거부.
    expect(await call("op-parent", "console_repo_status", { theaterId: "theater-a" })).toMatchObject({ ok: true });
    expect((await call("op-human", "console_repo_status", { theaterId: "theater-a" })).error).toBe("console_use_not_authorized");
    expect(contributedCalls).toBe(1);
    // console_operation 은 자식의 열린 질문과 계보를 함께 싣는다.
    expect(await call("op-parent", "console_operation", { operationId: "op-child" })).toMatchObject({ launchedBy: me, asks: [{ id: "ask-q", form: "question" }, { id: "ask-plan", form: "plan" }] });
    control.dispose();
  });
});
