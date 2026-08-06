import { describe, expect, it } from "vitest";

import { withNodeSystemCa } from "../src/system-ca.js";

describe("Node system CA environment", () => {
  it("adds NODE_USE_SYSTEM_CA=1 when absent", () => {
    expect(withNodeSystemCa({})).toEqual({ NODE_USE_SYSTEM_CA: "1" });
  });

  it("preserves an explicitly configured value including 0", () => {
    expect(withNodeSystemCa({ NODE_USE_SYSTEM_CA: "0" })).toEqual({ NODE_USE_SYSTEM_CA: "0" });
  });

  it("treats a case-variant key as an explicit value (Windows env keys are case-insensitive)", () => {
    expect(withNodeSystemCa({ node_use_system_ca: "0" })).toEqual({ node_use_system_ca: "0" });
  });

  it("does not mutate the input environment", () => {
    const env = { PATH: "/bin" };

    const result = withNodeSystemCa(env);

    expect(result).not.toBe(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("preserves all other environment keys", () => {
    expect(withNodeSystemCa({ PATH: "/bin", CUSTOM: "value", UNDEFINED: undefined })).toEqual({
      PATH: "/bin",
      CUSTOM: "value",
      UNDEFINED: undefined,
      NODE_USE_SYSTEM_CA: "1",
    });
  });
});
