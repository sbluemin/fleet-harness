export interface WikiEntryFrontmatter {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  version: number;
  rawSourceRef?: string;
}

export interface WikiEntry extends WikiEntryFrontmatter {
  body: string;
}

export interface RawSourceEntry {
  id: string;
  created: string;
  sourceType: "inline" | "file";
  title?: string;
  tags: string[];
  contentHash?: string;
  content: string;
}

export type PatchOp = "create_wiki" | "update_wiki";
export type PatchStatus = "pending" | "accepted" | "rejected";

export interface PatchFrontmatter {
  op: PatchOp;
  target: string;
  summary: string;
  proposer: string;
  created: string;
}

export interface Patch {
  frontmatter: PatchFrontmatter;
  body: string;
}

export interface PatchMeta {
  id: string;
  status: PatchStatus;
  createdAt: string;
  decidedAt?: string;
  reason?: string;
  rawSourceRef?: string;
  warnings?: string[];
}

export interface MemoryPaths {
  root: string;
  rawDir: string;
  wikiDir: string;
  schemaDir: string;
  queueDir: string;
  archiveDir: string;
  conflictsDir: string;
  indexFile: string;
}

export interface WorkspaceSchema {
  agentsPath: string;
  wikiSchemaPath: string;
  exists: boolean;
  summary: string;
  requiredSections: readonly string[];
  missingRequiredSections: string[];
}

export type WikiLogEvent =
  | "raw source added"
  | "patch enqueued"
  | "patch approved"
  | "patch rejected"
  | "drydock run"
  | "index rebuilt";

export type WikiLogPayload = Record<string, string | number | boolean | null | undefined | string[]>;

export interface WikiLogEntry {
  timestamp: string;
  event: WikiLogEvent;
  payload: WikiLogPayload;
}

export interface WikiIndexEntry {
  path: string;
  title: string;
  tags: string[];
  updated: string;
}

export interface BriefingHit {
  id: string;
  title: string;
  score: number;
  reason: "id" | "tag" | "title" | "body";
  excerpt: string;
  path: string;
  tags: string[];
  updated: string;
}

export interface DryDockIssue {
  code:
    | "missing_frontmatter"
    | "broken_link"
    | "duplicate_id"
    | "malformed_queue"
    | "inline_raw_source_ref"
    | "legacy_markdown_wiki_link"
    | "missing_index_md"
    | "malformed_index_md"
    | "missing_log_md"
    | "malformed_log_md"
    | "schema_missing"
    | "schema_required_section_missing"
    | "schema_agents_missing"
    | "unsafe_secret"
    | "prompt_injection";
  severity: "error" | "warning" | "info";
  message: string;
  path: string;
}

export interface WikiSafetyIssue {
  code: "unsafe_secret" | "prompt_injection";
  severity: "error" | "warning";
  message: string;
}

export interface DryDockReport {
  ok: boolean;
  issues: DryDockIssue[];
}
