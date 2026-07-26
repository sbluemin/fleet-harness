import crypto from "node:crypto";

import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";

const PLUGIN_ID = "scuttlebutt";
const THREADS_KEY = "threads";
export const MAX_THREADS = 20;

export type ChatMessageDto = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: number;
};

export type ChatThreadDto = {
  readonly id: string;
  readonly title: string;
  readonly cliId: "claude" | "claude-kimi" | "codex";
  readonly model: string;
  readonly createdAt: number;
  readonly messages: readonly ChatMessageDto[];
};

export type ScuttlebuttSettings = {
  readonly enabled: true;
  readonly cliId: "claude";
  readonly model: string;
  readonly effort: null;
};

export function defaultScuttlebuttSettings(model: string): ScuttlebuttSettings {
  return { enabled: true, cliId: "claude", model, effort: null };
}

export class HistoryStore {
  private readonly storage: FleetPluginStorageHost;
  private readonly redact: (text: string) => string;
  private writeFlight: Promise<void> = Promise.resolve();

  constructor(storage: FleetPluginStorageHost, redact: (text: string) => string = (text) => text) {
    this.storage = storage;
    this.redact = redact;
  }

  async list(): Promise<readonly ChatThreadDto[]> {
    return sanitizeThreads(await this.storage.readJson(PLUGIN_ID, THREADS_KEY));
  }

  async create(input: Pick<ChatThreadDto, "id" | "cliId" | "model" | "createdAt">): Promise<ChatThreadDto> {
    const thread: ChatThreadDto = { ...input, title: "New chat", messages: [] };
    await this.update((threads) => [...threads.filter((candidate) => candidate.id !== thread.id), thread]);
    return thread;
  }

  async appendMessage(
    threadId: string,
    role: ChatMessageDto["role"],
    text: string,
    at = Date.now(),
  ): Promise<ChatThreadDto | null> {
    let updated: ChatThreadDto | null = null;
    await this.update((threads) => threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      const safeText = this.redact(text);
      const message: ChatMessageDto = { id: crypto.randomUUID(), role, text: safeText, at };
      updated = {
        ...thread,
        title: thread.messages.length === 0 && role === "user" ? titleFromMessage(safeText) : thread.title,
        messages: [...thread.messages, message],
      };
      return updated;
    }));
    return updated;
  }

  private update(mutate: (threads: readonly ChatThreadDto[]) => readonly ChatThreadDto[]): Promise<void> {
    const run = this.writeFlight.then(async () => {
      const current = sanitizeThreads(await this.storage.readJson(PLUGIN_ID, THREADS_KEY));
      const next = [...mutate(current)]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, MAX_THREADS);
      await this.storage.writeJson(PLUGIN_ID, THREADS_KEY, next);
    });
    this.writeFlight = run.catch(() => undefined);
    return run;
  }
}

export function sanitizeThreads(value: unknown): readonly ChatThreadDto[] {
  if (!Array.isArray(value)) return [];
  const threads: ChatThreadDto[] = [];
  for (const candidate of value) {
    const thread = sanitizeThread(candidate);
    if (thread) threads.push(thread);
  }
  return threads.sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_THREADS);
}

function sanitizeThread(value: unknown): ChatThreadDto | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.title !== "string"
    || !isCliId(value.cliId)
    || typeof value.model !== "string"
    || typeof value.createdAt !== "number"
    || !Array.isArray(value.messages)) return null;
  const messages: ChatMessageDto[] = [];
  for (const candidate of value.messages) {
    if (!isRecord(candidate)
      || typeof candidate.id !== "string"
      || (candidate.role !== "user" && candidate.role !== "assistant")
      || typeof candidate.text !== "string"
      || typeof candidate.at !== "number") continue;
    messages.push({
      id: candidate.id,
      role: candidate.role,
      text: candidate.text,
      at: candidate.at,
    });
  }
  return {
    id: value.id,
    title: value.title,
    cliId: value.cliId,
    model: value.model,
    createdAt: value.createdAt,
    messages,
  };
}

function titleFromMessage(text: string): string {
  const compact = text.trim().replace(/\s+/gu, " ");
  return compact.slice(0, 80) || "New chat";
}

function isCliId(value: unknown): value is ChatThreadDto["cliId"] {
  return value === "claude" || value === "claude-kimi" || value === "codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
