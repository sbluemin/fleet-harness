import type { AnalysisEvent, AnalysisSession } from "./analysis-types.js";

export const MAX_ANALYSIS_SESSIONS = 4;
export const MAX_ANALYSIS_ARTIFACTS = 32;
type Subscriber = (event: AnalysisEvent) => void;
type Entry = { readonly session: AnalysisSession; readonly subscribers: Set<Subscriber>; starting: boolean; messaging: boolean; stopped: boolean; disposePromise?: Promise<void> };
type StoredArtifact = { readonly operationId: string; readonly html: string };

export class AnalysisRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly artifacts = new Map<string, StoredArtifact>();

  async start(operationId: string, create: (onEvent: (event: AnalysisEvent) => void) => AnalysisSession): Promise<"started" | "stopped" | "exists" | "limit"> {
    if (this.entries.has(operationId)) return "exists";
    if (this.entries.size >= MAX_ANALYSIS_SESSIONS) return "limit";
    let entry: Entry | undefined;
    const session = create((event) => {
      if (!entry || entry.stopped) return;
      if (event.type === "artifact") this.storeArtifact(operationId, event.artifact.id, event.artifact.html);
      for (const subscriber of entry.subscribers) subscriber(event);
      if (event.type === "error" && event.error.code === "analysis_exited") void this.stopEntry(operationId, entry);
    });
    entry = { session, subscribers: new Set(), starting: true, messaging: false, stopped: false };
    this.entries.set(operationId, entry);
    try {
      await session.start();
      if (this.entries.get(operationId) !== entry || entry.stopped) {
        await this.disposeEntry(entry);
        return "stopped";
      }
      return "started";
    }
    catch (error) {
      if (this.entries.get(operationId) === entry) this.entries.delete(operationId);
      entry.stopped = true;
      entry.subscribers.clear();
      await this.disposeEntry(entry);
      throw error;
    }
    finally { entry.starting = false; }
  }

  async message(operationId: string, text: string): Promise<"accepted" | "not_found" | "busy"> {
    const entry = this.entries.get(operationId);
    if (!entry || entry.stopped) return "not_found";
    if (entry.starting || entry.messaging) return "busy";
    entry.messaging = true;
    void entry.session.send(text).catch(() => {
      for (const subscriber of entry.subscribers) subscriber({ type: "error", error: { code: "analysis_error", message: "Analysis request failed." } });
    }).finally(() => { entry.messaging = false; });
    return "accepted";
  }

  subscribe(operationId: string, subscriber: Subscriber): (() => void) | null {
    const entry = this.entries.get(operationId);
    if (!entry || entry.stopped) return null;
    entry.subscribers.add(subscriber);
    return () => entry.subscribers.delete(subscriber);
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

  private async stopEntry(operationId: string, entry: Entry): Promise<boolean> {
    if (this.entries.get(operationId) !== entry) return false;
    this.entries.delete(operationId);
    entry.stopped = true;
    entry.subscribers.clear();
    this.clearArtifacts(operationId);
    await this.disposeEntry(entry);
    return true;
  }

  private storeArtifact(operationId: string, artifactId: string, html: string): void {
    this.artifacts.delete(artifactId);
    this.artifacts.set(artifactId, { operationId, html });
    while (this.artifacts.size > MAX_ANALYSIS_ARTIFACTS) {
      const oldestId = this.artifacts.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.artifacts.delete(oldestId);
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
