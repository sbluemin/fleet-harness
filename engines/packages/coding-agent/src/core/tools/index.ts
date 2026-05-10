import type { AgentTool } from "@sbluemin/fleet-agent-core";
import type { ToolDefinition } from "../extensions/types.js";

export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = string;

export const allToolNames = new Set<string>();

export type ToolsOptions = Record<string, unknown>;

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef | undefined {
	void toolName;
	void cwd;
	void options;
	return undefined;
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool | undefined {
	void toolName;
	void cwd;
	void options;
	return undefined;
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	void cwd;
	void options;
	return [];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	void cwd;
	void options;
	return [];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	void cwd;
	void options;
	return {};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	void cwd;
	void options;
	return [];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	void cwd;
	void options;
	return [];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	void cwd;
	void options;
	return {};
}
