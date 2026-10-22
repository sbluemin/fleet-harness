import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "@fleet-console/lifecycle";
import { claudeRuntimePackages } from "@fleet-console/agent-runtime/claude";
import { authenticateSessionPeer, connectSessionRpc, prepareSessionGeneration, readSessionHostManifest, reclaimDeadSessionHost, privateSessionDirectory, sessionHostPaths, type SessionHostPlatform, type SessionHostProcess, type SessionRpcPeer } from "@fleet-console/lifecycle/session-host";
import { SESSION_ATTACH_POLL_MS, SESSION_HOST_WIRE, SESSION_HOST_START_MS, type SessionBusinessCall, type SessionCommand, type SessionCommandRecord, type SessionGeneration, type SessionHostManifest, type SessionHostSnapshot, type SessionOwner, type SessionReplay, type SessionSnapshot, type SessionUpdateRef } from "@fleet-console/protocol/session-host";
import type { HostedSessionLaunch, SessionCheckpoint } from "./contracts.js";

export class SessionHostClient {
  private constructor(readonly manifest: SessionHostManifest, readonly generation: SessionGeneration, private readonly peer: SessionRpcPeer, readonly epoch: number, private readonly ownedProcess?: SessionHostProcess) {}
  static async attach(dataDir: string, packageRoot: string, owner: SessionOwner, env: NodeJS.ProcessEnv = process.env, platform?: SessionHostPlatform): Promise<SessionHostClient> {
    if (process.platform === "win32") {
      if (!platform) throw new Error("session_windows_platform_required");
      const directory = sessionHostPaths(dataDir).dir;
      privateSessionDirectory(directory); platform.protectDirectory(directory);
    }
    const generation = prepareSessionGeneration(dataDir, packageRoot, { packages: [...claudeRuntimePackages(), "node-pty", "koffi", "ws", "fflate"] });
    let ownedProcess: SessionHostProcess | undefined;
    let manifest = readSessionHostManifest(dataDir);
    if (manifest && !isPidAlive(manifest.pid)) { reclaimDeadSessionHost(dataDir); manifest = null; }
    if (!manifest) {
      const diagnostics = fs.openSync(path.join(path.dirname(path.dirname(generation.root)), "broker.stderr.log"), "a", 0o600);
      let child: SessionHostProcess;
      const bootEnv = { ...env, FLEET_SESSION_BROKER_BOOT: JSON.stringify({ dataDir, generation }) };
      try {
        if (platform) {
          try { child = platform.spawnIndependent(generation.node, [generation.broker], bootEnv, diagnostics); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "SESSION_INDEPENDENCE_UNAVAILABLE") throw error;
            const boundEnv = { ...env, FLEET_SESSION_BROKER_BOOT: JSON.stringify({ dataDir, generation, preservesUpdates: false }) };
            child = platform.spawnConsoleOwned(generation.node, [generation.broker], boundEnv, diagnostics);
            ownedProcess = child;
            try { fs.appendFileSync(path.join(sessionHostPaths(dataDir).dir, "failures.jsonl"), JSON.stringify({ at: Date.now(), kind: "session_update_preservation_unavailable", reason: "independent_host_unavailable", mode: "console-owned" }) + "\n", { mode: 0o600 }); }
            catch { /* Diagnostic IO must not prevent an otherwise contained session launch. */ }
          }
        } else child = spawn(generation.node, [generation.broker], { detached: true, stdio: ["ignore", "ignore", diagnostics], windowsHide: true, env: bootEnv });
      } finally { fs.closeSync(diagnostics); }
      let spawnError: Error | null = null;
      child.once("exit", () => { spawnError ??= new Error("session_host_exited_during_start"); });
      child.on("error", (error) => { spawnError = error; }); child.unref();
      const until = performance.now() + SESSION_HOST_START_MS;
      while (!manifest && performance.now() < until) {
        if (spawnError) throw spawnError;
        manifest = readSessionHostManifest(dataDir);
        if (!manifest) await new Promise((resolve) => setTimeout(resolve, SESSION_ATTACH_POLL_MS));
      }
      if (!manifest) throw new Error("session_host_start_timeout");
    }
    const peer = await connectSessionRpc(manifest.socket);
    try {
      const snapshot = await authenticateSessionPeer<SessionHostSnapshot>(peer, { wire: SESSION_HOST_WIRE, role: "console", hostId: manifest.hostId, owner: { pid: owner.pid, startedAt: owner.startedAt }, generation: generation.id }, manifest.capability, owner.token);
      return new SessionHostClient(manifest, generation, peer, snapshot.epoch, ownedProcess);
    } catch (error) { peer.close(); throw error; }
  }
  async drainConsoleOwnership(timeoutMs: number): Promise<void> { await this.ownedProcess?.drain?.(timeoutMs); }
  get preservesUpdates(): boolean { return this.manifest.preservesUpdates !== false; }
  bindBusiness(handler: (call: SessionBusinessCall) => Promise<unknown> | unknown): Promise<boolean> {
    this.peer.bind((method, body) => { if (method !== "business") throw new Error("session_client_method_denied"); return handler(body as SessionBusinessCall); });
    return this.peer.call("backend-ready", { epoch: this.epoch });
  }
  listSessions(): Promise<SessionHostSnapshot> { return this.peer.call("snapshot"); }
  open(launch: HostedSessionLaunch): Promise<SessionSnapshot> { return this.peer.call("open", { epoch: this.epoch, launch }); }
  /** 서버 전용 원 launch 계약. credentials/env와 raw 경로가 있으므로 browser DTO로 쓰지 않는다. */
  describe(sessionKey: string): Promise<HostedSessionLaunch> { return this.peer.call("describe", { epoch: this.epoch, sessionKey }); }
  readEvents(sessionKey: string, afterSeq: number): Promise<SessionReplay> { return this.peer.call("events", { epoch: this.epoch, sessionKey, afterSeq }); }
  command(input: Omit<SessionCommand, "epoch">): Promise<SessionCommandRecord> { return this.peer.call("command", { ...input, epoch: this.epoch }); }
  commandStatus(sessionKey: string, commandId: string): Promise<SessionCommandRecord | null> { return this.peer.call("command-status", { epoch: this.epoch, sessionKey, commandId }); }
  checkpoint(sessionKey: string, checkpoint: SessionCheckpoint): Promise<boolean> { return this.peer.call("checkpoint", { epoch: this.epoch, sessionKey, checkpoint }); }
  answerBusiness(requestId: string, permissionEpoch: number, value: unknown): Promise<boolean> { return this.peer.call("answer-business", { epoch: this.epoch, requestId, permissionEpoch, value }); }
  revokeBusiness(requestId: string, permissionEpoch: number): Promise<boolean> { return this.peer.call("revoke-business", { epoch: this.epoch, requestId, permissionEpoch }); }
  prepareUpdate(updateId: string): Promise<SessionUpdateRef> { return this.peer.call("prepare-update", { epoch: this.epoch, updateId }); }
  commitUpdate(updateId: string): Promise<boolean> { return this.peer.call("commit-update", { epoch: this.epoch, updateId }); }
  cancelUpdate(updateId: string): Promise<boolean> { return this.peer.call("cancel-update", { epoch: this.epoch, updateId }); }
  terminateAll(): Promise<boolean> { return this.peer.call("terminate-all"); }
  /** Only a committed update permits the host to outlive this observer connection. */
  closeObserver(): void { this.peer.close(); }
}

export { terminateSessionHost as stopSlotSessionHost } from "@fleet-console/lifecycle/session-host";
