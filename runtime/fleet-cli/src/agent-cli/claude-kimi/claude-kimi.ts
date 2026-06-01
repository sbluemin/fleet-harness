import { createClaudeFamilyCliDefinition } from "../claude/factory.js";

export const claudeKimiCli = createClaudeFamilyCliDefinition({
  authCli: "claude-kimi",
  id: "claude-kimi",
  label: "Claude Kimi",
});
