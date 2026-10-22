import fs from "node:fs";
import { createWindowsSessionPlatform } from "./windows-session-platform.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConsoleStopReason } from "@fleet-console/protocol/lifecycle";
import type { SessionOwner, SessionUpdateRef } from "@fleet-console/protocol/session-host";
import { SessionHostClient, stopSlotSessionHost } from "../../../features/execution/host/session-host/client.js";

/** Composition port; product adapters consume get(), never discover a module singleton. */
export class ConsoleSessionHostOwner {
  private attached: Promise<SessionHostClient> | null = null;
  private stopFlight: Promise<unknown> = Promise.resolve();
  private updateId: string | null = null;
  private committed = false;
  private terminateRequested = false;
  constructor(private readonly dataDir: string, private readonly packageRoot = ownPackageRoot()) {}
  start(identity: SessionOwner): Promise<SessionHostClient> {
    return this.attached ??= SessionHostClient.attach(this.dataDir, this.packageRoot, identity, process.env, createWindowsSessionPlatform()).then((client) => {
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
  async prepareUpdate(updateId: string): Promise<SessionUpdateRef> {
    try {
      for (const flush of this.beforePrepare) await flush();
      const ref = await (await this.get()).prepareUpdate(updateId);
      this.updateId = updateId; return ref;
    } catch (error) { for (const resume of this.updateCancelled) resume(); throw error; }
  }
  async commitUpdate(expectedId?: string): Promise<void> {
    if (expectedId !== undefined && expectedId !== this.updateId) throw new Error("session_update_mismatch");
    if (!this.updateId || this.terminateRequested) throw new Error("session_update_not_prepared");
    await (await this.get()).commitUpdate(this.updateId); this.committed = true;
  }
  async cancelUpdate(expectedId?: string): Promise<void> {
    if (expectedId !== undefined && expectedId !== this.updateId) throw new Error("session_update_mismatch");
    if (this.updateId && !this.terminateRequested) await (await this.get()).cancelUpdate(this.updateId);
    this.updateId = null; this.committed = false;
    for (const resume of this.updateCancelled) resume();
  }
  requestStop(reason: ConsoleStopReason): void {
    if (reason === "update" && this.preservingUpdate) return;
    this.terminateRequested = true;
    this.stopFlight = this.get().catch(() => null).then(() => stopSlotSessionHost(this.dataDir));
    void this.stopFlight.catch(() => {});
  }
  async settleStop(): Promise<void> {
    await this.stopFlight;
    const client = await this.attached?.catch(() => null);
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
