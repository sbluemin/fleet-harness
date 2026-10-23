import type { ShellOpenAtRequest, ShellOpenAtResult } from "../shared/navigation.js";
import { ApiError } from "../../execution/client/objective-records.js";

/**
 * 어느 Shell 을 옮길지 — 호스트가 채운다(지금 대화의 Shell). 플러그인은 `ctx.shell` 능력을 쓰고 이 값을 직접 넘기지 않는다.
 * 생략하면 Console 기본 Shell 이다.
 */
export interface ShellPlacementTarget {
  readonly shell?: string;
}

export function requestShellOpenAt(request: ShellOpenAtRequest, target: ShellPlacementTarget = {}): Promise<ShellOpenAtResult> {
  return postShellPlacement("/api/v1/shell/open-at", request, target);
}

export function requestShellRestartAt(request: ShellOpenAtRequest, target: ShellPlacementTarget = {}): Promise<ShellOpenAtResult> {
  return postShellPlacement("/api/v1/shell/restart-at", request, target);
}

async function postShellPlacement(url: string, request: ShellOpenAtRequest, target: ShellPlacementTarget): Promise<ShellOpenAtResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target.shell === undefined ? request : { ...request, shell: target.shell }),
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
