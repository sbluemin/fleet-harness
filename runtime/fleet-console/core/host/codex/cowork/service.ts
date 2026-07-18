import { approvePatch, enqueuePatch, readWikiEntry } from "@dotobokuri/fleet-wiki";
import type { MemoryPaths, Patch } from "@dotobokuri/fleet-wiki";
import type { CoworkSessionDto } from "../api-types.js";
import { CoworkStore } from "./store.js";
import type { CoworkSessionRecord } from "./types.js";

export class CoworkService {
  constructor(readonly store: CoworkStore, private readonly paths: MemoryPaths) {}
  async create(workspaceId: string, entryId: string): Promise<CoworkSessionRecord> {
    const entry = await readWikiEntry(entryId, this.paths);
    if (!entry) throw new Error("cowork_entry_not_found");
    return this.store.create(workspaceId, entryId, JSON.stringify(entry, null, 2), entry.version);
  }
  async get(workspaceId: string, id: string) { return this.store.get(workspaceId, id); }
  async setSelection(workspaceId: string, id: string, selection: string | null) { return this.store.update(workspaceId, id, s => ({ ...s, selection })); }
  async annotations(workspaceId: string, id: string, annotations: CoworkSessionRecord["annotations"]) { return this.store.update(workspaceId, id, s => ({ ...s, annotations })); }
  async prompt(workspaceId: string, id: string, prompt: string) { return this.store.update(workspaceId, id, s => { if (s.state === "running") throw new Error("cowork_busy"); return { ...s, state: "running", annotations: [] }; }); }
  async cancel(workspaceId: string, id: string) { return this.store.update(workspaceId, id, s => s.state === "running" ? { ...s, state: "idle" } : s); }
  async close(workspaceId: string, id: string) { const s = await this.store.update(workspaceId, id, old => ({ ...old, state: "closed" })); this.store.release(s); return s; }
  async apply(workspaceId: string, id: string): Promise<CoworkSessionRecord> {
    const session = await this.required(workspaceId, id);
    const patch: Patch = { frontmatter: { op: "update_wiki", target: `wiki/${session.entryId}.md`, summary: `Cowork update ${session.entryId}`, proposer: "codex-cowork", created: new Date().toISOString() }, body: session.draft };
    const patchId = await enqueuePatch(patch, this.paths, { baseHash: session.baseHash, baseVersion: session.baseVersion } as never);
    await approvePatch(patchId, this.paths);
    const applied = await this.store.update(workspaceId, id, s => ({ ...s, state: "applied" })); this.store.release(applied); return applied;
  }
  dto(session: CoworkSessionRecord): CoworkSessionDto { const { providerSessionId: _provider, cli: _cli, model: _model, effort: _effort, createdAt: _created, updatedAt: _updated, ...dto } = session; return dto; }
  private async required(workspaceId: string, id: string) { const s = await this.get(workspaceId, id); if (!s) throw new Error("cowork_session_not_found"); return s; }
}
