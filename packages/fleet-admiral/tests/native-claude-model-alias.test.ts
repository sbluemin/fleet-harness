import { describe, expect, it } from "vitest";

import {
  NATIVE_CLAUDE_MODEL_ALIASES,
  resolveNativeClaudeModelAlias,
} from "../src/index.js";

describe("resolveNativeClaudeModelAlias", () => {
  it("keeps the Console-native Claude aliases as Claude Code launch ids", () => {
    expect(NATIVE_CLAUDE_MODEL_ALIASES).toEqual(["fable[1m]", "opus[1m]", "sonnet"]);
    expect(resolveNativeClaudeModelAlias("fable[1m]")).toBe("fable[1m]");
    expect(resolveNativeClaudeModelAlias("opus[1m]")).toBe("opus[1m]");
    expect(resolveNativeClaudeModelAlias("sonnet")).toBe("sonnet");
  });

  it("rewrites bare menu aliases onto Claude Code's 1M coordinates", () => {
    expect(resolveNativeClaudeModelAlias("fable")).toBe("fable[1m]");
    expect(resolveNativeClaudeModelAlias("opus")).toBe("opus[1m]");
  });

  it("rejects unrecognized aliases", () => {
    expect(resolveNativeClaudeModelAlias("haiku")).toBeUndefined();
    expect(resolveNativeClaudeModelAlias("cursor--claude-opus-5")).toBeUndefined();
  });
});
