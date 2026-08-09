import type { McpTool, RegisteredTool } from "./spec.js";

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
      const registered: RegisteredTool[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: convertToolSchema(tool.parameters),
      }));

      sessionTools.set(sessionToken, registered);
      sessionToolNames.set(sessionToken, new Set(tools.map((tool) => tool.name)));
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
