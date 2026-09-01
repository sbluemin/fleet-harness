import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { TranscriptIndexer } from "./transcript-indexer.js";
import type { AnalystArtifact, SessionToolOptions } from "./types.js";

const exec = promisify(execFile);
const MAX_ARTIFACT_BYTES = 50 * 1024;
const MAX_ARTIFACTS = 20;

const ANALYST_TOOL_IDS = {
  sessionOutline: "session_outline",
  sessionEvents: "session_events",
  sessionRead: "session_read",
  sessionDiff: "session_diff",
  liveTail: "live_tail",
  publishArtifact: "publish_artifact",
} as const;

/**
 * 한 도구의 정의.
 *
 * 모델에게 실제로 도달하는 것은 `description`과 `parameters`뿐이다 — 앞선 MCP 라우터도
 * `{name, description, parameters}`만 발행했다. 나머지 산문은 이 파일을 읽는 사람을 위한
 * 것이고, 모델을 움직이려면 `description`에 넣어야 한다.
 *
 * `parameters`는 zod raw shape다. 게이트웨이 SDK의 in-process 도구가 그 모양을 요구하고,
 * vendor는 zod 인스턴스 동일성이 아니라 형태로 판정하므로 이 패키지의 zod를 그대로 쓴다.
 */
export interface AnalystToolSpec {
  readonly id: string;
  readonly description: string;
  readonly parameters: Record<string, z.ZodTypeAny>;
  execute(args: Record<string, unknown>): unknown | Promise<unknown>;
}

interface ToolMetadata {
  readonly id: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly usageGuidelines: readonly string[];
  readonly parameters: Record<string, z.ZodTypeAny>;
}

const TOOL_METADATA: Record<string, ToolMetadata> = {
  [ANALYST_TOOL_IDS.sessionOutline]: {
    id: ANALYST_TOOL_IDS.sessionOutline,
    description: "Structured overview of the observed session: event count, stages, and touched files.",
    promptSnippet: "Use session_outline when a broad historical or session overview benefits from an aggregate map.",
    whenToUse: ["For broad historical or session-overview questions.", "To identify useful stages or file activity before drilling down."],
    whenNotToUse: ["Do not call it for identity, capability, limits, usage, or other direct-answer questions.", "Do not require it before live_tail for a current-state question.", "Do not use it as evidence for a specific event; retrieve that event instead."],
    usageGuidelines: ["Returns aggregate counts only and takes no parameters."],
    parameters: {},
  },
  [ANALYST_TOOL_IDS.sessionEvents]: {
    id: ANALYST_TOOL_IDS.sessionEvents,
    description: "Lists a bounded, paginated slice of indexed events, optionally filtered by event kind.",
    promptSnippet: "Use session_events to locate relevant evidence references before session_read.",
    whenToUse: ["To find events in a stage or event category.", "To page through a small relevant range."],
    whenNotToUse: ["Do not request the entire transcript when a narrow filter or page will do."],
    usageGuidelines: ["kind filters message, tool, stage, file, or unknown; cursor is a zero-based page offset; limit is capped at 100."],
    parameters: {
      kind: z.string().optional().describe("Optional event kind filter."),
      cursor: z.number().optional().describe("Zero-based event offset."),
      limit: z.number().optional().describe("Page size, maximum 100."),
    },
  },
  [ANALYST_TOOL_IDS.sessionRead]: {
    id: ANALYST_TOOL_IDS.sessionRead,
    description: "Reads a capped surrounding window for one stable event reference.",
    promptSnippet: "Use session_read after locating an [e#] reference that needs context.",
    whenToUse: ["To inspect context around a specific event.", "To verify an observed claim before citing it."],
    whenNotToUse: ["Do not use an arbitrary or missing reference; locate it with session_events first."],
    usageGuidelines: ["ref is the required stable e# reference; radius is an optional surrounding-event count capped at 10."],
    parameters: {
      ref: z.string().describe("Required stable event reference, such as e12."),
      radius: z.number().optional().describe("Optional context radius, maximum 10."),
    },
  },
  [ANALYST_TOOL_IDS.sessionDiff]: {
    id: ANALYST_TOOL_IDS.sessionDiff,
    description: "Returns a bounded git diff-stat summary for the session working directory.",
    promptSnippet: "Use session_diff for changed-file scale, not transcript evidence.",
    whenToUse: ["To summarize the current change footprint.", "To compare observed file activity with repository changes."],
    whenNotToUse: ["Do not use it to read file contents or infer why a change occurred."],
    usageGuidelines: ["Takes no parameters and returns only a bounded diff-stat summary."],
    parameters: {},
  },
  [ANALYST_TOOL_IDS.liveTail]: {
    id: ANALYST_TOOL_IDS.liveTail,
    description: "Most recent events including in-flight tool calls. Required before answering any question about current work.",
    promptSnippet: "Call live_tail before answering about current work, now, or in-flight activity.",
    whenToUse: ["Before any current-state question.", "To refresh the index after new transcript data may have arrived."],
    whenNotToUse: ["Do not substitute it for targeted historical context; use session_read instead."],
    usageGuidelines: ["limit is an optional newest-event count capped at 100."],
    parameters: { limit: z.number().optional().describe("Newest event count, maximum 100.") },
  },
  [ANALYST_TOOL_IDS.publishArtifact]: {
    id: ANALYST_TOOL_IDS.publishArtifact,
    description: "Publishes one newest-first, in-memory analysis artifact and emits it to the client event stream. The served document injects a base stylesheet that centers a reading column and sets page padding, type, tables, code, details, citation chips, and a component set (fleet-kicker, fleet-lede, fleet-meta, fleet-card, fleet-kpis with fleet-kpi, fleet-timeline, fleet-callout, fleet-status, fleet-table, fleet-scroll), and exposes the console theme as CSS variables: --fleet-canvas (page ground), --fleet-card (raised card), --fleet-inset (sunken code and wells), --fleet-ink, --fleet-muted, --fleet-faint, --fleet-hairline, --fleet-hairline-strong, --fleet-accent, --fleet-positive, --fleet-warn, --fleet-critical, --fleet-focus, --fleet-sans, --fleet-mono. Take every color and face from those variables with a literal fallback, e.g. var(--fleet-card, #1b2129), and never paint a surface darker than the ground. See the Artifact design section of the system prompt for the full contract.",
    promptSnippet: "Use publish_artifact with the exact title and html parameters for a self-contained structured explanation with evidence citations.",
    whenToUse: ["When a timeline, comparison, risk review, or visual brief is clearer than chat alone.", "After collecting cited evidence for the artifact."],
    whenNotToUse: ["Do not use it for raw transcript dumps, secrets, external resources, or oversized HTML."],
    usageGuidelines: ["Pass exactly title and html; never use content as an alias for html.", "html must be non-empty and is capped at 50KiB UTF-8."],
    parameters: {
      title: z.string().min(1).max(120).describe("Searchable artifact title, maximum 120 characters."),
      html: z.string().min(1).describe("Self-contained non-empty HTML, maximum 50KiB UTF-8. This property is named html, not content."),
    },
  },
};

export class AnalystTools {
  readonly indexer: TranscriptIndexer;
  private readonly artifacts: AnalystArtifact[] = [];

  constructor(private readonly options: SessionToolOptions) {
    this.indexer = new TranscriptIndexer(options.capturePath);
  }

  specs(): AnalystToolSpec[] {
    return [
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionOutline], () => this.indexer.outline()),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionEvents], (args) => this.events(args)),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionRead], (args) => this.read(args)),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionDiff], () => this.diff()),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.liveTail], (args) => this.tail(args)),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.publishArtifact], (args) => this.publish(args)),
    ];
  }

  async refresh(): Promise<void> { await this.indexer.refresh(); }

  private spec(metadata: ToolMetadata, execute: (args: Record<string, unknown>) => unknown | Promise<unknown>): AnalystToolSpec {
    return {
      id: metadata.id,
      description: metadata.description,
      parameters: metadata.parameters,
      execute: async (args) => execute(record(args)),
    };
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
    if (!html.trim()) throw new Error("Invalid artifact HTML: provide a non-empty 'html' parameter (not 'content')");
    const unexpected = Object.keys(args).filter((key) => key !== "title" && key !== "html");
    if (unexpected.length) throw new Error(`Invalid artifact parameters: expected only 'title' and 'html'; received ${unexpected.join(", ")}`);
    const artifact = { id: crypto.randomUUID(), title, html, createdAt: new Date().toISOString() };
    this.artifacts.unshift(artifact);
    if (this.artifacts.length > MAX_ARTIFACTS) this.artifacts.splice(MAX_ARTIFACTS);
    this.options.onEvent?.({ type: "artifact", artifact });
    return { artifact: { id: artifact.id, title, createdAt: artifact.createdAt } };
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined; }
