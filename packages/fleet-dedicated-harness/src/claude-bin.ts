import { execSync } from "node:child_process";

export function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) {
    return process.env.CLAUDE_BIN;
  }

  try {
    return execSync("which claude").toString().trim();
  } catch {
    throw new Error("claude binary not found");
  }
}
