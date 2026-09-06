import { describe, expect, it } from "vitest";

describe("list DTO — 절대 경로 미포함 + displayPath 형식", () => {
  function buildDisplayPath(scope: "project" | "global", name: string): string {
    return scope === "global" ? `~/.agents/skills/${name}` : `.agents/skills/${name}`;
  }

  it("DTO item must not contain absolute path field", () => {
    const dto = {
      name: "typescript",
      scope: "project" as const,
      agents: ["claude-code"],
      displayPath: buildDisplayPath("project", "typescript"),
    };
    expect("path" in dto).toBe(false);
    expect(dto.displayPath.startsWith("/")).toBe(false);
    expect(dto.displayPath.startsWith("~")).toBe(false);
  });
});

describe("search DTO — 화이트리스트 외 필드 부재", () => {
  it("only id, name, source, installs are present", () => {
    const raw = {
      id: "abc",
      name: "typescript",
      source: "owner/repo",
      installs: 100,
      extraField: "should_be_removed",
      anotherField: 42,
    };

    const allowed = new Set(["id", "name", "source", "installs"]);
    const dto = Object.fromEntries(
      Object.entries(raw).filter(([k]) => allowed.has(k)),
    );

    expect(Object.keys(dto)).toEqual(expect.arrayContaining(["id", "name", "source", "installs"]));
    expect("extraField" in dto).toBe(false);
    expect("anotherField" in dto).toBe(false);
  });
});
