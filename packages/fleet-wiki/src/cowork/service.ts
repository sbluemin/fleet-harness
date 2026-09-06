import { createExecutorSessionManager, createServedMcpEndpoint, createMcpToolRegistry, createMcpToolSnapshotStore } from "@dotobokuri/core-agent";
import { approvePatch, enqueuePatch } from "../patch.js";
import { computeContentHash, readPatchFile, readWikiEntry, resolveWikiEntryPath } from "../store.js";
import { createWikiDraftToolSpecs } from "../tools/draft.js";
import { getWikiToolSpecs } from "../agent-specs.js";
import type { MemoryPaths, Patch, WikiEntry } from "../types.js";
import type { WikiWorkspaceResolver } from "../workspace-resolver.js";
import { join } from "node:path";
import { COWORK_SYSTEM_PROMPT } from "./store.js";
import type { CoworkStore } from "./store.js";
import type { CoworkAnnotationDto, CoworkSessionDto, CoworkSessionRecord, CoworkStoredEvent } from "./store.js";

/** The per-session registry is deliberately not shared with global Wiki tools. */
export function createCoworkMcpRuntime(store: CoworkStore, workspaceId: string, sessionId: string, resolver?: WikiWorkspaceResolver) {
  const registry = createMcpToolRegistry();
  const snapshots = createMcpToolSnapshotStore();
  const server = createServedMcpEndpoint({ toolSnapshotStore: snapshots });
  const manager = createExecutorSessionManager({ runtimes: [{ name: "cowork", runtime: { registry, snapshotStore: snapshots, server } }] });
  const draftTools = createWikiDraftToolSpecs({ draft: store.draftPort(workspaceId, sessionId) });
  const allowedToolIds = ["wiki_draft_read", "wiki_draft_edit", "wiki_draft_write", "wiki_briefing", "wiki_orient", "wiki_read", "wiki_resolve"] as const;
  const specs = [...draftTools, ...getWikiToolSpecs(resolver).filter(spec => allowedToolIds.includes(spec.id as typeof allowedToolIds[number]))];
  // The session-token snapshot scopes tools/list, but the executor call router still
  // invokes through the registry — the same seven specs must be registered there too.
  for (const spec of specs) registry.registerAgentTool(spec);
  // 스코프 강제는 전용 MCP 도구 집합과 현재 게이트웨이 턴 정책이 담당한다.
  return { registry, snapshots, server, manager, specs, allowedToolIds };
}

/**
 * 호스트가 주입하는 provider 클라이언트의 최소 표면 — fleet-wiki 독트린상 이 패키지는
 * provider 조립을 알지 못하며, 커넥터는 반드시 호스트가 소유한다.
 */
export interface CoworkAgentClient {
  on(event: "toolCall", listener: (title: unknown, status: unknown) => void): unknown;
  on(event: "toolCallUpdate", listener: (title: unknown, status: unknown, sessionId?: unknown, data?: unknown) => void): unknown;
  on(event: "messageChunk", listener: (text: string) => void): unknown;
  on(event: "promptComplete", listener: () => void): unknown;
  on(event: "error", listener: (error?: { message?: unknown }) => void): unknown;
  sendMessage(content: string): Promise<unknown>;
  cancelPrompt(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CoworkConnectOptions {
  cwd: string;
  model?: string;
  effort?: string;
  systemPrompt: string;
  mcpServers: readonly unknown[];
  /** 이 세션에 노출되는 도구 id. 도메인이 정하고 호스트가 사전승인에 쓴다. */
  allowedToolIds: readonly string[];
}

export interface CoworkConnector { connect(options: CoworkConnectOptions): Promise<CoworkAgentClient>; }

/** 원샷 프롬프트에 실어 보내는 이전 대화 턴 수 상한 — 도화지(draft)가 상태를 들고 있으므로 맥락만 보태면 된다. */
const HISTORY_TURNS = 12;
function clipText(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function normalizeAnnotations(annotations: CoworkSessionRecord["annotations"]): CoworkAnnotationDto[] { return annotations.map(({ id, quote, comment, start, end }) => ({ id, quote, comment, ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) })); }

interface LiveResources { workspaceId: string; client: CoworkAgentClient; annotations: CoworkSessionRecord["annotations"]; cleanup: () => void; }

export class CoworkService {
  private readonly live = new Map<string, LiveResources>();
  private readonly listeners = new Map<string, Set<(event: CoworkStoredEvent) => void>>();
  private readonly streamBuffers = new Map<string, string>();
  constructor(readonly store: CoworkStore, private readonly paths: MemoryPaths, private readonly cwd: string, private readonly connector: CoworkConnector, private readonly resolver?: WikiWorkspaceResolver) {}

  async create(workspaceId: string, entryId: string, identity?: { cli?: string; model?: string; effort?: string }): Promise<CoworkSessionRecord> {
    const entry = await readWikiEntry(entryId, this.paths);
    if (!entry) throw new Error("cowork_entry_not_found");
    // readWikiEntry와 같은 해석 체인으로 실제 파일 경로를 얻는다 — 인덱스가 스테일해도
    // 재귀 스캔으로 찾아지는 중첩 엔트리(wiki/queries/…)의 편집이 막히면 안 된다.
    const target = await resolveWikiEntryPath(entryId, this.paths) ?? `wiki/${entryId}.md`;
    const markdown = await readPatchFile(join(this.paths.root, target));
    return this.store.create(workspaceId, entryId, markdown, entry.version, computeContentHash(markdown), identity, target);
  }

  async settings(workspaceId: string, id: string, identity: { cli?: string; model?: string; effort?: string }) { return this.changed(await this.store.update(workspaceId, id, s => ({ ...s, ...identity }))); }
  async get(workspaceId: string, id: string) { return this.store.get(workspaceId, id); }
  async peek(workspaceId: string, entryId: string) { return this.store.activeForEntry(workspaceId, entryId); }
  async setSelection(workspaceId: string, id: string, selection: string | null) { return this.changed(await this.store.update(workspaceId, id, s => ({ ...s, selection }))); }
  async annotations(workspaceId: string, id: string, annotations: CoworkSessionRecord["annotations"]) { return this.changed(await this.store.update(workspaceId, id, s => ({ ...s, annotations: normalizeAnnotations(annotations) }))); }

  async prompt(workspaceId: string, id: string, prompt: string) {
    let session = await this.required(workspaceId, id);
    if (session.state === "running") throw new Error("cowork_busy");
    if (session.state !== "idle") throw new Error("cowork_session_not_editable");
    const annotations = session.annotations;
    // 원샷 실행이라 provider는 이전 턴을 모른다 — 이번 프롬프트 이전까지의 대화를 실어 맥락을 복원한다.
    const history = (await this.store.transcript(workspaceId, id)).slice(-HISTORY_TURNS).map(turn => ({ role: turn.role, text: clipText(turn.text, 2000) }));
    session = await this.changed(await this.store.update(workspaceId, id, s => ({ ...s, state: "running", annotations: [] })));
    await this.store.appendTranscript(workspaceId, id, { role: "user", text: prompt, at: new Date().toISOString() });
    try {
      const runtime = createCoworkMcpRuntime(this.store, workspaceId, id, this.resolver);
      const mcp = await runtime.manager.createExecutorMcpSession({ serverName: "cowork", specs: runtime.specs, cwd: this.cwd });
      // Provider cwd is the session's own directory — minimizes what a backend CLI can read on its own.
      // 원샷 실행: provider 세션을 resume하지 않고 매 프롬프트마다 새로 연결한다.
      // 스코프 강제는 전용 MCP 도구 집합과 현재 게이트웨이 턴 정책이 담당한다.
      const providerCwd = await this.store.sessionDir(workspaceId, id);
      const client = await this.connector.connect({ cwd: providerCwd, model: session.model, effort: session.effort, systemPrompt: COWORK_SYSTEM_PROMPT, mcpServers: [mcp.mcpServer], allowedToolIds: [...runtime.allowedToolIds] });
      this.releaseLive(id);
      this.live.set(id, { workspaceId, client, annotations, cleanup: () => { try { mcp.cleanup(); } catch { /* already released */ } } });
      client.on("toolCall", (title, status) => { void this.emit(workspaceId, id, "tool", `${String(title).slice(0, 80)} · ${String(status).slice(0, 24)}`, false); });
      client.on("toolCallUpdate", (title, status, _sid, data) => { void this.emit(workspaceId, id, "tool", `${String(title).slice(0, 80)} · ${String(status).slice(0, 24)}${data ? ` · ${JSON.stringify(data).slice(0, 220)}` : ""}`, false).then(() => this.emit(workspaceId, id, "session")); });
      client.on("messageChunk", (text) => { this.streamBuffers.set(id, (this.streamBuffers.get(id) ?? "") + text); void this.emit(workspaceId, id, "transcript", text, false); });
      client.on("promptComplete", () => { void this.finishPrompt(workspaceId, id, client, null); });
      // 커넥터가 `cowork_*` 코드로 분류한 실패는 그 코드를 클라이언트까지 보낸다 — 시간 초과·꺼진 모델처럼
      // 사용자가 고칠 수 있는 원인은 코드가 있어야 안내가 선다. 그 밖의 원문 메시지는 로그에만 남긴다.
      client.on("error", (error) => {
        const message = error && typeof error === "object" && "message" in error ? error.message : error;
        const detail = error && typeof error === "object" && "detail" in error ? (error as { detail?: unknown }).detail : undefined;
        console.error(`[cowork] provider error (session ${id}):`, detail ?? message);
        void this.finishPrompt(workspaceId, id, client, coworkErrorCode(message));
      });
      client.sendMessage(this.composePrompt(prompt, annotations, session.selection, history)).catch((error: unknown) => {
        console.error(`[cowork] sendMessage failed (session ${id}):`, error instanceof Error ? error.message : error);
        void this.finishPrompt(workspaceId, id, client, "provider_error");
      });
      return session;
    } catch (error) {
      console.error(`[cowork] prompt setup failed (session ${id}):`, error instanceof Error ? error.message : error);
      this.releaseLive(id);
      await this.flushAssistantTurn(workspaceId, id);
      // 전송이 시작되지 못했으므로 선제 클리어된 어노테이션을 복원한다.
      await this.changed(await this.store.update(workspaceId, id, s => ({ ...s, state: "idle", annotations: s.annotations.length ? s.annotations : annotations })));
      await this.emit(workspaceId, id, "error", "provider_unavailable", false);
      throw new Error("cowork_provider_unavailable");
    }
  }

  async cancel(workspaceId: string, id: string) {
    const resources = this.live.get(id);
    if (resources) { try { await resources.client.cancelPrompt(); } catch { /* idempotent */ } }
    this.releaseLive(id);
    await this.flushAssistantTurn(workspaceId, id);
    // 중단된 실행에 실려 나간 어노테이션은 durable하게 복원한다(실패/해체 경로와 동일).
    return this.changed(await this.store.update(workspaceId, id, s => s.state === "running" ? { ...s, state: "idle", annotations: s.annotations.length ? s.annotations : resources?.annotations ?? [] } : s));
  }

  async close(workspaceId: string, id: string) {
    this.releaseLive(id);
    const s = await this.store.update(workspaceId, id, old => ({ ...old, state: "closed" }));
    this.store.release(s);
    return this.changed(s);
  }

  async apply(workspaceId: string, id: string, expectedRevision?: number): Promise<CoworkSessionRecord> {
    const s = await this.required(workspaceId, id);
    if (s.state !== "idle") throw new Error("cowork_apply_busy");
    if (expectedRevision !== undefined && expectedRevision !== s.revision) throw new Error("cowork_apply_stale_revision");
    this.releaseLive(id);
    let entry: WikiEntry;
    try { entry = parseDraft(s.draft); } catch { throw new Error("cowork_apply_invalid_draft"); }
    entry = { ...entry, version: s.baseVersion + 1, updated: new Date().toISOString() };
    const patch: Patch = { frontmatter: { op: "update_wiki", target: s.targetPath ?? `wiki/${s.entryId}.md`, summary: `Cowork update ${s.entryId}`, proposer: "codex-cowork", created: new Date().toISOString() }, body: JSON.stringify(entry) };
    try {
      const patchId = await enqueuePatch(patch, this.paths, { baseVersion: s.baseVersion, baseHash: s.baseHash });
      await approvePatch(patchId, this.paths);
      const applied = await this.store.update(workspaceId, id, x => ({ ...x, state: "applied" }));
      this.store.release(applied);
      return this.changed(applied);
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      console.error(`[cowork] apply failed (session ${id}):`, message);
      throw new Error(message.includes("stale base") ? "cowork_apply_stale" : "cowork_apply_failed");
    }
  }

  /** Theater forget 등 워크스페이스 해제 시 라이브 클라이언트를 전부 회수하고 실행 중 세션을 idle로 되돌린다. */
  async dispose(): Promise<void> {
    for (const [id, resources] of [...this.live]) {
      this.releaseLive(id);
      await this.flushAssistantTurn(resources.workspaceId, id);
      try { await this.store.update(resources.workspaceId, id, s => s.state === "running" ? { ...s, state: "idle", annotations: s.annotations.length ? s.annotations : resources.annotations } : s); } catch { /* 세션 파일이 이미 없으면 무시 */ }
    }
  }

  dto(session: CoworkSessionRecord): CoworkSessionDto { const { targetPath: _t, createdAt: _a, updatedAt: _u, ...dto } = session; return dto; }
  subscribe(id: string, cb: (event: CoworkStoredEvent) => void) { const set = this.listeners.get(id) ?? new Set(); set.add(cb); this.listeners.set(id, set); return () => set.delete(cb); }
  async replay(workspaceId: string, id: string, after = 0) { return (await this.store.events(workspaceId, id)).filter(e => e.id > after); }

  private releaseLive(id: string) {
    const resources = this.live.get(id);
    if (!resources) return;
    this.live.delete(id);
    resources.cleanup();
    void resources.client.disconnect().catch(() => undefined);
  }

  private async finishPrompt(workspaceId: string, id: string, client: CoworkAgentClient, errorCode: string | null) {
    // 취소 직후 새 프롬프트가 시작된 경우, 이전 클라이언트의 지연 완료가 새 실행을 해체하면 안 된다.
    const live = this.live.get(id);
    if (live?.client !== client) return;
    this.releaseLive(id);
    await this.flushAssistantTurn(workspaceId, id);
    const s = await this.store.update(workspaceId, id, old => ({
      ...old,
      state: old.state === "running" ? "idle" : old.state,
      // provider가 실패했으면 이번 실행에 실려 나간 어노테이션을 durable하게 복원한다.
      annotations: errorCode && old.annotations.length === 0 ? live.annotations : old.annotations,
    }));
    await this.changed(s);
    await this.emit(workspaceId, id, errorCode ? "error" : "done", errorCode ?? undefined, false);
  }

  private composePrompt(prompt: string, annotations: CoworkSessionRecord["annotations"], selection: string | null, history: ReadonlyArray<{ role: string; text: string }>) { return JSON.stringify({ prompt, annotations: normalizeAnnotations(annotations), selection: selection ? { quote: selection } : undefined, history: history.length ? history : undefined }); }
  private async changed(s: CoworkSessionRecord) { await this.emit(s.workspaceId, s.id, "session"); return s; }
  private async flushAssistantTurn(workspaceId: string, id: string) { const text = this.streamBuffers.get(id); this.streamBuffers.delete(id); if (text) await this.store.appendTranscript(workspaceId, id, { role: "assistant", text, at: new Date().toISOString() }); }
  private async emit(workspaceId: string, id: string, type: CoworkStoredEvent["type"], text?: string, includeSession = true) { const session = includeSession ? this.dto(await this.required(workspaceId, id)) : undefined; const event = await this.store.appendEvent(workspaceId, id, { type, text, session }); for (const cb of this.listeners.get(id) ?? []) cb(event); }
  private async required(workspaceId: string, id: string) { const s = await this.get(workspaceId, id); if (!s) throw new Error("cowork_session_not_found"); return s; }
}

function parseDraft(markdown: string): WikiEntry { const match = markdown.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if (!match) throw new Error("missing frontmatter"); const values: Record<string, unknown> = {}; for (const line of match[1]!.split("\n")) { const at = line.indexOf(":"); if (at < 1) throw new Error("invalid frontmatter"); const key = line.slice(0, at).trim(); const raw = line.slice(at + 1).trim(); values[key] = raw.startsWith("[") ? JSON.parse(raw) : raw.startsWith('"') ? reviveQuoted(JSON.parse(raw) as string) : /^-?\d+$/.test(raw) ? Number(raw) : raw; } if (typeof values.template_id === "string") { values.templateId = values.template_id; delete values.template_id; } if (typeof values.id !== "string" || typeof values.title !== "string" || !Array.isArray(values.tags) || typeof values.created !== "string" || typeof values.updated !== "string" || typeof values.version !== "number") throw new Error("invalid entry"); return { ...values, tags: values.tags as string[], body: match[2]! } as WikiEntry; }

// Fleet Wiki serializes array/object frontmatter (e.g. rawSourceRefs) as a quoted JSON string —
// revive it so apply hands the writer real arrays instead of double-encoded strings.
function reviveQuoted(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { return value; }
  }
  return value;
}

/** 커넥터 오류를 이벤트 코드로 좁힌다 — `cowork_*` 코드만 통과하고 나머지는 provider_error다. */
function coworkErrorCode(message: unknown): string {
  return typeof message === "string" && /^cowork_[a-z_]+$/u.test(message) ? message : "provider_error";
}
