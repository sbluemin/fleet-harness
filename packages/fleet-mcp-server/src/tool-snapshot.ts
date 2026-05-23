import type { McpTool, RegisteredTool } from "./types.js";

export interface McpToolSnapshotStore {
  registerToolsForSession(sessionToken: string, tools: McpTool[]): void;
  getToolsForSession(sessionToken: string): RegisteredTool[];
  getToolNamesForSession(sessionToken: string): Set<string>;
  removeToolsForSession(sessionToken: string): void;
  clearAllTools(): void;
}

const TYPEBOX_KEYS = new Set([
  "$id",
  "Kind",
  "Hint",
  "$schema",
]);

const PI_BUILTIN_TOOLS = new Set<string>();

export function convertToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  return cleanSchema(schema as Record<string, unknown>);
}

export function createMcpToolSnapshotStore(): McpToolSnapshotStore {
  const sessionTools = new Map<string, RegisteredTool[]>();
  const sessionToolNames = new Map<string, Set<string>>();

  return {
    registerToolsForSession(sessionToken, tools) {
      const filtered = tools.filter((tool) => !PI_BUILTIN_TOOLS.has(tool.name));

      const registered: RegisteredTool[] = filtered.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: convertToolSchema(tool.parameters),
      }));

      sessionTools.set(sessionToken, registered);
      sessionToolNames.set(sessionToken, new Set(filtered.map((tool) => tool.name)));
    },
    getToolsForSession(sessionToken) {
      return sessionTools.get(sessionToken) ?? [];
    },
    getToolNamesForSession(sessionToken) {
      return sessionToolNames.get(sessionToken) ?? new Set();
    },
    removeToolsForSession(sessionToken) {
      sessionTools.delete(sessionToken);
      sessionToolNames.delete(sessionToken);
    },
    clearAllTools() {
      sessionTools.clear();
      sessionToolNames.clear();
    },
  };
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
