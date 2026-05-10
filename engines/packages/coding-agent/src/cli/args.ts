/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@sbluemin/fleet-agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.js";
import type { ExtensionFlag } from "../core/extensions/types.js";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	// TODO: 추후 작업 예정 — --provider, --model, --api-key, --system-prompt, --append-system-prompt, --thinking 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
	// provider?: string;
	// model?: string;
	// apiKey?: string;
	// systemPrompt?: string;
	// appendSystemPrompt?: string[];
	// thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	// TODO: 추후 작업 예정 — --session, --fork, --session-dir, --models, --no-tools, --no-builtin-tools, --tools, --extension, --no-extensions 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
	// session?: string;
	// fork?: string;
	// sessionDir?: string;
	// models?: string[];
	// tools?: string[];
	// noTools?: boolean;
	// noBuiltinTools?: boolean;
	// extensions?: string[];
	// noExtensions?: boolean;
	print?: boolean;
	// TODO: 추후 작업 예정 — --export, --no-skills, --skill, --prompt-template, --no-prompt-templates, --theme, --no-themes, --no-context-files, --list-models 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
	// export?: string;
	// noSkills?: boolean;
	// skills?: string[];
	// promptTemplates?: string[];
	// noPromptTemplates?: boolean;
	// themes?: string[];
	// noThemes?: boolean;
	// noContextFiles?: boolean;
	// listModels?: string | true;
	verbose?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

export const VALID_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

const DEFERRED_CLI_FLAGS = new Set([
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
]);

const DEFERRED_CLI_OPTIONS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--session",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--export",
]);

function pushDeferredOptionWarning(result: Args, arg: string): void {
	result.diagnostics.push({
		type: "warning",
		message: `${arg} option is temporarily disabled`,
	});
}

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (DEFERRED_CLI_OPTIONS.has(arg)) {
			pushDeferredOptionWarning(result, arg);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				i++;
			}
		} else if (DEFERRED_CLI_FLAGS.has(arg)) {
			pushDeferredOptionWarning(result, arg);
		} else if (arg === "--list-models") {
			pushDeferredOptionWarning(result, arg);
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				i++;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	const optionsText = [
		// TODO: 추후 작업 예정 — --provider, --model, --api-key, --system-prompt, --append-system-prompt 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
		// "  --provider <name>              Provider name (default: google)",
		// '  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")',
		// "  --api-key <key>                API key (defaults to env vars)",
		// "  --system-prompt <text>         System prompt (default: coding assistant prompt)",
		// "  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)",
		"  --mode <mode>                  Output mode: text (default), json, or rpc",
		"  --print, -p                    Non-interactive mode: process prompt and exit",
		"  --continue, -c                 Continue previous session",
		"  --resume, -r                   Select a session to resume",
		// TODO: 추후 작업 예정 — --session, --fork, --session-dir 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
		// "  --session <path|id>            Use specific session file or partial UUID",
		// "  --fork <path|id>               Fork specific session file or partial UUID into a new session",
		// "  --session-dir <dir>            Directory for session storage and lookup",
		"  --no-session                   Don't save session (ephemeral)",
		// TODO: 추후 작업 예정 — --models, --no-tools, --no-builtin-tools, --tools, --thinking 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
		// "  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling",
		// "                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching",
		// "  --no-tools, -nt                Disable all registered tools by default",
		// "  --no-builtin-tools, -nbt       Disable built-in tools by default; extension/custom tools remain eligible",
		// "  --tools, -t <tools>            Comma-separated allowlist of tool names to enable",
		// "                                 Applies to registered extension and custom tools",
		// "  --thinking <level>             Set thinking level: off, low, medium, high, xhigh, max",
		// TODO: 추후 작업 예정 — --extension, --no-extensions, --skill, --no-skills, --prompt-template, --no-prompt-templates, --theme, --no-themes, --no-context-files 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
		// "  --extension, -e <path>         Load an extension file (can be used multiple times)",
		// "  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)",
		// "  --skill <path>                 Load a skill file or directory (can be used multiple times)",
		// "  --no-skills, -ns               Disable skills discovery and loading",
		// "  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)",
		// "  --no-prompt-templates, -np     Disable prompt template discovery and loading",
		// "  --theme <path>                 Load a theme file or directory (can be used multiple times)",
		// "  --no-themes                    Disable theme discovery and loading",
		// "  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading",
		// TODO: 추후 작업 예정 — --export, --list-models 비활성화 (사유: branding 정리 단계에서 일괄 비활성화)
		// "  --export <file>                Export session file to HTML and exit",
		// "  --list-models [search]         List available models (with optional fuzzy search)",
		"  --verbose                      Force verbose startup (overrides quietStartup setting)",
		"  --help, -h                     Show this help",
		"  --version, -v                  Show version number",
	].join("\n");
	console.log(`${chalk.bold(`${APP_NAME} harness`)} - One bridge to command Claude, Codex, and Gemini coding agents

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|pi]   Update Fleet and installed extensions
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config                    Open TUI to enable/disable package resources
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list

${chalk.bold("Options:")}
${optionsText}

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Environment Variables:")}
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
`);
}
