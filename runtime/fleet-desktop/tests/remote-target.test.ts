import { describe, expect, it } from "vitest";

import { parseSshTarget } from "../src/runtime/remote/contracts.js";

describe("SSH target parsing", () => {
  it("accepts only the fixed host or user@host grammar", () => {
    expect(parseSshTarget("devbox")).toEqual({ value: "devbox", user: null, host: "devbox" });
    expect(parseSshTarget("dev.user@host-name_1")).toEqual({ value: "dev.user@host-name_1", user: "dev.user", host: "host-name_1" });
  });
  it("rejects whitespace, controls, leading options, and shell syntax", () => {
    for (const target of ["", "-host", "user@-host", "host name", "host\nname", "host\u0000name", "user@@host", "host;id", "$(id)"]) {
      expect(() => parseSshTarget(target)).toThrow("pairing_target_invalid");
    }
  });
});
