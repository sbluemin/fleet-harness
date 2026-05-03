/**
 * agent/tool-snapshot — ACP provider 도구 스냅샷 + 스키마 변환
 *
 * 세션별 MCP 도구 스냅샷을 관리하고, TypeBox 기반 Tool.parameters를
 * MCP inputSchema 호환 JSON Schema로 정제한다.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { getLogAPI } from "../log/store.js";

export type Tool = { name: string; description?: string; parameters?: unknown; [key: string]: unknown };

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TYPEBOX_KEYS = new Set([
  "$id",
  "Kind",
  "Hint",
  "$schema",
]);

const PI_BUILTIN_TOOLS = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls",
]);

const sessionTools = new Map<string, RegisteredTool[]>();
const sessionToolNames = new Map<string, Set<string>>();

export function convertToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  return cleanSchema(schema as Record<string, unknown>);
}

function cleanSchema(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    if (TYPEBOX_KEYS.has(key)) continue;

    const value = obj[key];

    if (value === null || value === undefined) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? cleanSchema(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof value === "object") {
      result[key] = cleanSchema(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  if (!result.type && result.properties) {
    result.type = "object";
  }

  return result;
}

export function registerToolsForSession(
  sessionToken: string,
  tools: Tool[],
): void {
  const filtered = tools.filter((tool) => !PI_BUILTIN_TOOLS.has(tool.name));
  const skipped = tools.length - filtered.length;

  const registered: RegisteredTool[] = filtered.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: convertToolSchema(tool.parameters),
  }));

  sessionTools.set(sessionToken, registered);
  sessionToolNames.set(sessionToken, new Set(filtered.map((tool) => tool.name)));

  getLogAPI().debug(
    "acp",
    `tool registry: ${registered.length}개 등록, ${skipped}개 기본도구 제외`,
    { category: "acp" },
  );
}

export function getToolsForSession(sessionToken: string): RegisteredTool[] {
  return sessionTools.get(sessionToken) ?? [];
}

export function getToolNamesForSession(sessionToken: string): Set<string> {
  return sessionToolNames.get(sessionToken) ?? new Set();
}

export function removeToolsForSession(sessionToken: string): void {
  sessionTools.delete(sessionToken);
  sessionToolNames.delete(sessionToken);
}

export function clearAllTools(): void {
  sessionTools.clear();
  sessionToolNames.clear();
}

export function computeToolHash(tools: Tool[]): string {
  let hash = 5381;

  for (const tool of tools) {
    const key = `${tool.name}:${tool.description ?? ""}:${JSON.stringify(tool.parameters ?? {})}`;

    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    }
  }

  return hash.toString(36);
}
