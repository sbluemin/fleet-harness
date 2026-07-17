import { RemoteRuntimeError, type RemoteCandidateSession, type RemoteCancellation, type RemoteProcessHandle } from "./contracts.js";
import type { OpenSshAdapter, OpenSshProcess } from "./ssh.js";
import type { ValidatedSshTarget } from "./target.js";

export const MAX_TUNNEL_ATTEMPTS = 5;
const SETTLE_MS = 500;

export class RemoteTunnelPortCollision extends Error { constructor() { super("remote_tunnel_port_collision"); this.name = "RemoteTunnelPortCollision"; } }
export class RemoteTunnelPortConflictExhausted extends Error { constructor() { super("remote_tunnel_port_conflict_exhausted"); this.name = "RemoteTunnelPortConflictExhausted"; } }

export interface RemoteTunnel extends RemoteCandidateSession { readonly port: number; readonly process: RemoteProcessHandle; }
export interface TunnelOptions { readonly settle?: () => Promise<void>; }

/**
 * Opens a candidate-only same-port forwarding process. It has no authority over remote services.
 * A busy local port is detected solely through OpenSSH's own bind failure (ExitOnForwardFailure=yes),
 * so Desktop never opens a listening socket of its own — the Desktop-owns-no-server boundary holds.
 */
export async function openSamePortTunnel(adapter: OpenSshAdapter, target: ValidatedSshTarget, port: number, cancellation?: RemoteCancellation, options: TunnelOptions = {}): Promise<RemoteTunnel> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("remote_tunnel_invalid_port");
  const process = await adapter.open(target, ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:127.0.0.1:${port}`], cancellation);
  let stderr = "";
  let exitedEarly = false;
  void process.exited.then(() => { exitedEarly = true; });
  process.stderr.on("data", (chunk: unknown) => { if (Buffer.byteLength(stderr, "utf8") < 8 * 1024) stderr += String(chunk); });
  const bufferedStderr = process.stderr.read();
  if (bufferedStderr !== null) stderr += String(bufferedStderr);
  await (options.settle ?? (() => Promise.race([process.exited.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))])))();
  await Promise.resolve();
  if (exitedEarly) {
    if (isBindFailure(stderr)) throw new RemoteTunnelPortCollision();
    throw new RemoteRuntimeError("ssh_failed", "remote_tunnel_exited_before_ready");
  }
  return { port, process, rollback: () => terminate(process), dispose: () => terminate(process) };
}

/** The reroll controller supplies only same-owner stop/start functions. */
export async function openTunnelWithReroll<T extends { readonly port: number }>(initial: T, open: (port: number) => Promise<RemoteTunnel>, reroll: (current: T) => Promise<T>): Promise<{ readonly tunnel: RemoteTunnel; readonly service: T }> {
  let service = initial;
  for (let attempt = 1; attempt <= MAX_TUNNEL_ATTEMPTS; attempt += 1) {
    try { return { tunnel: await open(service.port), service }; }
    catch (error) {
      if (!(error instanceof RemoteTunnelPortCollision)) throw error;
      if (attempt === MAX_TUNNEL_ATTEMPTS) throw new RemoteTunnelPortConflictExhausted();
      service = await reroll(service);
    }
  }
  throw new RemoteTunnelPortConflictExhausted();
}

function isBindFailure(stderr: string): boolean { return /(?:address already in use|cannot listen|bind:)/iu.test(stderr); }
async function terminate(process: OpenSshProcess): Promise<void> { process.terminate(); await process.exited; }
