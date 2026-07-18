import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentToolSpec } from "@dotobokuri/core-agent";
import { TranscriptIndexer } from "./transcript-indexer.js";
import type { AnalystArtifact, AnalystEvent, SessionToolOptions } from "./types.js";
const exec = promisify(execFile); const MAX_ARTIFACT_BYTES = 50 * 1024;

export class AnalystTools {
  readonly indexer: TranscriptIndexer; private readonly artifacts: AnalystArtifact[] = [];
  constructor(private readonly options: SessionToolOptions) { this.indexer = new TranscriptIndexer(options.capturePath); }
  specs(): AgentToolSpec[] { return [this.spec("session_outline", {}, () => this.indexer.outline()), this.spec("session_events", { type: "object", properties: { kind: { type: "string" }, cursor: { type: "number" }, limit: { type: "number" } } }, args => this.events(args)), this.spec("session_read", { type: "object", properties: { ref: { type: "string" }, radius: { type: "number" } }, required: ["ref"] }, args => this.read(args)), this.spec("session_diff", {}, () => this.diff()), this.spec("live_tail", { type: "object", properties: { limit: { type: "number" } } }, args => this.tail(args)), this.spec("publish_artifact", { type: "object", properties: { title: { type: "string" }, html: { type: "string" } }, required: ["title", "html"] }, args => this.publish(args))]; }
  async refresh(): Promise<void> { await this.indexer.refresh(); }
  private spec(id: string, parameters: unknown, execute: (args: Record<string, unknown>) => unknown | Promise<unknown>): AgentToolSpec { return { id, tag: id, title: id, description: id, promptSnippet: id, whenToUse: [], whenNotToUse: [], usageGuidelines: [], parameters, execute: async args => execute(record(args)) }; }
  private events(args: Record<string, unknown>) { const start = Math.max(0, integer(args.cursor) ?? 0); const limit = Math.min(100, Math.max(1, integer(args.limit) ?? 30)); const kind = typeof args.kind === "string" ? args.kind : undefined; const values = kind ? this.indexer.all.filter(e => e.kind === kind) : this.indexer.all; return { events: values.slice(start, start + limit), nextCursor: start + limit < values.length ? start + limit : null }; }
  private read(args: Record<string, unknown>) { const ref = typeof args.ref === "string" ? args.ref : ""; const index = this.indexer.all.findIndex(e => e.ref === ref); if (index < 0) return { error: "event_not_found" }; const radius = Math.min(10, Math.max(0, integer(args.radius) ?? 2)); return { events: this.indexer.all.slice(Math.max(0, index - radius), index + radius + 1) }; }
  private async diff() { try { const { stdout } = await exec("git", ["diff", "--stat", "--", "."], { cwd: this.options.cwd, timeout: 10_000, maxBuffer: 64 * 1024 }); return { summary: stdout.trim().slice(0, 60_000) }; } catch { return { summary: "Diff unavailable" }; } }
  private async tail(args: Record<string, unknown>) { await this.refresh(); const limit = Math.min(100, Math.max(1, integer(args.limit) ?? 20)); return { events: this.indexer.all.slice(-limit) }; }
  private publish(args: Record<string, unknown>) { const title = typeof args.title === "string" ? args.title.trim() : ""; const html = typeof args.html === "string" ? args.html : ""; if (!title || title.length > 120) throw new Error("Invalid artifact title"); if (Buffer.byteLength(html, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 50 KiB"); const artifact = { id: crypto.randomUUID(), title, html, createdAt: new Date().toISOString() }; this.artifacts.unshift(artifact); this.options.onEvent?.({ type: "artifact", artifact }); return { artifact: { id: artifact.id, title, createdAt: artifact.createdAt } }; }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined; }
