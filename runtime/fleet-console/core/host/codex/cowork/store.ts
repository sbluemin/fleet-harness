import crypto from "node:crypto";
import { mkdir, readFile, rename, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WikiDraftPort, WikiDraftSnapshot, WikiDraftWriteRequest } from "@dotobokuri/fleet-wiki";
import type { CoworkSessionRecord, CoworkStoredEvent, CoworkTranscriptTurn } from "./types.js";

const FILE = "session.json";
export class CoworkStore {
  private readonly writers = new Map<string, string>();
  constructor(private readonly root: string) {}
  private dir(workspaceId: string, sessionId: string) { return join(this.root, "codex-cowork", safe(workspaceId), safe(sessionId)); }
  sessionDir(workspaceId: string, sessionId: string) { return this.dir(workspaceId, sessionId); }
  private file(workspaceId: string, sessionId: string) { return join(this.dir(workspaceId, sessionId), FILE); }
  async create(workspaceId: string, entryId: string, body: string, baseVersion = 0, baseHash = hash(body), identity?: { cli?: string; model?: string; effort?: string }): Promise<CoworkSessionRecord> {
    const existing = this.writers.get(`${workspaceId}:${entryId}`);
    if (existing) { const found = await this.get(workspaceId, existing); if (found && found.state !== "closed" && found.state !== "applied") return found; }
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    const record: CoworkSessionRecord = { id, workspaceId, entryId, state: "idle", revision: 0, draft: body, baseDraft: body, baseHash, baseVersion, selection: null, annotations: [], ...identity, createdAt: now, updatedAt: now };
    await this.save(record); this.writers.set(`${workspaceId}:${entryId}`, id); return record;
  }
  async get(workspaceId: string, sessionId: string): Promise<CoworkSessionRecord | null> { try { return JSON.parse(await readFile(this.file(workspaceId, sessionId), "utf8")) as CoworkSessionRecord; } catch { return null; } }
  async save(record: CoworkSessionRecord): Promise<void> { const dir = this.dir(record.workspaceId, record.id); await mkdir(dir, { recursive: true }); const next = { ...record, updatedAt: new Date().toISOString() }; const temp = join(dir, `${FILE}.${crypto.randomUUID()}.tmp`); await writeFile(temp, JSON.stringify(next), "utf8"); await rename(temp, this.file(record.workspaceId, record.id)); }
  async update(workspaceId: string, sessionId: string, fn: (value: CoworkSessionRecord) => CoworkSessionRecord): Promise<CoworkSessionRecord> { const old = await this.get(workspaceId, sessionId); if (!old) throw new Error("cowork_session_not_found"); const next = fn(old); await this.save(next); return next; }
  draftPort(workspaceId: string, sessionId: string): WikiDraftPort { return { read: async (): Promise<WikiDraftSnapshot> => { const s = await this.get(workspaceId, sessionId); if (!s) throw new Error("cowork_session_not_found"); return { body: s.draft, revision: s.revision }; }, write: async (request: WikiDraftWriteRequest): Promise<WikiDraftSnapshot> => { if (request.body.length > 1024 * 1024) throw new Error("wiki draft rejected: body exceeds 1MB"); const s = await this.update(workspaceId, sessionId, old => { if (old.state !== "running") throw new Error("wiki draft rejected: session is not running"); if (request.expectedRevision !== undefined && old.revision !== request.expectedRevision) throw new Error(`wiki draft revision conflict: expected ${request.expectedRevision}, current ${old.revision}`); return { ...old, draft: request.body, revision: old.revision + 1 }; }); return { body: s.draft, revision: s.revision }; } }; }
  async transcript(workspaceId: string, sessionId: string): Promise<CoworkTranscriptTurn[]> { return this.readJson(join(this.dir(workspaceId, sessionId), "transcript.json"), []); }
  async appendTranscript(workspaceId: string, sessionId: string, turn: CoworkTranscriptTurn) { await this.serialize(`${workspaceId}:${sessionId}:transcript`, async () => { const all = await this.transcript(workspaceId, sessionId); all.push(turn); await this.atomic(join(this.dir(workspaceId, sessionId), "transcript.json"), all); }); }
  async events(workspaceId: string, sessionId: string): Promise<CoworkStoredEvent[]> { return this.readJson(join(this.dir(workspaceId, sessionId), "events.json"), []); }
  async appendEvent(workspaceId: string, sessionId: string, event: Omit<CoworkStoredEvent, "id">): Promise<CoworkStoredEvent> { return this.serialize(`${workspaceId}:${sessionId}:events`, async () => { const all = await this.events(workspaceId, sessionId); const stored: CoworkStoredEvent = { ...event, id: (all.at(-1)?.id ?? 0) + 1 }; all.push(stored); await this.atomic(join(this.dir(workspaceId, sessionId), "events.json"), all.slice(-100)); return stored; }); }
  async hydrate(): Promise<void> { try { for (const ws of await readdir(join(this.root, "codex-cowork"))) { for (const id of await readdir(join(this.root, "codex-cowork", ws))) { const s = await this.get(ws, id); if (s && s.state !== "closed" && s.state !== "applied") this.writers.set(`${s.workspaceId}:${s.entryId}`, s.id); } } } catch { /* empty root */ } }
  release(record: CoworkSessionRecord) { this.writers.delete(`${record.workspaceId}:${record.entryId}`); }
  private readonly appendQueues = new Map<string, Promise<unknown>>();
  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> { const previous = this.appendQueues.get(key) ?? Promise.resolve(); const next = previous.then(task, task); this.appendQueues.set(key, next.catch(() => undefined)); return next; }
  private async readJson<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; } }
  private async atomic(file: string, value: unknown) { await mkdir(join(file, ".."), { recursive: true }); const temp = `${file}.${crypto.randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value), "utf8"); await rename(temp, file); }
}
function safe(value: string) { if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error("invalid cowork id"); return value; }
function hash(value: string) { return crypto.createHash("sha256").update(value).digest("hex"); }
