import { describe, expect, it } from "vitest";

import { validateTarget, validateScope, validateSkill, validateSource } from "../server/validation.js";

describe("validateSource", () => {

  it.each([
    "-g",
    "--output=x",
    "/etc/passwd",
    "no-slash",
    "",
    "owner//repo",
    123,
    null,
    undefined,
  ])("rejects invalid source: %s", (s) => {
    expect(validateSource(s)).toBe(false);
  });
});

describe("validateSkill", () => {

  it.each([
    "-g",
    "--skill=foo",
    "UPPERCASE",
    "",
    "has space",
    123,
    null,
  ])("rejects invalid skill: %s", (s) => {
    expect(validateSkill(s)).toBe(false);
  });
});

describe("validateTarget", () => {

  it.each(["-g", "--agent", "vscode", "codex", "", null, 42])("rejects %s", (a) => {
    expect(validateTarget(a)).toBe(false);
  });
});

describe("validateScope", () => {
  it.each(["local", "", "-p", null])("rejects %s", (s) => {
    expect(validateScope(s)).toBe(false);
  });
});
