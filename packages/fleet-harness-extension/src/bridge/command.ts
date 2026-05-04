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
  if (context.effort) {
    args.push("--effort", shellQuote(context.effort));
  }
  return args.join(" ");
}

function buildCodexCommand(context: BridgeLaunchContext): string {
  const args = ["codex", "--full-auto"];
  if (context.sessionId) {
    args.push("resume", shellQuote(context.sessionId));
  }
  if (context.model) {
    args.push("-m", shellQuote(context.model));
  }
  if (context.effort) {
    args.push("-c", shellQuote(`model_reasoning_effort="${context.effort}"`));
  }
  const command = args.join(" ");
  if (!context.sessionId) {
    return command;
  }
  return `${buildCodexArchivedSessionRestoreCommand(context.sessionId)}; ${command}`;
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

function buildCodexArchivedSessionRestoreCommand(sessionId: string): string {
  const quotedPattern = shellQuote(`rollout-*-${sessionId}.jsonl`);
  return [
    "__fleet_codex_archived=$(find \"$HOME/.codex/archived_sessions\" -maxdepth 1 -name " + quotedPattern + " -print -quit 2>/dev/null)",
    "if [ -n \"$__fleet_codex_archived\" ]; then",
    "  __fleet_codex_base=$(basename \"$__fleet_codex_archived\")",
    "  __fleet_codex_date=${__fleet_codex_base#rollout-}",
    "  __fleet_codex_date=${__fleet_codex_date%%T*}",
    "  __fleet_codex_year=${__fleet_codex_date%%-*}",
    "  __fleet_codex_month_day=${__fleet_codex_date#*-}",
    "  __fleet_codex_month=${__fleet_codex_month_day%%-*}",
    "  __fleet_codex_day=${__fleet_codex_month_day#*-}",
    "  __fleet_codex_target=\"$HOME/.codex/sessions/$__fleet_codex_year/$__fleet_codex_month/$__fleet_codex_day/$__fleet_codex_base\"",
    "  [ -e \"$__fleet_codex_target\" ] || { mkdir -p \"$(dirname \"$__fleet_codex_target\")\" && cp \"$__fleet_codex_archived\" \"$__fleet_codex_target\"; }",
    "fi",
    "unset __fleet_codex_archived __fleet_codex_base __fleet_codex_date __fleet_codex_year __fleet_codex_month_day __fleet_codex_month __fleet_codex_day __fleet_codex_target",
  ].join("; ");
}
