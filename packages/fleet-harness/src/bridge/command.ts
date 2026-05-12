import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getEffort } from "@sbluemin/fleet-unified-agent";
import type { BridgeCommandSpec, BridgeLaunchContext } from "./types.js";
import { BRIDGE_TITLE_PREFIX } from "./types.js";

export function buildBridgeCommand(context: BridgeLaunchContext): BridgeCommandSpec {
  switch (context.cli) {
    case "claude":
    case "claude-zai":
    case "claude-kimi":
      return {
        command: buildClaudeCommand(context),
        cwd: context.cwd,
        title: `${BRIDGE_TITLE_PREFIX} · ${getBridgeTitle(context.cli)}`,
      };
    case "codex":
      return {
        command: buildCodexCommand(context),
        cwd: context.cwd,
        title: `${BRIDGE_TITLE_PREFIX} · Codex`,
      };
    case "gemini":
      return {
        command: buildGeminiCommand(context),
        cwd: context.cwd,
        title: `${BRIDGE_TITLE_PREFIX} · Gemini`,
      };
    case "opencode-go":
      return {
        command: buildOpenCodeCommand(context),
        cwd: context.cwd,
        title: `${BRIDGE_TITLE_PREFIX} · OpenCode Go`,
      };
    case "cursor":
      throw new Error("Cursor 백엔드는 Bridge(Alt+T) 셸 진입을 지원하지 않습니다.");
  }
}

function getBridgeTitle(cli: BridgeLaunchContext["cli"]): string {
  switch (cli) {
    case "claude":
      return "Claude";
    case "claude-zai":
      return "Claude ZAI";
    case "claude-kimi":
      return "Claude Kimi";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    case "opencode-go":
      return "OpenCode Go";
    case "cursor":
      throw new Error("Cursor 백엔드는 Bridge(Alt+T) 셸 진입을 지원하지 않습니다.");
  }
}

function buildClaudeCommand(context: BridgeLaunchContext): string {
  const args = ["claude", "--dangerously-skip-permissions"];
  if (context.sessionId) {
    args.push("--resume", shellQuote(context.sessionId));
  }
  if (context.model) {
    args.push("--model", shellQuote(context.model));
  }
  if (shouldPassBridgeEffort(context)) {
    args.push("--effort", shellQuote(context.effort));
  }
  return args.join(" ");
}

function buildCodexCommand(context: BridgeLaunchContext): string {
  const args = ["codex", "--dangerously-bypass-approvals-and-sandbox"];
  if (context.sessionId) {
    args.push("resume", shellQuote(context.sessionId));
  }
  if (context.model) {
    args.push("-m", shellQuote(context.model));
  }
  if (shouldPassBridgeEffort(context)) {
    args.push("-c", shellQuote(`model_reasoning_effort="${context.effort}"`));
  }
  return args.join(" ");
}

// codex resume이 archived_sessions 아래에 보관된 jsonl을 찾지 못하므로,
// 실제 launch 직전에 active sessions 트리로 복원해 둔다.
// 셸 스크립트로 처리하면 bash-only parameter expansion(`${var#pattern}`, `${var%%pattern}`)이
// 환경에 따라 syntax error를 일으키므로 Node에서 직접 수행한다.
export function restoreCodexArchivedSession(sessionId: string): void {
  const home = homedir();
  const archiveDir = join(home, ".codex", "archived_sessions");
  if (!existsSync(archiveDir)) {
    return;
  }

  const suffix = `-${sessionId}.jsonl`;
  let archivedName: string | null = null;
  try {
    for (const entry of readdirSync(archiveDir)) {
      if (entry.startsWith("rollout-") && entry.endsWith(suffix)) {
        archivedName = entry;
        break;
      }
    }
  } catch {
    return;
  }
  if (!archivedName) {
    return;
  }

  const dateMatch = archivedName.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!dateMatch) {
    return;
  }
  const [, year, month, day] = dateMatch;

  const target = join(home, ".codex", "sessions", year, month, day, archivedName);
  if (existsSync(target)) {
    return;
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(archiveDir, archivedName), target);
  } catch {
    // 복원 실패는 무시 — codex resume이 직접 보고하도록 위임
  }
}

function buildGeminiCommand(context: BridgeLaunchContext): string {
  const args = ["gemini", "--yolo"];
  if (context.sessionId) {
    args.push("--resume", shellQuote(context.sessionId));
  }
  if (context.model) {
    args.push("--model", shellQuote(context.model));
  }
  return args.join(" ");
}

function buildOpenCodeCommand(context: BridgeLaunchContext): string {
  const args = ["opencode"];
  if (context.sessionId) {
    args.push("--session", shellQuote(context.sessionId));
  }
  if (context.model) {
    args.push("--model", shellQuote(context.model));
  }
  return args.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shouldPassBridgeEffort(context: BridgeLaunchContext): context is BridgeLaunchContext & { effort: string } {
  if (!context.effort) return false;
  const modelEffort = getModelEffort(context.cli, context.model);
  return modelEffort.supported && (modelEffort.levels?.includes(context.effort) ?? false);
}

function getModelEffort(
  cli: BridgeLaunchContext["cli"],
  modelId: string,
): ReturnType<typeof getEffort> {
  return getEffort(cli, modelId);
}
