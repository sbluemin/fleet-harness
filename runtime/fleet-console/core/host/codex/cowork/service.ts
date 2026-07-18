import { approvePatch, computeContentHash, enqueuePatch, readPatchFile, readWikiEntry } from "@dotobokuri/fleet-wiki";
import type { MemoryPaths, Patch, WikiEntry, WikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";
import type { AcpPermissionRequestParams, AcpPermissionResponse } from "@dotobokuri/core-unified-agent";
import { join } from "node:path";
import { UnifiedAgent } from "@dotobokuri/core-unified-agent";
import type { IUnifiedAgentClient, UnifiedClientOptions } from "@dotobokuri/core-unified-agent";
import type { CoworkEventDto, CoworkSessionDto } from "../api-types.js";
import { createCoworkMcpRuntime } from "./runtime.js";
import { CoworkStore } from "./store.js";
import type { CoworkSessionRecord, CoworkStoredEvent } from "./types.js";

export interface CoworkConnector { connect(options: UnifiedClientOptions): Promise<IUnifiedAgentClient>; }
export class CoworkService {
  private readonly live = new Map<string, IUnifiedAgentClient>();
  private readonly listeners = new Map<string, Set<(event: CoworkStoredEvent) => void>>();
  constructor(readonly store: CoworkStore, private readonly paths: MemoryPaths, private readonly cwd: string, private readonly connector: CoworkConnector = UnifiedAgent, private readonly resolver?: WikiWorkspaceResolver) {}
  async create(workspaceId: string, entryId: string): Promise<CoworkSessionRecord> { const entry = await readWikiEntry(entryId, this.paths); if (!entry) throw new Error("cowork_entry_not_found"); const markdown = await readPatchFile(join(this.paths.wikiDir, `${entryId}.md`)); return this.store.create(workspaceId, entryId, markdown, entry.version, computeContentHash(markdown)); }
  async get(workspaceId: string, id: string) { return this.store.get(workspaceId, id); }
  async setSelection(workspaceId: string, id: string, selection: string | null) { return this.changed(await this.store.update(workspaceId, id, s => ({ ...s, selection }))); }
  async annotations(workspaceId: string, id: string, annotations: CoworkSessionRecord["annotations"]) { return this.changed(await this.store.update(workspaceId, id, s => ({ ...s, annotations }))); }
  async prompt(workspaceId: string, id: string, prompt: string) {
    let session = await this.required(workspaceId, id); if (session.state === "running") throw new Error("cowork_busy");
    const annotations = session.annotations; session = await this.changed(await this.store.update(workspaceId, id, s => ({ ...s, state: "running", annotations: [] })));
    await this.store.appendTranscript(workspaceId, id, { role: "user", text: prompt, at: new Date().toISOString() });
    const runtime = createCoworkMcpRuntime(this.store, workspaceId, id, this.resolver);
    const mcp = await runtime.manager.createExecutorMcpSession({ serverName: "cowork", specs: runtime.specs, cwd: this.cwd });
    const client = await this.connector.connect({ cwd: this.cwd, cli: session.cli as UnifiedClientOptions["cli"], model: session.model, effort: session.effort, sessionId: session.providerSessionId, mcpServers: [mcp.mcpServer], ...runtime.connection });
    this.live.set(id, client); client.on("permissionRequest", (params, resolve) => resolve(permissionResponse(params, runtime.allowedToolIds)));
    client.on("messageChunk", (text) => { void this.store.appendTranscript(workspaceId, id, { role: "assistant", text, at: new Date().toISOString() }); void this.emit(workspaceId, id, "transcript", text); });
    client.on("promptComplete", () => { void this.store.update(workspaceId, id, s => ({ ...s, state: "idle", providerSessionId: client.getConnectionInfo().sessionId ?? s.providerSessionId })).then(s => this.changed(s)).then(() => this.emit(workspaceId, id, "done")); });
    client.on("error", (error) => { void this.store.update(workspaceId, id, s => ({ ...s, state: "idle" })).then(s => this.changed(s)).then(() => this.emit(workspaceId, id, "error", error.message)); });
    void client.sendMessage(this.composePrompt(prompt, annotations, session.selection)); return session;
  }
  async cancel(workspaceId: string, id: string) { const client = this.live.get(id); if (client) await client.cancelPrompt(); return this.changed(await this.store.update(workspaceId, id, s => s.state === "running" ? { ...s, state: "idle" } : s)); }
  async close(workspaceId: string, id: string) { await this.live.get(id)?.disconnect(); this.live.delete(id); const s = await this.store.update(workspaceId, id, old => ({ ...old, state: "closed" })); this.store.release(s); return this.changed(s); }
  async apply(workspaceId: string, id: string): Promise<CoworkSessionRecord> { const s = await this.required(workspaceId, id); let entry: WikiEntry; try { entry = parseDraft(s.draft); } catch { throw new Error("cowork_apply_invalid_draft"); } entry = { ...entry, version: s.baseVersion + 1, updated: new Date().toISOString() }; const patch: Patch = { frontmatter: { op: "update_wiki", target: `wiki/${s.entryId}.md`, summary: `Cowork update ${s.entryId}`, proposer: "codex-cowork", created: new Date().toISOString() }, body: JSON.stringify(entry) }; try { const patchId = await enqueuePatch(patch, this.paths, { baseVersion: s.baseVersion, baseHash: s.baseHash }); await approvePatch(patchId, this.paths); const applied = await this.store.update(workspaceId, id, x => ({ ...x, state: "applied" })); this.store.release(applied); return this.changed(applied); } catch (e) { const message = e instanceof Error ? e.message : "unknown"; throw new Error(message.includes("stale base") ? "cowork_apply_stale" : `cowork_apply_failed:${message}`); } }
  dto(session: CoworkSessionRecord): CoworkSessionDto { const { providerSessionId: _p, cli: _c, model: _m, effort: _e, createdAt: _a, updatedAt: _u, ...dto } = session; return dto; }
  subscribe(id: string, cb: (event: CoworkStoredEvent) => void) { const set = this.listeners.get(id) ?? new Set(); set.add(cb); this.listeners.set(id, set); return () => set.delete(cb); }
  async replay(workspaceId: string, id: string, after = 0) { return (await this.store.events(workspaceId, id)).filter(e => e.id > after); }
  private composePrompt(prompt: string, annotations: CoworkSessionRecord["annotations"], selection: string | null) { return JSON.stringify({ prompt, annotations, selection: selection ? { quote: selection } : undefined }); }
  private async changed(s: CoworkSessionRecord) { await this.emit(s.workspaceId, s.id, "session"); return s; }
  private async emit(workspaceId: string, id: string, type: CoworkStoredEvent["type"], text?: string) { const s = await this.required(workspaceId, id); const event = await this.store.appendEvent(workspaceId, id, { type, text, session: this.dto(s) }); for (const cb of this.listeners.get(id) ?? []) cb(event); }
  private async required(workspaceId: string, id: string) { const s = await this.get(workspaceId, id); if (!s) throw new Error("cowork_session_not_found"); return s; }
}

export function permissionResponse(params: AcpPermissionRequestParams, allowed: readonly string[]): AcpPermissionResponse {
  const tool = params.toolCall.title ?? ""; const permitted = allowed.some(id => tool === id || tool.endsWith(`__${id}`) || tool.endsWith(`.${id}`));
  const option = permitted ? params.options.find(x => x.kind === "allow_once") ?? params.options.find(x => x.kind === "allow_always") : params.options.find(x => x.kind === "reject_once") ?? params.options.find(x => x.kind === "reject_always");
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
function parseDraft(markdown: string): WikiEntry { const match = markdown.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if (!match) throw new Error("missing frontmatter"); const values: Record<string, unknown> = {}; for (const line of match[1]!.split("\n")) { const at = line.indexOf(":"); if (at < 1) throw new Error("invalid frontmatter"); const key = line.slice(0, at).trim(); const raw = line.slice(at + 1).trim(); values[key] = raw.startsWith("[") ? JSON.parse(raw) : raw.startsWith('"') ? JSON.parse(raw) : /^-?\d+$/.test(raw) ? Number(raw) : raw; } if (typeof values.id !== "string" || typeof values.title !== "string" || !Array.isArray(values.tags) || typeof values.created !== "string" || typeof values.updated !== "string" || typeof values.version !== "number") throw new Error("invalid entry"); return { ...values, tags: values.tags as string[], body: match[2]! } as WikiEntry; }
