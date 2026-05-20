import type { McpTool, RegisteredTool } from "./types.js";

const TYPEBOX_KEYS = new Set([
  "$id",
  "Kind",
  "Hint",
  "$schema",
]);

const PI_BUILTIN_TOOLS = new Set<string>();

const sessionTools = new Map<string, RegisteredTool[]>();
const sessionToolNames = new Map<string, Set<string>>();

export function convertToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  return cleanSchema(schema as Record<string, unknown>);
}

export function registerToolsForSession(
  sessionToken: string,
  tools: McpTool[],
): void {
  const filtered = tools.filter((tool) => !PI_BUILTIN_TOOLS.has(tool.name));

  const registered: RegisteredTool[] = filtered.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: convertToolSchema(tool.parameters),
  }));

  sessionTools.set(sessionToken, registered);
  sessionToolNames.set(sessionToken, new Set(filtered.map((tool) => tool.name)));
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

export function computeToolHash(tools: McpTool[]): string {
  let hash = 5381;

  for (const tool of tools) {
    const key = `${tool.name}:${tool.description ?? ""}:${JSON.stringify(tool.parameters ?? {})}`;

    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    }
  }

  return hash.toString(36);
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
