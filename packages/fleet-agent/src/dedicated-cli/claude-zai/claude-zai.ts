import { createClaudeFamilyCliDefinition } from "../claude/factory.js";

export const claudeZaiCli = createClaudeFamilyCliDefinition({
  authCli: "claude-zai",
  id: "claude-zai",
  label: "Claude Z.AI",
});
