import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiDraftPort, WikiDraftSnapshot, WikiDraftWriteRequest } from "../tools/draft.js";
import type { CoworkSessionRecord, CoworkStoredEvent, CoworkTranscriptTurn } from "./types.js";

const EVENT_LOG_CAP = 100;

/**
 * 진행 중 Cowork 편집은 휘발성이다 — 서버 메모리에만 유지하고 디스크에 쓰지 않는다.
 * Apply를 통과한 결과만 위키 패치 파이프라인으로 영속화되며, 서버 재시작 시
 * 진행 중 draft는 의도적으로 소멸한다. 모든 갱신이 동기 Map 연산이므로 draft CAS에
 * 별도 직렬화가 필요 없다.
 */
export class CoworkStore {
  private readonly sessions = new Map<string, CoworkSessionRecord>();
  private readonly transcripts = new Map<string, CoworkTranscriptTurn[]>();
  private readonly eventLogs = new Map<string, CoworkStoredEvent[]>();
  private readonly scratchDirs = new Map<string, string>();
  private readonly writers = new Map<string, string>();

  private key(workspaceId: string, sessionId: string) { return `${workspaceId}:${sessionId}`; }

  async create(workspaceId: string, entryId: string, body: string, baseVersion = 0, baseHash = hash(body), identity?: { cli?: string; model?: string; effort?: string }, targetPath?: string): Promise<CoworkSessionRecord> {
    const existing = this.writers.get(`${workspaceId}:${entryId}`);
    if (existing) { const found = await this.get(workspaceId, existing); if (found && found.state !== "closed" && found.state !== "applied") return found; }
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    const record: CoworkSessionRecord = { id, workspaceId, entryId, state: "idle", revision: 0, draft: body, baseDraft: body, baseHash, baseVersion, selection: null, annotations: [], ...identity, targetPath, createdAt: now, updatedAt: now };
    this.sessions.set(this.key(workspaceId, id), record);
    this.writers.set(`${workspaceId}:${entryId}`, id);
    return record;
  }

  async get(workspaceId: string, sessionId: string): Promise<CoworkSessionRecord | null> { return this.sessions.get(this.key(workspaceId, sessionId)) ?? null; }

  async update(workspaceId: string, sessionId: string, fn: (value: CoworkSessionRecord) => CoworkSessionRecord): Promise<CoworkSessionRecord> {
    const old = this.sessions.get(this.key(workspaceId, sessionId));
    if (!old) throw new Error("cowork_session_not_found");
    const next = { ...fn(old), updatedAt: new Date().toISOString() };
    this.sessions.set(this.key(workspaceId, sessionId), next);
    return next;
  }

  async activeForEntry(workspaceId: string, entryId: string): Promise<CoworkSessionRecord | null> {
    const id = this.writers.get(`${workspaceId}:${entryId}`);
    if (!id) return null;
    const s = await this.get(workspaceId, id);
    return s && s.state !== "closed" && s.state !== "applied" ? s : null;
  }

  draftPort(workspaceId: string, sessionId: string): WikiDraftPort {
    return {
      read: async (): Promise<WikiDraftSnapshot> => { const s = await this.get(workspaceId, sessionId); if (!s) throw new Error("cowork_session_not_found"); return { body: s.draft, revision: s.revision }; },
      write: async (request: WikiDraftWriteRequest): Promise<WikiDraftSnapshot> => {
        if (request.body.length > 1024 * 1024) throw new Error("wiki draft rejected: body exceeds 1MB");
        const s = await this.update(workspaceId, sessionId, old => {
          if (old.state !== "running") throw new Error("wiki draft rejected: session is not running");
          if (request.expectedRevision !== undefined && old.revision !== request.expectedRevision) throw new Error(`wiki draft revision conflict: expected ${request.expectedRevision}, current ${old.revision}`);
          return { ...old, draft: request.body, revision: old.revision + 1 };
        });
        return { body: s.draft, revision: s.revision };
      },
    };
  }

  async transcript(workspaceId: string, sessionId: string): Promise<CoworkTranscriptTurn[]> { return [...(this.transcripts.get(this.key(workspaceId, sessionId)) ?? [])]; }
  async appendTranscript(workspaceId: string, sessionId: string, turn: CoworkTranscriptTurn) { const key = this.key(workspaceId, sessionId); const all = this.transcripts.get(key) ?? []; all.push(turn); this.transcripts.set(key, all); }

  async events(workspaceId: string, sessionId: string): Promise<CoworkStoredEvent[]> { return [...(this.eventLogs.get(this.key(workspaceId, sessionId)) ?? [])]; }
  async appendEvent(workspaceId: string, sessionId: string, event: Omit<CoworkStoredEvent, "id">): Promise<CoworkStoredEvent> {
    const key = this.key(workspaceId, sessionId);
    const all = this.eventLogs.get(key) ?? [];
    const stored: CoworkStoredEvent = { ...event, id: (all.at(-1)?.id ?? 0) + 1 };
    all.push(stored);
    this.eventLogs.set(key, all.slice(-EVENT_LOG_CAP));
    return stored;
  }

  /** provider CLI의 cwd — 빈 임시 디렉터리로 CLI가 스스로 읽을 수 있는 범위를 최소화한다. */
  async sessionDir(workspaceId: string, sessionId: string): Promise<string> {
    const key = this.key(workspaceId, sessionId);
    let dir = this.scratchDirs.get(key);
    if (!dir) { dir = await mkdtemp(join(tmpdir(), "fleet-cowork-")); this.scratchDirs.set(key, dir); }
    return dir;
  }

  release(record: CoworkSessionRecord) {
    this.writers.delete(`${record.workspaceId}:${record.entryId}`);
    const key = this.key(record.workspaceId, record.id);
    const dir = this.scratchDirs.get(key);
    this.scratchDirs.delete(key);
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function hash(value: string) { return crypto.createHash("sha256").update(value).digest("hex"); }
