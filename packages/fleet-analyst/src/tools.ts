import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentToolSpec } from "@dotobokuri/core-agent";

import { TranscriptIndexer } from "./transcript-indexer.js";
import type { AnalystArtifact, SessionToolOptions } from "./types.js";

const exec = promisify(execFile);
const MAX_ARTIFACT_BYTES = 50 * 1024;
const MAX_ARTIFACTS = 20;

interface ToolMetadata {
  readonly id: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly usageGuidelines: readonly string[];
  readonly parameters: unknown;
}

const TOOL_METADATA: Record<string, ToolMetadata> = {
  session_outline: {
    id: "session_outline",
    description: "Structured overview of the observed session: event count, stages, and touched files. Call this first.",
    promptSnippet: "Start analysis with session_outline before retrieving transcript detail.",
    whenToUse: ["At the beginning of every analysis request.", "To identify useful stages or file activity before drilling down."],
    whenNotToUse: ["Do not use it as evidence for a specific event; retrieve that event instead."],
    usageGuidelines: ["Returns aggregate counts only and takes no parameters."],
    parameters: { type: "object", properties: {} },
  },
  session_events: {
    id: "session_events",
    description: "Lists a bounded, paginated slice of indexed events, optionally filtered by event kind.",
    promptSnippet: "Use session_events to locate relevant evidence references before session_read.",
    whenToUse: ["To find events in a stage or event category.", "To page through a small relevant range."],
    whenNotToUse: ["Do not request the entire transcript when a narrow filter or page will do."],
    usageGuidelines: ["kind filters message, tool, stage, file, or unknown; cursor is a zero-based page offset; limit is capped at 100."],
    parameters: { type: "object", properties: { kind: { type: "string", description: "Optional event kind filter." }, cursor: { type: "number", description: "Zero-based event offset." }, limit: { type: "number", description: "Page size, maximum 100." } } },
  },
  session_read: {
    id: "session_read",
    description: "Reads a capped surrounding window for one stable event reference.",
    promptSnippet: "Use session_read after locating an [e#] reference that needs context.",
    whenToUse: ["To inspect context around a specific event.", "To verify an observed claim before citing it."],
    whenNotToUse: ["Do not use an arbitrary or missing reference; locate it with session_events first."],
    usageGuidelines: ["ref is the required stable e# reference; radius is an optional surrounding-event count capped at 10."],
    parameters: { type: "object", properties: { ref: { type: "string", description: "Required stable event reference, such as e12." }, radius: { type: "number", description: "Optional context radius, maximum 10." } }, required: ["ref"] },
  },
  session_diff: {
    id: "session_diff",
    description: "Returns a bounded git diff-stat summary for the session working directory.",
    promptSnippet: "Use session_diff for changed-file scale, not transcript evidence.",
    whenToUse: ["To summarize the current change footprint.", "To compare observed file activity with repository changes."],
    whenNotToUse: ["Do not use it to read file contents or infer why a change occurred."],
    usageGuidelines: ["Takes no parameters and returns only a bounded diff-stat summary."],
    parameters: { type: "object", properties: {} },
  },
  live_tail: {
    id: "live_tail",
    description: "Most recent events including in-flight tool calls. Required before answering any question about current work.",
    promptSnippet: "Call live_tail before answering about current work, now, or in-flight activity.",
    whenToUse: ["Before any current-state question.", "To refresh the index after new transcript data may have arrived."],
    whenNotToUse: ["Do not substitute it for targeted historical context; use session_read instead."],
    usageGuidelines: ["limit is an optional newest-event count capped at 100."],
    parameters: { type: "object", properties: { limit: { type: "number", description: "Newest event count, maximum 100." } } },
  },
  publish_artifact: {
    id: "publish_artifact",
    description: "Publishes one newest-first, in-memory analysis artifact and emits it to the client event stream.",
    promptSnippet: "Use publish_artifact for a self-contained structured explanation with evidence citations.",
    whenToUse: ["When a timeline, comparison, risk review, or visual brief is clearer than chat alone.", "After collecting cited evidence for the artifact."],
    whenNotToUse: ["Do not use it for raw transcript dumps, secrets, external resources, or oversized HTML."],
    usageGuidelines: ["title is a searchable non-empty title up to 120 characters; html is self-contained UTF-8 HTML capped at 50KiB."],
    parameters: { type: "object", properties: { title: { type: "string", description: "Searchable artifact title, maximum 120 characters." }, html: { type: "string", description: "Self-contained HTML, maximum 50KiB UTF-8." } }, required: ["title", "html"] },
  },
};

export class AnalystTools {
  readonly indexer: TranscriptIndexer;
  private readonly artifacts: AnalystArtifact[] = [];

  constructor(private readonly options: SessionToolOptions) {
    this.indexer = new TranscriptIndexer(options.capturePath);
  }

  specs(): AgentToolSpec[] {
    return [
      this.spec(TOOL_METADATA.session_outline, () => this.indexer.outline()),
      this.spec(TOOL_METADATA.session_events, (args) => this.events(args)),
      this.spec(TOOL_METADATA.session_read, (args) => this.read(args)),
      this.spec(TOOL_METADATA.session_diff, () => this.diff()),
      this.spec(TOOL_METADATA.live_tail, (args) => this.tail(args)),
      this.spec(TOOL_METADATA.publish_artifact, (args) => this.publish(args)),
    ];
  }

  async refresh(): Promise<void> { await this.indexer.refresh(); }

  private spec(metadata: ToolMetadata, execute: (args: Record<string, unknown>) => unknown | Promise<unknown>): AgentToolSpec {
    return { ...metadata, tag: metadata.id, title: metadata.id, parameters: metadata.parameters, execute: async (args) => execute(record(args)) };
  }

  private events(args: Record<string, unknown>) {
    const start = Math.max(0, integer(args.cursor) ?? 0);
    const limit = Math.min(100, Math.max(1, integer(args.limit) ?? 30));
    const kind = typeof args.kind === "string" ? args.kind : undefined;
    const values = kind ? this.indexer.all.filter((event) => event.kind === kind) : this.indexer.all;
    return { events: values.slice(start, start + limit), nextCursor: start + limit < values.length ? start + limit : null };
  }

  private read(args: Record<string, unknown>) {
    const ref = typeof args.ref === "string" ? args.ref : "";
    const index = this.indexer.all.findIndex((event) => event.ref === ref);
    if (index < 0) return { error: "event_not_found" };
    const radius = Math.min(10, Math.max(0, integer(args.radius) ?? 2));
    return { events: this.indexer.all.slice(Math.max(0, index - radius), index + radius + 1) };
  }

  private async diff() {
    try {
      const { stdout } = await exec("git", ["diff", "--stat", "--", "."], { cwd: this.options.cwd, timeout: 10_000, maxBuffer: 64 * 1024 });
      return { summary: stdout.trim().slice(0, 60_000) };
    } catch { return { summary: "Diff unavailable" }; }
  }

  private async tail(args: Record<string, unknown>) {
    await this.refresh();
    const limit = Math.min(100, Math.max(1, integer(args.limit) ?? 20));
    return { events: this.indexer.all.slice(-limit) };
  }

  private publish(args: Record<string, unknown>) {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const html = typeof args.html === "string" ? args.html : "";
    if (!title || title.length > 120) throw new Error("Invalid artifact title");
    if (Buffer.byteLength(html, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 50 KiB");
    const artifact = { id: crypto.randomUUID(), title, html, createdAt: new Date().toISOString() };
    this.artifacts.unshift(artifact);
    if (this.artifacts.length > MAX_ARTIFACTS) this.artifacts.splice(MAX_ARTIFACTS);
    this.options.onEvent?.({ type: "artifact", artifact });
    return { artifact: { id: artifact.id, title, createdAt: artifact.createdAt } };
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined; }
