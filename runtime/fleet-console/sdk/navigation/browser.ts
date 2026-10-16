import type { ShellOpenAtRequest, ShellOpenAtResult } from "./index.js";
import type { HostTransport } from "../host-context/types.js";
import { createBrowserLocalTransport, readHostJson } from "../host-context/browser.js";
import { ApiError } from "../operations/browser.js";

export function requestShellOpenAt(request: ShellOpenAtRequest, transport = createBrowserLocalTransport()): Promise<ShellOpenAtResult> {
  return postShellPlacement("/api/v1/shell/open-at", request, transport);
}

export function requestShellRestartAt(request: ShellOpenAtRequest, transport = createBrowserLocalTransport()): Promise<ShellOpenAtResult> {
  return postShellPlacement("/api/v1/shell/restart-at", request, transport);
}

async function postShellPlacement(url: string, request: ShellOpenAtRequest, transport: HostTransport): Promise<ShellOpenAtResult> {
  const response = await transport.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.ok) return { ok: true };
  const body = await readHostJson<{ error?: string }>(transport.scope, response).catch(() => { transport.scope.signal.throwIfAborted(); return null; });
  if (response.status === 409 && body?.error === "shell_busy") return { ok: false, reason: "busy" };
  if (response.status === 409 && body?.error === "shell_input_pending") return { ok: false, reason: "input_pending" };
  if (response.status === 403 && body?.error === "shell_read_only") return { ok: false, reason: "read_only" };
  if (response.status === 403 && body?.error === "outside_theater") return { ok: false, reason: "outside_theater" };
  if (response.status === 404) return { ok: false, reason: "not_found" };
  throw new ApiError(response.status, body?.error ?? "shell_open_failed");
}
