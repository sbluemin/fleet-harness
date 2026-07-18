import type { AnalysisEvent, AnalysisSession } from "./analysis-types.js";

export const MAX_ANALYSIS_SESSIONS = 4;
type Subscriber = (event: AnalysisEvent) => void;
type Entry = { readonly session: AnalysisSession; readonly subscribers: Set<Subscriber>; starting: boolean; messaging: boolean; stopped: boolean };

export class AnalysisRegistry {
  private readonly entries = new Map<string, Entry>();

  async start(operationId: string, create: (onEvent: (event: AnalysisEvent) => void) => AnalysisSession): Promise<"started" | "exists" | "limit"> {
    if (this.entries.has(operationId)) return "exists";
    if (this.entries.size >= MAX_ANALYSIS_SESSIONS) return "limit";
    let entry: Entry;
    const session = create((event) => { if (!entry.stopped) for (const subscriber of entry.subscribers) subscriber(event); });
    entry = { session, subscribers: new Set(), starting: true, messaging: false, stopped: false };
    this.entries.set(operationId, entry);
    try { await session.start(); return "started"; }
    catch (error) { this.entries.delete(operationId); await session.dispose().catch(() => undefined); throw error; }
    finally { entry.starting = false; }
  }

  async message(operationId: string, text: string): Promise<"accepted" | "not_found" | "busy"> {
    const entry = this.entries.get(operationId);
    if (!entry || entry.stopped) return "not_found";
    if (entry.starting || entry.messaging) return "busy";
    entry.messaging = true;
    void entry.session.send(text).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Analysis request failed.";
      for (const subscriber of entry.subscribers) subscriber({ type: "error", error: { code: "analysis_error", message } });
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
    this.entries.delete(operationId);
    entry.stopped = true;
    entry.subscribers.clear();
    await entry.session.dispose().catch(() => undefined);
    return true;
  }

  async dispose(): Promise<void> { await Promise.all([...this.entries.keys()].map((operationId) => this.stop(operationId))); }
}
