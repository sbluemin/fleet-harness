export interface WikiEntryFrontmatter {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  version: number;
  templateId?: string;
  rawSourceRef?: string;
  aliases?: string[];
  type?: WikiEntryType;
  status?: WikiEntryStatus;
  confidence?: WikiEntryConfidence;
  owner?: string;
  language?: string;
  revalidateAfter?: string;
  supersedes?: string[];
  related?: string[];
  rawSourceRefs?: WikiRawSourceRef[];
}

export interface WikiEntry extends WikiEntryFrontmatter {
  body: string;
}

export interface WorkspaceTemplate {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  sections: string[];
}

export type WikiEntryType =
  | "concept"
  | "entity"
  | "source"
  | "decision"
  | "runbook"
  | "project_context"
  | "policy"
  | "preference"
  | "lesson"
  | "api_contract"
  | "query"
  | "synthesis";

export type WikiEntryStatus = "draft" | "current" | "deprecated" | "superseded";
export type WikiEntryConfidence = "low" | "medium" | "high";

export interface WikiRawSourceRef {
  ref: string;
  title?: string;
  hash?: string;
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

export type ClaimConfidence = "low" | "medium" | "high";

export interface ClaimSourceSpan {
  start: number;
  end: number;
}

export interface ClaimSourceRef {
  ref: string;
  quote?: string;
  span?: ClaimSourceSpan;
}

export interface Claim {
  id: string;
  text: string;
  sourceRefs: ClaimSourceRef[];
  confidence: ClaimConfidence;
}

export interface ClaimSet {
  entryId: string;
  claims: Claim[];
}

export type PatchOp = "create_wiki" | "update_wiki";
export type PatchStatus = "pending" | "accepted" | "rejected";
export type WikiIngestMode = "auto" | "create" | "update";
export type DuplicatePolicy = "reject" | "queue_conflict" | "append_evidence";
export type ConflictReason =
  | "create_target_exists"
  | "update_target_missing"
  | "base_version_mismatch"
  | "base_hash_mismatch"
  | "raw_source_contradiction"
  | "duplicate_id"
  | "duplicate_title"
  | "duplicate_alias"
  | "patch_body_target_mismatch"
  | "source_provenance_conflict";
export type ConflictStatus = "unresolved" | "resolved";

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
  conflictId?: string;
  warnings?: string[];
  patch_set_id?: string;
  baseVersion?: number;
  baseHash?: string;
  baseCheckedAt?: string;
  editedAt?: string;
  editCount?: number;
  lastEditedBy?: string;
  lastEditHash?: string;
  previousPatchHash?: string;
}

export interface SchemaCatalogTemplate {
  id: string;
  ref: string;
  sections: string[];
}

export interface SchemaCatalog {
  schema: { ref: string; exists: boolean; summary: string };
  templates: SchemaCatalogTemplate[];
}

export interface SchemaDocument {
  ref: string;
  content: string;
}

export interface PatchSet {
  id: string;
  sourceRef: string;
  createdAt: string;
  patchIds: string[];
}

export interface ConflictMeta {
  id: string;
  status: ConflictStatus;
  reason: ConflictReason;
  createdAt: string;
  resolvedAt?: string;
  resolution?: "queued" | "rejected" | "superseded" | "manual";
  note?: string;
  target: string;
  wikiId: string;
  title?: string;
  proposer?: string;
  rawSourceRef?: string;
  patchId?: string;
  currentVersion?: number;
  proposedVersion?: number;
  baseVersion?: number;
  baseHash?: string;
  currentHash?: string;
  warnings?: string[];
}

export interface ConflictRecord {
  meta: ConflictMeta;
  current?: string;
  proposed: string;
  rawSource?: string;
}

export interface IngestResult {
  ok: boolean;
  mode: WikiIngestMode;
  op?: PatchOp;
  patch_id?: string;
  conflict_id?: string;
  raw_source_ref?: string;
  warnings: string[];
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
  templates?: WorkspaceTemplate[];
}

export type WikiLogEvent =
  | "raw source added"
  | "patch enqueued"
  | "patch edited"
  | "patch approved"
  | "patch rejected"
  | "patch set staged"
  | "patch set approved"
  | "patch set partially approved"
  | "conflict detected"
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
  type?: WikiEntryType;
  status?: WikiEntryStatus;
  confidence?: WikiEntryConfidence;
  aliases?: string[];
}

export interface BriefingHit {
  id: string;
  title: string;
  score: number;
  reason: "id" | "alias" | "tag" | "title" | "body";
  excerpt: string;
  path: string;
  tags: string[];
  updated: string;
  version?: number;
  rawSourceRef?: string;
  rawSourceRefs?: string[];
  status?: WikiEntryFrontmatter["status"];
  confidence?: WikiEntryFrontmatter["confidence"];
  revalidateAfter?: string;
  aliases?: string[];
  type?: WikiEntryFrontmatter["type"];
  matchedFields: string[];
  matchedSnippets?: Array<{ field: string; snippet: string }>;
  tokenEstimate?: number;
  stale?: boolean;
  related?: string[];
  whyThisMatched?: string;
  boundary?: string;
  enhanced_score?: number;
  graph_boost?: number;
}

export type WikiReadMode = "full" | "summary" | "facts" | "diffable";

export interface WikiReadRawSourceResult {
  ref: string;
  sourceType: "inline" | "file";
  title?: string;
  tags: string[];
  contentHash?: string;
  content: string;
  boundary: "untrusted";
}

export interface WikiReadRelatedResult {
  id: string;
  title: string;
  path: string;
  reason: "frontmatter" | "outgoing" | "backlink";
}

export interface WikiReadWarning {
  ref: string;
  error: "raw_source_not_found";
}

export interface WikiReadEntryResult {
  id: string;
  ok: true;
  frontmatter: WikiEntryFrontmatter;
  body?: string;
  content?: string;
  rawSourceRef?: string;
  rawSourceRefs?: string[];
  rawSource?: WikiReadRawSourceResult;
  rawSources?: WikiReadRawSourceResult[];
  warnings?: WikiReadWarning[];
  source: {
    path: string;
    rawSourceRef?: string;
    rawSourceRefs?: string[];
  };
  links: {
    outgoing: string[];
    backlinks: string[];
  };
  related?: WikiReadRelatedResult[];
  tokenEstimate: number;
  truncated: boolean;
  boundary: string;
}

export interface WikiReadMissingResult {
  id: string;
  ok: false;
  error: "not_found";
}

export interface DryDockIssue {
  code:
    | "missing_frontmatter"
    | "broken_link"
    | "duplicate_id"
    | "malformed_queue"
    | "inline_raw_source_ref"
    | "duplicate_frontmatter"
    | "legacy_markdown_wiki_link"
    | "missing_index_md"
    | "malformed_index_md"
    | "missing_log_md"
    | "malformed_log_md"
    | "schema_missing"
    | "schema_required_section_missing"
    | "template_compliance"
    | "schema_agents_missing"
    | "unresolved_conflict"
    | "orphan_patch_set_member"
    | "claim_orphan"
    | "malformed_claim_sidecar"
    | "orphan_page"
    | "cross_reference_suggestion"
    | "stale_entry"
    | "deprecated_in_index"
    | "superseded_in_index"
    | "missing_raw_source_for_current"
    | "duplicate_alias"
    | "schema_violation"
    | "conflict_unresolved"
    | "contradiction_marker"
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

export const WIKI_ENTRY_TYPES = [
  "concept",
  "entity",
  "source",
  "decision",
  "runbook",
  "project_context",
  "policy",
  "preference",
  "lesson",
  "api_contract",
  "query",
  "synthesis",
] as const;

export const WIKI_ENTRY_STATUSES = ["draft", "current", "deprecated", "superseded"] as const;
export const WIKI_ENTRY_CONFIDENCES = ["low", "medium", "high"] as const;
