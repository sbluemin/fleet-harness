import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "@fleet-console/lifecycle";
import { claudeRuntimePackages } from "@fleet-console/agent-runtime/claude";
import { connectSessionRpc, prepareSessionGeneration, readSessionHostManifest, reclaimDeadSessionHost, type SessionRpcPeer } from "@fleet-console/lifecycle/session-host";
import { SESSION_ATTACH_POLL_MS, SESSION_HOST_WIRE, SESSION_HOST_START_MS, type SessionBusinessCall, type SessionCommand, type SessionCommandRecord, type SessionGeneration, type SessionHostManifest, type SessionHostSnapshot, type SessionOwner, type SessionReplay, type SessionSnapshot, type SessionUpdateRef } from "@fleet-console/protocol/session-host";
import type { HostedSessionLaunch, SessionCheckpoint } from "./contracts.js";

export class SessionHostClient {
  private constructor(readonly manifest: SessionHostManifest, readonly generation: SessionGeneration, private readonly peer: SessionRpcPeer, readonly epoch: number) {}
  static async attach(dataDir: string, packageRoot: string, owner: SessionOwner, env: NodeJS.ProcessEnv = process.env): Promise<SessionHostClient> {
    const generation = prepareSessionGeneration(dataDir, packageRoot, { packages: [...claudeRuntimePackages(), "node-pty", "koffi", "ws", "fflate"] });
    let manifest = readSessionHostManifest(dataDir);
    if (manifest && !isPidAlive(manifest.pid)) { reclaimDeadSessionHost(dataDir); manifest = null; }
    if (!manifest) {
      const diagnostics = fs.openSync(path.join(path.dirname(path.dirname(generation.root)), "broker.stderr.log"), "a", 0o600);
      let child: ReturnType<typeof spawn>;
      try { child = spawn(generation.node, [generation.broker], { detached: true, stdio: ["ignore", "ignore", diagnostics], windowsHide: true, env: { ...env, FLEET_SESSION_BROKER_BOOT: JSON.stringify({ dataDir, generation }) } }); }
      finally { fs.closeSync(diagnostics); }
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
      const snapshot = await peer.call<SessionHostSnapshot>("hello", { wire: SESSION_HOST_WIRE, role: "console", capability: manifest.capability, hostId: manifest.hostId, owner });
      return new SessionHostClient(manifest, generation, peer, snapshot.epoch);
    } catch (error) { peer.close(); throw error; }
  }
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
