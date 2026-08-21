import { describe, expect, it } from "vitest";

import type { SkillListItem } from "../server/skill-types.js";
import { filterInstalled, namesInOtherScope } from "../client/installed-view.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

function skill(partial: Partial<SkillListItem> & Pick<SkillListItem, "name" | "scope">): SkillListItem {
  return {
    agents: ["Claude Code"],
    displayPath: `.agents/skills/${partial.name}`,
    ...partial,
  };
}

const ROSTER: SkillListItem[] = [
  skill({
    name: "console-e2e",
    scope: "project",
    description: "Drive a headless real-browser end-to-end test of the Fleet Console web UI.",
  }),
  skill({ name: "clean-code", scope: "project", description: "Diagnose over-abstraction in a package." }),
  skill({ name: "frontend-design", scope: "project" }),
  skill({ name: "frontend-design", scope: "global", source: "anthropics/skills" }),
  skill({ name: "agent-browser", scope: "global", description: "Browser automation CLI for AI agents." }),
];

// ─── filter ──────────────────────────────────────────────────────────────────

describe("filterInstalled", () => {
  const project = ROSTER.filter((s) => s.scope === "project");

  it("returns the scope untouched when the filter is blank", () => {
    expect(filterInstalled(project, "")).toBe(project);
    expect(filterInstalled(project, "   ")).toBe(project);
  });

  it("matches on the name", () => {
    expect(filterInstalled(project, "clean").map((s) => s.name)).toEqual(["clean-code"]);
  });

  it("matches on the description, so a word the name never says still finds the skill", () => {
    // 카드가 설명을 정체성으로 내세우는데 필터가 이름만 보면 그 약속이 깨진다.
    expect(filterInstalled(project, "browser").map((s) => s.name)).toEqual(["console-e2e"]);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(filterInstalled(project, "  HEADLESS ").map((s) => s.name)).toEqual(["console-e2e"]);
  });

  it("does not crash on a skill with no description", () => {
    expect(filterInstalled(project, "zzz")).toEqual([]);
  });
});

// ─── shadowing ───────────────────────────────────────────────────────────────

describe("namesInOtherScope", () => {
  it("names the twins from the opposite scope, from the roster already on the wire", () => {
    expect([...namesInOtherScope(ROSTER, "project")].sort())
      .toEqual(["agent-browser", "frontend-design"]);
    expect([...namesInOtherScope(ROSTER, "global")].sort())
      .toEqual(["clean-code", "console-e2e", "frontend-design"]);
  });

  it("marks the same skill from either side, so the pair is visible in both views", () => {
    expect(namesInOtherScope(ROSTER, "project").has("frontend-design")).toBe(true);
    expect(namesInOtherScope(ROSTER, "global").has("frontend-design")).toBe(true);
  });

  it("does not mark a skill installed in only one scope", () => {
    expect(namesInOtherScope(ROSTER, "project").has("clean-code")).toBe(false);
  });
});
