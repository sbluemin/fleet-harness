import net from "node:net";

import { PUBLIC_STATUS_TIMEOUT_MS, classifyConsolePublic, type ConsolePublicState, type ConsolePublicStatus } from "@fleet-console/protocol/lifecycle";

import { isLockAuthorReplaced, isPidAlive } from "./process.js";

export interface ObserveConsolePublicInput {
  /** The lock's pid, its `startedAt`, and its endpoint origin. No token is read or sent. */
  readonly lock: { readonly pid: number; readonly startedAt: unknown; readonly origin: string };
  /** False when the pid lives in another namespace (a Console inside WSL): its port stands in for its liveness. */
  readonly pidCheckable: boolean;
  /** Injected liveness checks, for a caller that cannot use this machine's process table or sockets as they are. */
  readonly isAlive?: (pid: number) => boolean;
  readonly portOpen?: (origin: string) => Promise<boolean>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Observes a Console without credentials (docs/console-lifecycle-contract.md, "Observing an instance"): pid liveness by
 * the contract's rule (only ESRCH is death), or a TCP connect when the pid cannot be checked here; one unauthenticated
 * status request; and, for a refused address behind a live pid, whether that pid started after its lock was written.
 */
export async function observeConsolePublic(input: ObserveConsolePublicInput): Promise<ConsolePublicState> {
  const { lock } = input;
  const pidAlive = input.pidCheckable ? (input.isAlive ?? isPidAlive)(lock.pid) : null;
  const [portOpen, status] = await Promise.all([
    input.pidCheckable ? Promise.resolve(null) : (input.portOpen ?? isPortOpen)(lock.origin),
    pidAlive === false ? Promise.resolve<ConsolePublicStatus>("unanswered") : probePublicStatus(lock.origin, lock.pid),
  ]);
  const authorReplaced = status === "refused" && pidAlive === true ? await isLockAuthorReplaced(lock, input.env) : false;
  return classifyConsolePublic({ pidAlive, portOpen, authorReplaced, status });
}

/**
 * One unauthenticated `/api/v1/status` request. A 503 `console_starting` naming this pid (or no pid) is starting; a refused
 * connection is refused; any other answer is answered; a timeout or a malformed body proves nothing (unanswered).
 */
async function probePublicStatus(origin: string, pid: number): Promise<ConsolePublicStatus> {
  try {
    const response = await fetch(new URL("/api/v1/status", origin), { redirect: "error", signal: AbortSignal.timeout(PUBLIC_STATUS_TIMEOUT_MS) });
    if (response.status !== 503) {
      await response.body?.cancel();
      return "answered";
    }
    const body = await response.json().catch(() => null) as { error?: unknown; pid?: unknown } | null;
    // 공개 status는 현재 pid를 보내지 않는다. 제공되는 경우에만 대조하며, 어느 쪽도 소유권 증명은 아니다.
    return body?.error === "console_starting" && (body.pid === undefined || body.pid === pid) ? "starting" : "answered";
  } catch (error) {
    return (error as { cause?: { code?: unknown } } | null)?.cause?.code === "ECONNREFUSED" ? "refused" : "unanswered";
  }
}

/** Whether the origin's port accepts a TCP connection within PUBLIC_STATUS_TIMEOUT_MS. */
function isPortOpen(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.destroy();
      resolve(true);
    });
    const fail = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(PUBLIC_STATUS_TIMEOUT_MS, fail);
    socket.on("error", fail);
  });
}
