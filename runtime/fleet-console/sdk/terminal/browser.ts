import type { ClientTerminalCapability } from "../plugin/types.js";

export function useTerminalAttach(): ClientTerminalCapability["requestTicket"] {
  return async (pluginId, path, operationId, signal) => defaultTerminalCapability.requestTicket(pluginId, path, operationId, signal);
}

const defaultTerminalCapability: ClientTerminalCapability = {
  requestTicket: async (pluginId, path, operationId, signal) => {
    const response = await fetch(resolvePluginPath(pluginId, path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId }),
      signal,
    });
    if (!response.ok) throw new Error(`Terminal ticket request failed: ${response.status}`);
    const payload = await response.json() as { readonly ticket?: unknown; readonly ttlMs?: unknown };
    if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") throw new Error("Invalid terminal ticket response");
    return { ticket: payload.ticket, ttlMs: payload.ttlMs };
  },
};

function resolvePluginPath(pluginId: string, path: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) throw new Error("Invalid plugin id");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (suffix.includes("..")) throw new Error("Invalid plugin path");
  return `/plugins/${pluginId}${suffix}`;
}
