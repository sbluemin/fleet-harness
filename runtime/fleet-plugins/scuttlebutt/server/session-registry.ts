import type { ChatEvent, ChatSessionLike } from "./chat-session.js";

export const MAX_ACTIVE_CHAT_SESSIONS = 4;

type Subscriber = (event: ChatEvent) => void;
type SessionStatus = "starting" | "idle" | "busy" | "stopped";
type Entry = {
  readonly session: ChatSessionLike;
  readonly subscribers: Set<Subscriber>;
  readonly createdAt: number;
  status: SessionStatus;
  assistantText: string;
  disposePromise?: Promise<void>;
};

export interface SessionRegistryHooks {
  readonly onUserMessage?: (chatId: string, text: string) => void | Promise<void>;
  readonly onAssistantMessage?: (chatId: string, text: string) => void | Promise<void>;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly hooks: SessionRegistryHooks;

  constructor(hooks: SessionRegistryHooks = {}) {
    this.hooks = hooks;
  }

  async start(
    chatId: string,
    create: (onEvent: (event: ChatEvent) => void) => ChatSessionLike,
  ): Promise<"started" | "exists" | "capacity" | "stopped"> {
    if (this.entries.has(chatId)) return "exists";
    if (this.entries.size >= MAX_ACTIVE_CHAT_SESSIONS && !await this.evictOldestIdle()) return "capacity";
    let entry: Entry | undefined;
    const session = create((event) => {
      if (!entry || entry.status === "stopped") return;
      if (event.type === "chunk") entry.assistantText += event.text;
      if (event.type === "complete") {
        entry.status = "idle";
        const answer = entry.assistantText;
        entry.assistantText = "";
        if (answer) void Promise.resolve(this.hooks.onAssistantMessage?.(chatId, answer)).catch(() => undefined);
      }
      this.publish(entry, event);
      if (event.type === "error" && event.error.code === "chat_exited") void this.stopEntry(chatId, entry);
    });
    entry = {
      session,
      subscribers: new Set(),
      createdAt: Date.now(),
      status: "starting",
      assistantText: "",
    };
    this.entries.set(chatId, entry);
    try {
      await session.start();
      if (this.entries.get(chatId) !== entry || entry.status === "stopped") {
        await this.disposeEntry(entry);
        return "stopped";
      }
      entry.status = "idle";
      return "started";
    } catch (error) {
      if (this.entries.get(chatId) === entry) this.entries.delete(chatId);
      entry.status = "stopped";
      entry.subscribers.clear();
      await this.disposeEntry(entry);
      throw error;
    }
  }

  async message(chatId: string, text: string): Promise<"accepted" | "not_found" | "busy"> {
    const entry = this.entries.get(chatId);
    if (!entry || entry.status === "stopped") return "not_found";
    if (entry.status !== "idle") return "busy";
    entry.status = "busy";
    entry.assistantText = "";
    try {
      await this.hooks.onUserMessage?.(chatId, text);
    } catch (error) {
      entry.status = "idle";
      throw error;
    }
    void entry.session.send(text).catch(() => {
      if (this.entries.get(chatId) !== entry || entry.status === "stopped") return;
      entry.status = "idle";
      this.publish(entry, {
        type: "error",
        error: { code: "chat_error", message: "Chat request failed." },
      });
    });
    return "accepted";
  }

  subscribe(chatId: string, subscriber: Subscriber): (() => void) | null {
    const entry = this.entries.get(chatId);
    if (!entry || entry.status === "stopped") return null;
    entry.subscribers.add(subscriber);
    return () => entry.subscribers.delete(subscriber);
  }

  status(chatId: string): SessionStatus | null {
    return this.entries.get(chatId)?.status ?? null;
  }

  async stop(chatId: string): Promise<boolean> {
    const entry = this.entries.get(chatId);
    if (!entry) return false;
    return this.stopEntry(chatId, entry);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((chatId) => this.stop(chatId)));
  }

  private publish(entry: Entry, event: ChatEvent): void {
    if (entry.status === "stopped") return;
    for (const subscriber of entry.subscribers) subscriber(event);
  }

  private async evictOldestIdle(): Promise<boolean> {
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.status === "idle")
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!idle) return false;
    await this.stopEntry(idle[0], idle[1]);
    return true;
  }

  private async stopEntry(chatId: string, entry: Entry): Promise<boolean> {
    if (this.entries.get(chatId) !== entry) return false;
    this.entries.delete(chatId);
    entry.status = "stopped";
    entry.subscribers.clear();
    await this.disposeEntry(entry);
    return true;
  }

  private disposeEntry(entry: Entry): Promise<void> {
    entry.disposePromise ??= entry.session.dispose().catch(() => undefined);
    return entry.disposePromise;
  }
}
