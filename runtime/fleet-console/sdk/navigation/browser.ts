import type { ShellOpenAtRequest, ShellOpenAtResult } from "./index.js";
import { ApiError } from "../operations/browser.js";

export function requestShellOpenAt(request: ShellOpenAtRequest): Promise<ShellOpenAtResult> {
  return postShellPlacement("/api/v1/shell/open-at", request);
}

export function requestShellRestartAt(request: ShellOpenAtRequest): Promise<ShellOpenAtResult> {
  return postShellPlacement("/api/v1/shell/restart-at", request);
}

async function postShellPlacement(url: string, request: ShellOpenAtRequest): Promise<ShellOpenAtResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (response.status === 409 && body?.error === "shell_busy") return { ok: false, reason: "busy" };
  if (response.status === 409 && body?.error === "shell_input_pending") return { ok: false, reason: "input_pending" };
  if (response.status === 403 && body?.error === "shell_read_only") return { ok: false, reason: "read_only" };
  if (response.status === 403 && body?.error === "outside_theater") return { ok: false, reason: "outside_theater" };
  if (response.status === 404) return { ok: false, reason: "not_found" };
  throw new ApiError(response.status, body?.error ?? "shell_open_failed");
}
