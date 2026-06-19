import { createClaudeFamilyCliDefinition } from "../claude/factory.js";

export const claudeGlmCli = createClaudeFamilyCliDefinition({
  authCli: "claude-glm",
  id: "claude-glm",
  label: "Claude GLM",
});
