import { describe, expect, it } from "vitest";

import { describeError } from "../src/logging.js";

describe("describeError", () => {
  it("surfaces the child process exit code and stderr that carry the real failure", () => {
    const execError = Object.assign(new Error("Command failed"), { code: 127, stderr: "sh: node: command not found\n", stdout: "" });
    expect(describeError(execError)).toBe("Error: Command failed (code=127 stderr=sh: node: command not found)");
  });

  it("walks the cause chain so a masked error still exposes its origin", () => {
    const origin = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const masked = new Error("console_runtime_unavailable", { cause: origin });
    expect(describeError(masked)).toBe("Error: console_runtime_unavailable <- caused by: Error: ENOENT: no such file (code=ENOENT)");
  });

  it("stringifies non-Error values", () => {
    expect(describeError("boom")).toBe("boom");
  });
});
