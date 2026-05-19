import { describe, it, beforeEach, expect } from "vitest";
import {
  list,
  invoke,
  registerAgentTool,
  registerFleetCoreDefaultAgentTools,
  registerExtraTools,
  unregisterExtraTools,
  clearAllDefaultTools,
  clearAllExtraTools,
} from "../../src/admiral/agent/tools.js";
import type { AgentToolSpec } from "@sbluemin/fleet-core";

const testSpec: AgentToolSpec = {
  id: "test_tool",
  tag: "test_tool",
  title: "Test Tool",
  description: "A test tool",
  promptSnippet: "test_tool — A test tool",
  whenToUse: [],
  whenNotToUse: [],
  usageGuidelines: [],
  parameters: {},
  async execute(args, _ctx) {
    return { content: [{ type: "text", text: `executed: ${JSON.stringify(args)}` }], isError: false };
  },
};

function listTestTools() {
  const BUILTIN_IDS = new Set(["carrier_dispatch", "carrier_jobs"]);
  return list().filter((spec) => !BUILTIN_IDS.has(spec.id));
}

describe("admiral.agent.tools", () => {
  beforeEach(() => {
    clearAllDefaultTools();
    clearAllExtraTools();
    registerFleetCoreDefaultAgentTools();
  });

  describe("list()", () => {
    it("빈 상태에서 기본 Fleet tool catalog만 반환한다", () => {
      expect(list().map((spec) => spec.id)).toContain("carrier_jobs");
      expect(listTestTools()).toHaveLength(0);
    });

    it("등록된 기본 도구의 스펙을 반환한다", () => {
      registerAgentTool(testSpec);
      const specs = listTestTools();
      expect(specs).toHaveLength(1);
      expect(specs[0]!.id).toBe("test_tool");
      expect(specs[0]!.title).toBe("Test Tool");
      expect(specs[0]!.description).toBe("A test tool");
    });
  });

  describe("invoke()", () => {
    it("기본 도구를 실행하고 McpCallToolResult를 반환한다", async () => {
      registerAgentTool(testSpec);
      const result = await invoke("test_tool", { key: "value" });
      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toContain("executed");
    });

    it("알 수 없는 도구는 isError=true를 반환한다", async () => {
      const result = await invoke("nonexistent", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Unknown tool");
    });

    it("기본 ctx가 cwd를 포함한다", async () => {
      let receivedCwd: string | undefined;
      const cwdSpec: AgentToolSpec = {
        id: "cwd_tool",
        tag: "cwd_tool",
        title: "CWD Checker",
        description: "cwd checker",
        promptSnippet: "cwd_tool — cwd checker",
        whenToUse: [],
        whenNotToUse: [],
        usageGuidelines: [],
        parameters: {},
        async execute(_args, ctx) {
          receivedCwd = ctx.cwd;
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
      };
      registerAgentTool(cwdSpec);
      await invoke("cwd_tool", {});
      expect(receivedCwd).toBe(process.cwd());
    });
  });

  describe("registerExtraTools / unregisterExtraTools", () => {
    it("스코프별 추가 도구를 등록하고 list에 포함된다", () => {
      const extraSpec: AgentToolSpec = {
        id: "extra_tool",
        tag: "extra_tool",
        title: "Extra Tool",
        description: "extra",
        promptSnippet: "extra_tool — extra",
        whenToUse: [],
        whenNotToUse: [],
        usageGuidelines: [],
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "extra" }], isError: false };
        },
      };
      registerExtraTools("scope1", [extraSpec]);
      expect(listTestTools()).toHaveLength(1);
      expect(listTestTools()[0]!.id).toBe("extra_tool");
    });

    it("추가 도구를 invoke로 실행할 수 있다", async () => {
      const extraSpec: AgentToolSpec = {
        id: "extra_invoke",
        tag: "extra_invoke",
        title: "Extra Invoke",
        description: "extra invoke",
        promptSnippet: "extra_invoke — extra invoke",
        whenToUse: [],
        whenNotToUse: [],
        usageGuidelines: [],
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "invoked extra" }], isError: false };
        },
      };
      registerExtraTools("scope1", [extraSpec]);
      const result = await invoke("extra_invoke", {});
      expect(result.content[0]!.text).toBe("invoked extra");
    });

    it("unregisterExtraTools로 특정 스코프 도구를 제거한다", () => {
      const spec1: AgentToolSpec = {
        id: "extra_a",
        tag: "extra_a",
        title: "Extra A",
        description: "a",
        promptSnippet: "extra_a — a",
        whenToUse: [],
        whenNotToUse: [],
        usageGuidelines: [],
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "a" }], isError: false };
        },
      };
      const spec2: AgentToolSpec = {
        id: "extra_b",
        tag: "extra_b",
        title: "Extra B",
        description: "b",
        promptSnippet: "extra_b — b",
        whenToUse: [],
        whenNotToUse: [],
        usageGuidelines: [],
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "b" }], isError: false };
        },
      };
      registerExtraTools("scope1", [spec1, spec2]);
      expect(listTestTools()).toHaveLength(2);

      unregisterExtraTools("scope1", ["extra_a"]);
      expect(listTestTools()).toHaveLength(1);
      expect(listTestTools()[0]!.id).toBe("extra_b");
    });

    it("모든 도구를 unregister하면 스코프가 자동 제거된다", () => {
      const spec: AgentToolSpec = {
        id: "auto_clean",
        tag: "auto_clean",
        title: "Auto Clean",
        description: "auto clean",
        promptSnippet: "auto_clean — auto clean",
        whenToUse: [],
        whenNotToUse: [],
        usageGuidelines: [],
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
      };
      registerExtraTools("scope1", [spec]);
      unregisterExtraTools("scope1", ["auto_clean"]);
      expect(listTestTools()).toHaveLength(0);
    });

    it("존재하지 않는 스코프의 unregister는 무시된다", () => {
      expect(() => unregisterExtraTools("nonexistent", ["anything"])).not.toThrow();
    });
  });

  describe("toMcpCallToolResult 변환", () => {
    it("문자열 결과를 McpCallToolResult로 변환한다", async () => {
      const strSpec: AgentToolSpec = {
        id: "str_tool",
        tag: "str_tool",
        title: "String Tool",
        description: "string returner",
        promptSnippet: "str_tool — string returner",
        whenToUse: [],
        whenNotToUse: [],
        usageGuidelines: [],
        parameters: {},
        async execute() {
          return "plain string result";
        },
      };
      registerAgentTool(strSpec);
      const result = await invoke("str_tool", {});
      expect(result.isError).toBe(false);
      expect(result.content[0]!.text).toBe("plain string result");
    });
  });
});
