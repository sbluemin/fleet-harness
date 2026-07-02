import { describe, expect, it } from "vitest";

import { validateAgent, validateScope, validateSkill, validateSource } from "../server/validation.js";

describe("validateSource", () => {
  it.each([
    "vercel-labs/geist",
    "owner/repo",
    "Owner123/Repo.skill",
    "A/b-c_d",
  ])("accepts valid source: %s", (s) => {
    expect(validateSource(s)).toBe(true);
  });

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
    "my-skill",
    "typescript",
    "react-hooks",
    "a",
    "skill.name",
  ])("accepts valid skill: %s", (s) => {
    expect(validateSkill(s)).toBe(true);
  });

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

describe("validateAgent", () => {
  it.each(["claude-code", "codex", "cursor", "opencode"])("accepts %s", (a) => {
    expect(validateAgent(a)).toBe(true);
  });

  it.each(["-g", "--agent", "vscode", "", null, 42])("rejects %s", (a) => {
    expect(validateAgent(a)).toBe(false);
  });
});

describe("validateScope", () => {
  it("accepts project", () => expect(validateScope("project")).toBe(true));
  it("accepts global", () => expect(validateScope("global")).toBe(true));
  it.each(["local", "", "-p", null])("rejects %s", (s) => {
    expect(validateScope(s)).toBe(false);
  });
});
