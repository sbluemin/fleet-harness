import type { AnalysisEvent, AnalysisSession } from "./analysis-types.js";

export const MAX_ANALYSIS_ARTIFACTS = 32;
// Active artifacts remain available; stopped-session history is bounded process-wide.
export const MAX_STOPPED_ANALYSIS_ARTIFACTS = 256;
type Subscriber = (event: AnalysisEvent) => void;
type GlobalSubscriber = (operationId: string, event: AnalysisEvent) => void;
type RosterSubscriber = (operationIds: readonly string[]) => void;
type Entry = { readonly session: AnalysisSession; readonly subscribers: Set<Subscriber>; starting: boolean; messaging: boolean; stopped: boolean; disposePromise?: Promise<void> };
type StoredArtifact = { readonly operationId: string; readonly html: string };

export class AnalysisRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly globalSubscribers = new Set<GlobalSubscriber>();
  private readonly rosterSubscribers = new Set<RosterSubscriber>();

  async start(operationId: string, create: (onEvent: (event: AnalysisEvent) => void) => AnalysisSession): Promise<"started" | "stopped" | "exists"> {
    if (this.entries.has(operationId)) return "exists";
    let entry: Entry | undefined;
    const session = create((event) => {
      if (!entry || entry.stopped) return;
      if (event.type === "artifact") this.storeArtifact(operationId, event.artifact.id, event.artifact.html);
      this.publish(operationId, event);
      if (event.type === "error" && event.error.code === "analysis_exited") void this.stopEntry(operationId, entry);
    });
    entry = { session, subscribers: new Set(), starting: true, messaging: false, stopped: false };
    this.entries.set(operationId, entry);
    try {
      await session.start();
      if (this.entries.get(operationId) !== entry || entry.stopped) {
        entry.starting = false;
        await this.disposeEntry(entry);
        return "stopped";
      }
      entry.starting = false;
      this.notifyRoster();
      return "started";
    }
    catch (error) {
      if (this.entries.get(operationId) === entry) this.entries.delete(operationId);
      entry.stopped = true;
      entry.starting = false;
      entry.subscribers.clear();
      await this.disposeEntry(entry);
      throw error;
    }
  }

  async message(operationId: string, text: string): Promise<"accepted" | "not_found" | "busy"> {
    const entry = this.entries.get(operationId);
    if (!entry || entry.stopped) return "not_found";
    if (entry.starting || entry.messaging) return "busy";
    entry.messaging = true;
    void entry.session.send(text).catch(() => {
      if (this.entries.get(operationId) !== entry || entry.stopped) return;
      this.publish(operationId, { type: "error", error: { code: "analysis_error", message: "Analysis request failed." } });
    }).finally(() => { entry.messaging = false; });
    return "accepted";
  }

  subscribe(operationId: string, subscriber: Subscriber): (() => void) | null {
    const entry = this.entries.get(operationId);
    if (!entry || entry.stopped) return null;
    entry.subscribers.add(subscriber);
    return () => entry.subscribers.delete(subscriber);
  }

  subscribeAll(subscriber: GlobalSubscriber): () => void {
    this.globalSubscribers.add(subscriber);
    return () => this.globalSubscribers.delete(subscriber);
  }

  subscribeRoster(subscriber: RosterSubscriber): () => void {
    this.rosterSubscribers.add(subscriber);
    return () => this.rosterSubscribers.delete(subscriber);
  }

  activeOperationIds(): readonly string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => !entry.stopped && !entry.starting)
      .map(([operationId]) => operationId)
      .sort();
  }

  async stop(operationId: string): Promise<boolean> {
    const entry = this.entries.get(operationId);
    if (!entry) return false;
    return this.stopEntry(operationId, entry);
  }

  artifactHtml(artifactId: string): string | null {
    return this.artifacts.get(artifactId)?.html ?? null;
  }

  clearArtifacts(operationId: string): void {
    for (const [artifactId, artifact] of this.artifacts) {
      if (artifact.operationId === operationId) this.artifacts.delete(artifactId);
    }
  }

  private publish(operationId: string, event: AnalysisEvent): void {
    const entry = this.entries.get(operationId);
    if (entry && !entry.stopped) {
      for (const subscriber of entry.subscribers) subscriber(event);
    }
    for (const subscriber of this.globalSubscribers) subscriber(operationId, event);
  }

  private notifyRoster(): void {
    const operationIds = this.activeOperationIds();
    for (const subscriber of this.rosterSubscribers) subscriber(operationIds);
  }

  private async stopEntry(operationId: string, entry: Entry): Promise<boolean> {
    if (this.entries.get(operationId) !== entry) return false;
    this.entries.delete(operationId);
    entry.stopped = true;
    entry.subscribers.clear();
    this.pruneStoppedArtifacts();
    this.notifyRoster();
    await this.disposeEntry(entry);
    return true;
  }

  private storeArtifact(operationId: string, artifactId: string, html: string): void {
    this.artifacts.delete(artifactId);
    this.artifacts.set(artifactId, { operationId, html });
    let operationSize = 0;
    let oldestOperationArtifactId: string | undefined;
    for (const [storedArtifactId, artifact] of this.artifacts) {
      if (artifact.operationId !== operationId) continue;
      oldestOperationArtifactId ??= storedArtifactId;
      operationSize += 1;
      if (operationSize > MAX_ANALYSIS_ARTIFACTS) {
        this.artifacts.delete(oldestOperationArtifactId);
        break;
      }
    }
    this.pruneStoppedArtifacts();
  }

  private pruneStoppedArtifacts(): void {
    let stoppedArtifactCount = 0;
    for (const artifact of this.artifacts.values()) {
      if (!this.entries.has(artifact.operationId)) stoppedArtifactCount += 1;
    }
    for (const [artifactId, artifact] of this.artifacts) {
      if (stoppedArtifactCount <= MAX_STOPPED_ANALYSIS_ARTIFACTS) break;
      if (this.entries.has(artifact.operationId)) continue;
      this.artifacts.delete(artifactId);
      stoppedArtifactCount -= 1;
    }
  }

  private disposeEntry(entry: Entry): Promise<void> {
    entry.disposePromise ??= entry.session.dispose().catch(() => undefined);
    return entry.disposePromise;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((operationId) => this.stop(operationId)));
    this.artifacts.clear();
  }
}
