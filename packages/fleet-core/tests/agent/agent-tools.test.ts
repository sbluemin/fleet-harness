import { describe, it, beforeEach, expect } from "vitest";
import {
  list,
  invoke,
  registerDefaultTool,
  registerExtraTools,
  unregisterExtraTools,
  clearAllDefaultTools,
  clearAllExtraTools,
} from "../../src/admiral/agent/tools.js";
import type { AgentToolSpec } from "../../src/admiral/agent/types.js";

const testSpec: AgentToolSpec = {
  name: "test_tool",
  label: "Test Tool",
  description: "A test tool",
  parameters: {},
  async execute(args, _ctx) {
    return { content: [{ type: "text", text: `executed: ${JSON.stringify(args)}` }], isError: false };
  },
};

function listTestTools() {
  return list().filter((meta) => meta.name !== "carrier_jobs");
}

describe("admiral.agent.tools", () => {
  beforeEach(() => {
    clearAllDefaultTools();
    clearAllExtraTools();
  });

  describe("list()", () => {
    it("빈 상태에서 기본 Fleet tool catalog만 반환한다", () => {
      expect(list().map((meta) => meta.name)).toContain("carrier_jobs");
      expect(listTestTools()).toHaveLength(0);
    });

    it("등록된 기본 도구의 메타데이터를 반환한다", () => {
      registerDefaultTool(testSpec);
      const metas = listTestTools();
      expect(metas).toHaveLength(1);
      expect(metas[0]!.name).toBe("test_tool");
      expect(metas[0]!.label).toBe("Test Tool");
      expect(metas[0]!.description).toBe("A test tool");
    });
  });

  describe("invoke()", () => {
    it("기본 도구를 실행하고 McpCallToolResult를 반환한다", async () => {
      registerDefaultTool(testSpec);
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
        name: "cwd_tool",
        description: "cwd checker",
        parameters: {},
        async execute(_args, ctx) {
          receivedCwd = ctx.cwd;
          return { content: [{ type: "text", text: "ok" }], isError: false };
        },
      };
      registerDefaultTool(cwdSpec);
      await invoke("cwd_tool", {});
      expect(receivedCwd).toBe(process.cwd());
    });
  });

  describe("registerExtraTools / unregisterExtraTools", () => {
    it("스코프별 추가 도구를 등록하고 list에 포함된다", () => {
      const extraSpec: AgentToolSpec = {
        name: "extra_tool",
        description: "extra",
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "extra" }], isError: false };
        },
      };
      registerExtraTools("scope1", [extraSpec]);
      expect(listTestTools()).toHaveLength(1);
      expect(listTestTools()[0]!.name).toBe("extra_tool");
    });

    it("추가 도구를 invoke로 실행할 수 있다", async () => {
      const extraSpec: AgentToolSpec = {
        name: "extra_invoke",
        description: "extra invoke",
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
        name: "extra_a",
        description: "a",
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "a" }], isError: false };
        },
      };
      const spec2: AgentToolSpec = {
        name: "extra_b",
        description: "b",
        parameters: {},
        async execute() {
          return { content: [{ type: "text", text: "b" }], isError: false };
        },
      };
      registerExtraTools("scope1", [spec1, spec2]);
      expect(listTestTools()).toHaveLength(2);

      unregisterExtraTools("scope1", ["extra_a"]);
      expect(listTestTools()).toHaveLength(1);
      expect(listTestTools()[0]!.name).toBe("extra_b");
    });

    it("모든 도구를 unregister하면 스코프가 자동 제거된다", () => {
      const spec: AgentToolSpec = {
        name: "auto_clean",
        description: "auto clean",
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
        name: "str_tool",
        description: "string returner",
        parameters: {},
        async execute() {
          return "plain string result";
        },
      };
      registerDefaultTool(strSpec);
      const result = await invoke("str_tool", {});
      expect(result.isError).toBe(false);
      expect(result.content[0]!.text).toBe("plain string result");
    });
  });
});
