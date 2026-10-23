import fs from "node:fs";
import { createWindowsSessionPlatform } from "./windows-session-platform.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONSOLE_STOP_DEADLINE_MS, type ConsoleStopReason } from "@fleet-console/protocol/lifecycle";
import type { SessionOwner, SessionUpdateRef } from "@fleet-console/protocol/session-host";
import type { SessionHostPlatform } from "@fleet-console/lifecycle/session-host";
import { SessionHostClient, stopSlotSessionHost } from "../../../features/execution/host/session-host/client.js";
import { readConsoleUpdateProgress } from "../../../features/updates/host/update-progress.js";
import { recordSessionUpdateNotice } from "../../../features/updates/host/session-update-notice.js";

/** Composition port; product adapters consume get(), never discover a module singleton. */
export class ConsoleSessionHostOwner {
  private attached: Promise<SessionHostClient> | null = null;
  private stopFlight: Promise<unknown> = Promise.resolve();
  private updateId: string | null = null;
  private committed = false;
  private endsSessionsOnUpdate = false;
  private terminateRequested = false;
  private stopStarted = 0;
  constructor(private readonly dataDir: string, private readonly packageRoot = ownPackageRoot(), private readonly platform?: SessionHostPlatform, private readonly env: NodeJS.ProcessEnv = process.env) {}
  start(identity: SessionOwner): Promise<SessionHostClient> {
    return this.attached ??= SessionHostClient.attach(this.dataDir, this.packageRoot, identity, this.env, this.platform ?? createWindowsSessionPlatform()).then((client) => {
      if (this.terminateRequested) this.requestStop("signal");
      return client;
    });
  }
  get(): Promise<SessionHostClient> { return this.attached ?? Promise.reject(new Error("session_host_not_started")); }
  get preservingUpdate(): boolean { return this.committed && !this.terminateRequested; }
  private readonly beforePrepare = new Set<() => Promise<void>>();
  private readonly updateCancelled = new Set<() => void>();
  subscribeUpdateCancelled(resume: () => void): () => void { this.updateCancelled.add(resume); return () => this.updateCancelled.delete(resume); }
  subscribeBeforePrepare(flush: () => Promise<void>): () => void { this.beforePrepare.add(flush); return () => this.beforePrepare.delete(flush); }
  async prepareUpdate(updateId: string): Promise<SessionUpdateRef | null> {
    try {
      for (const flush of this.beforePrepare) await flush();
      const client = await this.get();
      if (!client.preservesUpdates) {
        await client.prepareConsoleOwnedUpdate(updateId);
        this.updateId = updateId;
        console.warn("[fleet-console] This environment cannot preserve sessions during an update; sessions will end normally.");
        return null;
      }
      const ref = await client.prepareUpdate(updateId);
      this.updateId = updateId; return ref;
    } catch (error) { for (const resume of this.updateCancelled) resume(); throw error; }
  }
  async commitUpdate(expectedId?: string): Promise<void> {
    if (expectedId !== undefined && expectedId !== this.updateId) throw new Error("session_update_mismatch");
    if (!this.updateId || this.terminateRequested) throw new Error("session_update_not_prepared");
    const client = await this.get();
    if (client.preservesUpdates) { await client.commitUpdate(this.updateId); this.committed = true; }
    else this.endsSessionsOnUpdate = true;
  }
  async cancelUpdate(expectedId?: string): Promise<void> {
    if (expectedId !== undefined && expectedId !== this.updateId) throw new Error("session_update_mismatch");
    if (this.updateId && !this.terminateRequested) {
      const client = await this.get(); await client.cancelUpdate(this.updateId);
    }
    this.updateId = null; this.committed = false; this.endsSessionsOnUpdate = false;
    for (const resume of this.updateCancelled) resume();
  }
  requestStop(reason: ConsoleStopReason): void {
    if (reason === "update" && this.preservingUpdate) return;
    if (!this.terminateRequested) this.stopStarted = performance.now();
    this.terminateRequested = true;
    this.stopFlight = this.get().catch(() => null).then(async (client) => {
      const endedForUpdate = reason === "update" && this.endsSessionsOnUpdate
        && (await client?.listSessions().catch(() => null))?.sessions.some((session) => (session.kind === "sdk" || session.kind === "pty") && (session.state === "live" || session.state === "starting"));
      await stopSlotSessionHost(this.dataDir);
      if (endedForUpdate) {
        const progress = readConsoleUpdateProgress(this.dataDir);
        recordSessionUpdateNotice(this.dataDir, { reason: "session-preservation-unavailable", fromVersion: progress.fromVersion ?? "previous", targetVersion: progress.targetVersion ?? "current" });
      }
    });
    void this.stopFlight.catch(() => {});
  }
  async settleStop(): Promise<void> {
    await this.stopFlight;
    const client = await this.attached?.catch(() => null);
    if (this.terminateRequested) await client?.drainConsoleOwnership(Math.max(0, CONSOLE_STOP_DEADLINE_MS - (performance.now() - this.stopStarted)));
    client?.closeObserver();
  }
}

function ownPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@dotobokuri/fleet-console") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("console_package_missing");
    dir = parent;
  }
}
