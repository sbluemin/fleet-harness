import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentToolSpec } from "@dotobokuri/core-agent";

import { TranscriptIndexer } from "./transcript-indexer.js";
import type { AnalystArtifact, SessionToolOptions } from "./types.js";

const exec = promisify(execFile);
const MAX_ARTIFACT_BYTES = 50 * 1024;
const MAX_ARTIFACTS = 20;
// 서버 검사는 클라이언트 렌더러가 유지하는 양의 요소 목록과 같은 구조적 경계를 사용한다.
const STATIC_ARTIFACT_ELEMENTS = new Set([
  "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "data", "dd", "details", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "img", "kbd", "li", "main", "mark", "meter", "ol", "p", "pre", "progress", "q", "s", "samp", "section",
  "small", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
]);
const VOID_HTML_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export const ANALYST_TOOL_IDS = {
  sessionOutline: "session_outline",
  sessionEvents: "session_events",
  sessionRead: "session_read",
  sessionDiff: "session_diff",
  liveTail: "live_tail",
  publishArtifact: "publish_artifact",
} as const;

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
  [ANALYST_TOOL_IDS.sessionOutline]: {
    id: ANALYST_TOOL_IDS.sessionOutline,
    description: "Structured overview of the observed session: event count, stages, and touched files. Call this first.",
    promptSnippet: "Start analysis with session_outline before retrieving transcript detail.",
    whenToUse: ["At the beginning of every analysis request.", "To identify useful stages or file activity before drilling down."],
    whenNotToUse: ["Do not use it as evidence for a specific event; retrieve that event instead."],
    usageGuidelines: ["Returns aggregate counts only and takes no parameters."],
    parameters: { type: "object", properties: {} },
  },
  [ANALYST_TOOL_IDS.sessionEvents]: {
    id: ANALYST_TOOL_IDS.sessionEvents,
    description: "Lists a bounded, paginated slice of indexed events, optionally filtered by event kind.",
    promptSnippet: "Use session_events to locate relevant evidence references before session_read.",
    whenToUse: ["To find events in a stage or event category.", "To page through a small relevant range."],
    whenNotToUse: ["Do not request the entire transcript when a narrow filter or page will do."],
    usageGuidelines: ["kind filters message, tool, stage, file, or unknown; cursor is a zero-based page offset; limit is capped at 100."],
    parameters: { type: "object", properties: { kind: { type: "string", description: "Optional event kind filter." }, cursor: { type: "number", description: "Zero-based event offset." }, limit: { type: "number", description: "Page size, maximum 100." } } },
  },
  [ANALYST_TOOL_IDS.sessionRead]: {
    id: ANALYST_TOOL_IDS.sessionRead,
    description: "Reads a capped surrounding window for one stable event reference.",
    promptSnippet: "Use session_read after locating an [e#] reference that needs context.",
    whenToUse: ["To inspect context around a specific event.", "To verify an observed claim before citing it."],
    whenNotToUse: ["Do not use an arbitrary or missing reference; locate it with session_events first."],
    usageGuidelines: ["ref is the required stable e# reference; radius is an optional surrounding-event count capped at 10."],
    parameters: { type: "object", properties: { ref: { type: "string", description: "Required stable event reference, such as e12." }, radius: { type: "number", description: "Optional context radius, maximum 10." } }, required: ["ref"] },
  },
  [ANALYST_TOOL_IDS.sessionDiff]: {
    id: ANALYST_TOOL_IDS.sessionDiff,
    description: "Returns a bounded git diff-stat summary for the session working directory.",
    promptSnippet: "Use session_diff for changed-file scale, not transcript evidence.",
    whenToUse: ["To summarize the current change footprint.", "To compare observed file activity with repository changes."],
    whenNotToUse: ["Do not use it to read file contents or infer why a change occurred."],
    usageGuidelines: ["Takes no parameters and returns only a bounded diff-stat summary."],
    parameters: { type: "object", properties: {} },
  },
  [ANALYST_TOOL_IDS.liveTail]: {
    id: ANALYST_TOOL_IDS.liveTail,
    description: "Most recent events including in-flight tool calls. Required before answering any question about current work.",
    promptSnippet: "Call live_tail before answering about current work, now, or in-flight activity.",
    whenToUse: ["Before any current-state question.", "To refresh the index after new transcript data may have arrived."],
    whenNotToUse: ["Do not substitute it for targeted historical context; use session_read instead."],
    usageGuidelines: ["limit is an optional newest-event count capped at 100."],
    parameters: { type: "object", properties: { limit: { type: "number", description: "Newest event count, maximum 100." } } },
  },
  [ANALYST_TOOL_IDS.publishArtifact]: {
    id: ANALYST_TOOL_IDS.publishArtifact,
    description: "Publishes one newest-first, in-memory analysis artifact and emits it to the client event stream.",
    promptSnippet: "Use publish_artifact with the exact title and html parameters for a self-contained structured explanation with evidence citations.",
    whenToUse: ["When a timeline, comparison, risk review, or visual brief is clearer than chat alone.", "After collecting cited evidence for the artifact."],
    whenNotToUse: ["Do not use it for raw transcript dumps, secrets, external resources, or oversized HTML."],
    usageGuidelines: ["Pass exactly title and html; never use content as an alias for html.", "html must contain visible static content and is capped at 50KiB UTF-8."],
    parameters: { type: "object", additionalProperties: false, properties: { title: { type: "string", minLength: 1, maxLength: 120, description: "Searchable artifact title, maximum 120 characters." }, html: { type: "string", minLength: 1, description: "Self-contained HTML with visible static content, maximum 50KiB UTF-8. This property is named html, not content." } }, required: ["title", "html"] },
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
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionOutline], () => this.indexer.outline()),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionEvents], (args) => this.events(args)),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionRead], (args) => this.read(args)),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.sessionDiff], () => this.diff()),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.liveTail], (args) => this.tail(args)),
      this.spec(TOOL_METADATA[ANALYST_TOOL_IDS.publishArtifact], (args) => this.publish(args)),
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
    if (!html.trim()) throw new Error("Invalid artifact HTML: provide a non-empty 'html' parameter (not 'content')");
    const unexpected = Object.keys(args).filter((key) => key !== "title" && key !== "html");
    if (unexpected.length) throw new Error(`Invalid artifact parameters: expected only 'title' and 'html'; received ${unexpected.join(", ")}`);
    if (!hasVisibleStaticContent(html)) throw new Error("Artifact HTML must include visible static content");
    const artifact = { id: crypto.randomUUID(), title, html, createdAt: new Date().toISOString() };
    this.artifacts.unshift(artifact);
    if (this.artifacts.length > MAX_ARTIFACTS) this.artifacts.splice(MAX_ARTIFACTS);
    this.options.onEvent?.({ type: "artifact", artifact });
    return { artifact: { id: artifact.id, title, createdAt: artifact.createdAt } };
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined; }

function hasVisibleStaticContent(html: string): boolean {
  const openElements: { readonly tag: string; readonly keepsText: boolean }[] = [];
  const tagPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    if ((openElements.at(-1)?.keepsText ?? true) && hasVisibleText(html.slice(cursor, match.index))) return true;
    cursor = tagPattern.lastIndex;
    const tag = match[1]?.toLowerCase();
    if (!tag) continue;

    if (/^<\//.test(match[0])) {
      for (let index = openElements.length - 1; index >= 0; index -= 1) {
        if (openElements[index]?.tag !== tag) continue;
        openElements.length = index;
        break;
      }
      continue;
    }

    const parentKeepsText = openElements.at(-1)?.keepsText ?? true;
    const keepsText = parentKeepsText && STATIC_ARTIFACT_ELEMENTS.has(tag) && tag !== "style";
    if (!VOID_HTML_ELEMENTS.has(tag)) openElements.push({ tag, keepsText });
  }

  return (openElements.at(-1)?.keepsText ?? true) && hasVisibleText(html.slice(cursor));
}

function hasVisibleText(value: string): boolean {
  const visible = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/&(?:nbsp|#160|#x0*a0);/gi, " ")
    .replace(/&(?:[a-z][a-z0-9]+|#\d+|#x[a-f0-9]+);/gi, "x");
  return visible.trim().length > 0;
}
