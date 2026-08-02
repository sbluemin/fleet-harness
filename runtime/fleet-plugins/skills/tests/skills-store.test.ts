import { describe, expect, it } from "vitest";

import type { SkillListItem } from "../server/skill-types.js";
import {
  getSkillsStateForTest,
  resetProjectContextState,
  resetSkillsStateForTest,
  setInstalledState,
  skillsContextKey,
} from "../client/skills-store.js";

const SKILL_A: SkillListItem = { name: "from-a", scope: "project", agents: [], displayPath: ".agents/skills/from-a" };
const SKILL_B: SkillListItem = { name: "from-b", scope: "project", agents: [], displayPath: ".agents/skills/from-b" };

describe("installed skills context state", () => {
  it("drops a late A response after context B has become active", () => {
    const contextA = skillsContextKey("theater-a");
    const contextB = skillsContextKey("theater-b");

    resetSkillsStateForTest();
    resetProjectContextState(contextA);
    setInstalledState(contextA, [], true);
    resetProjectContextState(contextB);
    setInstalledState(contextB, [], true);
    setInstalledState(contextB, [SKILL_B], false);
    setInstalledState(contextA, [SKILL_A], false);

    const state = getSkillsStateForTest();
    expect(state.installedContextKey).toBe(contextB);
    expect(state.installedList).toEqual([SKILL_B]);
    expect(state.installedLoading).toBe(false);
  });
});
