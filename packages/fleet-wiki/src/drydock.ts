import crypto from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { getClaimsDir, validateClaimSet } from "./claims.js";
import {
  INDEX_MD_FILENAME,
  PATCH_FILENAME,
  PATCH_META_FILENAME,
  REQUIRED_WIKI_FRONTMATTER_KEYS,
} from "./constants.js";
import { listConflicts, readConflict } from "./conflicts.js";
import { dedupeStrings } from "./internal-utils.js";
import { extractLegacyMarkdownWikiLinks, extractWikiLinks } from "./links.js";
import { appendLog, parseLog } from "./log.js";
import { PATCH_SET_DIRNAME, readPatchSet } from "./patch-set.js";
import { getIndexMarkdownFile, getLogFile } from "./paths.js";
import { findUnsafeMemoryText } from "./safety.js";
import {
  REQUIRED_WORKSPACE_SCHEMA_SECTIONS,
  WORKSPACE_SCHEMA_AGENTS_FILENAME,
  WORKSPACE_SCHEMA_FILENAME,
  inferTemplateIdFromTarget,
  readWorkspaceSchemaSummary,
  scanTemplates,
} from "./schema.js";
import {
  listDirectoryNames,
  listFileNames,
  loadIndex,
  pathExists,
  readJsonFile,
  readPatchFile,
  stripLeadingFrontmatter,
  writePatchFile,
} from "./store.js";
import {
  WIKI_ENTRY_STATUSES,
  WIKI_ENTRY_TYPES,
  type DryDockIssue,
  type DryDockReport,
  type MemoryPaths,
  type PatchMeta,
} from "./types.js";

interface ParsedSemanticEntry {
  id: string;
  title: string;
  filePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  bodyHash: string;
  aliases: string[];
  type?: string;
  status: "draft" | "current" | "deprecated" | "superseded" | "unknown";
  confidence?: string;
  related: string[];
  supersedes: string[];
  revalidateAfter?: string;
  rawSourceRefs: string[];
  updated?: string;
  outgoingLinks: string[];
}

interface WikiSemanticGraph {
  entries: ParsedSemanticEntry[];
  byId: Map<string, ParsedSemanticEntry>;
  backlinks: Map<string, Set<string>>;
  aliasOwners: Map<string, ParsedSemanticEntry[]>;
  titleOwners: Map<string, ParsedSemanticEntry[]>;
}

interface DryDockOptions {
  fix?: boolean;
}

interface ParsedFrontmatterDocument {
  frontmatter: Record<string, unknown>;
  rawFrontmatter: string;
  body: string;
}

const INLINE_RAW_SOURCE_REF_PATTERN = /(^|\n)raw_source_ref\s*:/i;
const LOOKUP_PHRASE_MIN_LENGTH = 3;
const NORMALIZED_STATUSES = new Set<string>(WIKI_ENTRY_STATUSES);
const NORMALIZED_TYPES = new Set<string>(WIKI_ENTRY_TYPES);

export async function runDryDock(paths: MemoryPaths, options: DryDockOptions = {}): Promise<DryDockReport> {
  const issues: DryDockIssue[] = [];
  const wikiIds = new Map<string, string>();
  const parsedWikiFiles: Array<{ filePath: string; body: string }> = [];
  const semanticEntries: ParsedSemanticEntry[] = [];
  let fixedDuplicateFrontmatterCount = 0;
  const indexMarkdownFile = getIndexMarkdownFile(paths);
  const logFile = getLogFile(paths);

  for (const filePath of await listWikiMarkdownFiles(paths.wikiDir)) {
    const content = await readPatchFile(filePath);
    issues.push(...safetyIssues(content, filePath));
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      issues.push(issue("missing_frontmatter", "error", "위키 frontmatter가 없습니다.", filePath));
      continue;
    }

    for (const key of REQUIRED_WIKI_FRONTMATTER_KEYS) {
      if (!(key in parsed.frontmatter)) {
        issues.push(issue("missing_frontmatter", "error", `위키 필수 키 누락: ${key}`, filePath));
      }
    }

    const id = String(parsed.frontmatter.id ?? "");
    if (wikiIds.has(id)) {
      issues.push(issue("duplicate_id", "error", `중복 wiki id: ${id}`, filePath));
    } else if (id) {
      wikiIds.set(id, filePath);
    }

    if (INLINE_RAW_SOURCE_REF_PATTERN.test(parsed.body)) {
      issues.push(issue("inline_raw_source_ref", "warning", "위키 본문에 inline raw_source_ref 잔여물이 있습니다.", filePath));
    }

    const strippedBody = stripLeadingFrontmatter(parsed.body);
    const effectiveBody = strippedBody === parsed.body ? parsed.body : strippedBody;
    if (strippedBody !== parsed.body) {
      issues.push(issue("duplicate_frontmatter", "warning", "위키 본문 선두에 중복 YAML frontmatter 블록이 있습니다.", filePath));
      if (options.fix) {
        await writePatchFile(filePath, serializeParsedMarkdown(parsed.rawFrontmatter, strippedBody), paths);
        fixedDuplicateFrontmatterCount += 1;
      }
    }

    parsedWikiFiles.push({ filePath, body: effectiveBody });
    semanticEntries.push(toSemanticEntry(filePath, parsed.frontmatter, effectiveBody));
  }

  issues.push(...await claimIssues(paths, wikiIds));

  for (const parsedWikiFile of parsedWikiFiles) {
    for (const linkedId of extractWikiLinks(parsedWikiFile.body)) {
      if (!wikiIds.has(linkedId)) {
        issues.push(issue("broken_link", "error", `깨진 wiki 링크: ${linkedId}`, parsedWikiFile.filePath));
      }
    }
    for (const legacyLink of extractLegacyMarkdownWikiLinks(parsedWikiFile.body, paths.wikiDir, parsedWikiFile.filePath)) {
      issues.push(
        issue(
          "legacy_markdown_wiki_link",
          "warning",
          `Legacy markdown wiki link detected: ${legacyLink.target}. Use [[wiki:${legacyLink.entryId}]].`,
          parsedWikiFile.filePath,
        ),
      );
    }
  }

  for (const fileName of await listFileNames(paths.rawDir)) {
    if (!fileName.endsWith(".md")) continue;
    const filePath = path.join(paths.rawDir, fileName);
    issues.push(...safetyIssues(await readPatchFile(filePath), filePath));
  }

  for (const queueId of await listDirectoryNames(paths.queueDir)) {
    if (queueId === PATCH_SET_DIRNAME) continue;
    const queueDir = path.join(paths.queueDir, queueId);
    try {
      const patchContent = await readPatchFile(path.join(queueDir, PATCH_FILENAME));
      issues.push(...safetyIssues(patchContent, path.join(queueDir, PATCH_FILENAME)));
      await readJsonFile<PatchMeta>(path.join(queueDir, PATCH_META_FILENAME));
    } catch {
      issues.push(issue("malformed_queue", "error", "손상된 queue 엔트리", queueDir));
    }
  }

  for (const patchSetId of await listDirectoryNames(path.join(paths.queueDir, PATCH_SET_DIRNAME))) {
    const patchSetMetaFile = path.join(paths.queueDir, PATCH_SET_DIRNAME, patchSetId, PATCH_META_FILENAME);
    let patchSet;
    try {
      patchSet = await readPatchSet(paths, patchSetId);
    } catch {
      issues.push(issue("malformed_queue", "error", "손상된 patch set metadata", patchSetMetaFile));
      continue;
    }
    for (const patchId of patchSet.patchIds) {
      const queueMetaFile = path.join(paths.queueDir, patchId, PATCH_META_FILENAME);
      const archiveMetaFile = path.join(paths.archiveDir, patchId, PATCH_META_FILENAME);
      if (!(await pathExists(queueMetaFile)) && !(await pathExists(archiveMetaFile))) {
        issues.push(
          issue(
            "orphan_patch_set_member",
            "error",
            `Patch set ${patchSet.id} references missing patch: ${patchId}`,
            patchSetMetaFile,
          ),
        );
        continue;
      }
      const metaFile = await pathExists(queueMetaFile) ? queueMetaFile : archiveMetaFile;
      try {
        const meta = await readJsonFile<PatchMeta>(metaFile);
        if (meta.patch_set_id && meta.patch_set_id !== patchSet.id) {
          issues.push(
            issue(
              "orphan_patch_set_member",
              "error",
              `Patch set ${patchSet.id} references mismatched patch_set_id on ${patchId}`,
              patchSetMetaFile,
            ),
          );
        }
      } catch {
        issues.push(issue("malformed_queue", "error", "손상된 patch set member metadata", metaFile));
      }
    }
  }

  for (const conflict of await listConflicts(paths)) {
    if (conflict.status !== "unresolved") continue;
    // "미해결 상태의 conflict" 표면화 경고. 코드값이 아래 "손상된 conflict 엔트리"의
    // unresolved_conflict와 의미상 교차되어 있으나, 출력 호환성 계약 때문에 코드값을 바꾸지 않는다.
    issues.push(
      issue(
        "conflict_unresolved",
        "warning",
        `미해결 conflict: ${conflict.reason} (${conflict.target})`,
        path.join(paths.conflictsDir, conflict.id, "meta.json"),
      ),
    );
  }

  for (const conflictId of await listDirectoryNames(paths.conflictsDir)) {
    try {
      await readConflict(conflictId, paths);
    } catch {
      // "손상된(파싱 불가) conflict 엔트리" 경고. 코드값이 위 "미해결 conflict"의
      // conflict_unresolved와 의미상 교차되어 있으나, 출력 호환성 계약 때문에 코드값을 바꾸지 않는다.
      issues.push(
        issue(
          "unresolved_conflict",
          "warning",
          "손상된 conflict 엔트리",
          path.join(paths.conflictsDir, conflictId, "meta.json"),
        ),
      );
    }
  }

  if (!(await pathExists(indexMarkdownFile))) {
    issues.push(issue("missing_index_md", "warning", "wiki/index.md가 없습니다.", indexMarkdownFile));
  } else {
    try {
      const indexContent = await readPatchFile(indexMarkdownFile);
      if (!indexContent.includes("# Fleet Wiki Index")) {
        issues.push(issue("malformed_index_md", "warning", "wiki/index.md에 Fleet Wiki Index 헤더가 없습니다.", indexMarkdownFile));
      }
      if (!indexContent.includes("## Entries")) {
        issues.push(issue("malformed_index_md", "warning", "wiki/index.md에 Entries 섹션이 없습니다.", indexMarkdownFile));
      }
      for (const linkedId of extractWikiLinks(indexContent)) {
        if (!wikiIds.has(linkedId)) {
          issues.push(issue("broken_link", "error", `깨진 wiki 링크: ${linkedId}`, indexMarkdownFile));
        }
      }
    } catch {
      issues.push(issue("malformed_index_md", "warning", "wiki/index.md를 읽을 수 없습니다.", indexMarkdownFile));
    }
  }

  if (!(await pathExists(logFile))) {
    issues.push(issue("missing_log_md", "warning", "log.md가 없습니다.", logFile));
  } else {
    try {
      await parseLog(paths);
    } catch {
      issues.push(issue("malformed_log_md", "warning", "log.md 형식이 손상되었습니다.", logFile));
    }
  }

  issues.push(...await schemaIssues(paths));
  issues.push(...await templateComplianceIssues(paths, semanticEntries));
  issues.push(...semanticIssues(buildSemanticGraph(semanticEntries), await loadIndex(paths), new Date()));

  const errorCount = issues.filter((item) => item.severity === "error").length;
  const report: DryDockReport = {
    ok: errorCount === 0,
    issues,
  };
  await appendLog(paths, "drydock run", {
    error_count: errorCount,
    info_count: issues.filter((item) => item.severity === "info").length,
    issue_count: issues.length,
    ok: report.ok,
    warning_count: issues.filter((item) => item.severity === "warning").length,
    ...(options.fix ? { fixed_duplicate_frontmatter_count: fixedDuplicateFrontmatterCount } : {}),
  });
  return report;
}

async function claimIssues(paths: MemoryPaths, wikiIds: Map<string, string>): Promise<DryDockIssue[]> {
  const issues: DryDockIssue[] = [];
  const claimsDir = getClaimsDir(paths);
  for (const fileName of await listFileNames(claimsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = path.join(claimsDir, fileName);
    const entryIdFromFile = path.basename(fileName, ".json");
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(filePath);
    } catch {
      issues.push(issue("malformed_claim_sidecar", "error", "손상된 claim sidecar JSON", filePath));
      continue;
    }
    try {
      const claimSet = validateClaimSet(raw, entryIdFromFile);
      if (!wikiIds.has(claimSet.entryId)) {
        issues.push(issue("claim_orphan", "error", `Claim sidecar orphan: ${claimSet.entryId}`, filePath));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("entryId mismatch")) {
        issues.push(issue("claim_orphan", "error", message, filePath));
      } else {
        issues.push(issue("malformed_claim_sidecar", "error", `손상된 claim sidecar: ${message}`, filePath));
      }
    }
  }
  return issues;
}

function safetyIssues(content: string, filePath: string): DryDockIssue[] {
  return findUnsafeMemoryText(content).map((issueItem) => ({
    ...issueItem,
    path: filePath,
  }));
}

function parseFrontmatter(content: string): ParsedFrontmatterDocument | null {
  const match = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, rawFrontmatter, body] = match;
  const frontmatter: Record<string, unknown> = {};
  for (const line of rawFrontmatter.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1).trim();
      frontmatter[key] = inner ? inner.split(",").map((item) => item.trim().replace(/^"(.*)"$/, "$1")) : [];
      continue;
    }
    frontmatter[key] = rawValue.replace(/^"(.*)"$/, "$1");
  }
  return { frontmatter, rawFrontmatter, body };
}

function serializeParsedMarkdown(rawFrontmatter: string, body: string): string {
  return `---\n${rawFrontmatter}\n---\n${body}`;
}

function toSemanticEntry(filePath: string, frontmatter: Record<string, unknown>, body: string): ParsedSemanticEntry {
  return {
    id: typeof frontmatter.id === "string" ? frontmatter.id : "",
    title: typeof frontmatter.title === "string" ? frontmatter.title : "",
    filePath,
    frontmatter,
    body,
    bodyHash: hashBodyForComparison(body),
    aliases: asStringArray(frontmatter.aliases),
    type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
    status: normalizeStatus(frontmatter.status),
    confidence: typeof frontmatter.confidence === "string" ? frontmatter.confidence : undefined,
    related: asStringArray(frontmatter.related),
    supersedes: asStringArray(frontmatter.supersedes),
    revalidateAfter: typeof frontmatter.revalidateAfter === "string" ? frontmatter.revalidateAfter : undefined,
    rawSourceRefs: normalizeRawSourceRefs(frontmatter),
    updated: typeof frontmatter.updated === "string" ? frontmatter.updated : undefined,
    outgoingLinks: [...new Set(extractWikiLinks(body))].sort((left, right) => left.localeCompare(right)),
  };
}

async function schemaIssues(paths: MemoryPaths): Promise<DryDockIssue[]> {
  const issues: DryDockIssue[] = [];
  const schema = await readWorkspaceSchemaSummary(paths);
  const agentsPath = path.join(paths.schemaDir, WORKSPACE_SCHEMA_AGENTS_FILENAME);

  if (!(await pathExists(schema.wikiSchemaPath))) {
    issues.push(issue("schema_missing", "warning", `Workspace schema file is missing: schema/${WORKSPACE_SCHEMA_FILENAME}`, schema.wikiSchemaPath));
  } else {
    const schemaContent = await readPatchFile(schema.wikiSchemaPath);
    issues.push(...safetyIssues(schemaContent, schema.wikiSchemaPath));
    for (const section of schema.missingRequiredSections) {
      if (REQUIRED_WORKSPACE_SCHEMA_SECTIONS.includes(section as typeof REQUIRED_WORKSPACE_SCHEMA_SECTIONS[number])) {
        issues.push(
          issue(
            "schema_required_section_missing",
            "warning",
            `Workspace schema required section missing: ${section}`,
            schema.wikiSchemaPath,
          ),
        );
      }
    }
  }

  if (!(await pathExists(agentsPath))) {
    issues.push(issue("schema_agents_missing", "info", `Workspace schema maintainer guide is missing: schema/${WORKSPACE_SCHEMA_AGENTS_FILENAME}`, agentsPath));
  } else {
    const agentsContent = await readPatchFile(agentsPath);
    issues.push(...safetyIssues(agentsContent, agentsPath));
  }

  return issues;
}

async function templateComplianceIssues(paths: MemoryPaths, entries: ParsedSemanticEntry[]): Promise<DryDockIssue[]> {
  const issues: DryDockIssue[] = [];
  const templates = await scanTemplates(paths);
  const templatesById = new Map(templates.map((template) => [template.id, template]));
  for (const entry of entries) {
    const templateId = typeof entry.frontmatter.template_id === "string"
      ? entry.frontmatter.template_id
      : inferTemplateIdFromTarget(entry.filePath, [...templatesById.keys()]);
    if (!templateId) continue;
    const template = templatesById.get(templateId);
    if (!template) {
      issues.push(issue("template_compliance", "warning", `unknown template_id: ${templateId}`, entry.filePath));
      continue;
    }
    if (template.sections.length === 0) {
      issues.push(issue("template_compliance", "warning", `template has no required sections: ${templateId}`, entry.filePath));
      continue;
    }
    const bodySections = new Set(parseBodySections(entry.body));
    const missing = template.sections.filter((section) => !bodySections.has(section));
    if (missing.length > 0) {
      issues.push(
        issue(
          "template_compliance",
          "warning",
          `template ${templateId} missing required body sections: ${missing.join(", ")}`,
          entry.filePath,
        ),
      );
    }
  }
  return issues;
}

function buildSemanticGraph(parsedEntries: ParsedSemanticEntry[]): WikiSemanticGraph {
  const entries = [...parsedEntries].sort((left, right) => left.filePath.localeCompare(right.filePath));
  const byId = new Map<string, ParsedSemanticEntry>();
  const backlinks = new Map<string, Set<string>>();
  const aliasOwners = new Map<string, ParsedSemanticEntry[]>();
  const titleOwners = new Map<string, ParsedSemanticEntry[]>();

  for (const entry of entries) {
    if (entry.id) {
      byId.set(entry.id, entry);
    }
    const titleKey = normalizeLookupKey(entry.title);
    if (titleKey) {
      const owners = titleOwners.get(titleKey) ?? [];
      owners.push(entry);
      titleOwners.set(titleKey, owners);
    }
    for (const alias of entry.aliases) {
      const aliasKey = normalizeLookupKey(alias);
      if (!aliasKey) continue;
      const owners = aliasOwners.get(aliasKey) ?? [];
      owners.push(entry);
      aliasOwners.set(aliasKey, owners);
    }
    for (const linkedId of entry.outgoingLinks) {
      const refs = backlinks.get(linkedId) ?? new Set<string>();
      refs.add(entry.id);
      backlinks.set(linkedId, refs);
    }
  }

  return { entries, byId, backlinks, aliasOwners, titleOwners };
}

function semanticIssues(
  graph: WikiSemanticGraph,
  index: Record<string, { path: string }>,
  now: Date,
): DryDockIssue[] {
  const issues: DryDockIssue[] = [];
  const contradictionKeys = new Set<string>();

  if (graph.entries.length > 1) {
    for (const entry of graph.entries) {
      const backlinks = [...(graph.backlinks.get(entry.id) ?? new Set<string>())].filter((sourceId) => sourceId !== entry.id);
      if (backlinks.length === 0) {
        issues.push(issue("orphan_page", "info", `다른 엔트리에서 참조되지 않는 orphan page: ${entry.id}`, entry.filePath));
      }
    }
  }

  for (const entry of graph.entries) {
    issues.push(...schemaViolationIssues(entry, graph.byId));

    if (entry.revalidateAfter) {
      const revalidateAt = parseOptionalIsoDate(entry.revalidateAfter);
      if (revalidateAt !== null && revalidateAt < now.getTime()) {
        issues.push(issue("stale_entry", "warning", `재검증 기한이 지난 entry: ${entry.id}`, entry.filePath));
      }
    }

    if (entry.status === "deprecated" && index[entry.id]) {
      issues.push(issue("deprecated_in_index", "warning", `Deprecated entry remains indexed as active: ${entry.id}`, entry.filePath));
    }
    if (entry.status === "superseded" && index[entry.id]) {
      issues.push(issue("superseded_in_index", "warning", `Superseded entry remains indexed as active: ${entry.id}`, entry.filePath));
    }
    if (entry.status === "current" && entry.confidence === "high" && entry.rawSourceRefs.length === 0) {
      issues.push(
        issue(
          "missing_raw_source_for_current",
          "warning",
          `Current high-confidence entry is missing raw provenance: ${entry.id}`,
          entry.filePath,
        ),
      );
    }
  }

  for (const [aliasKey, owners] of graph.aliasOwners.entries()) {
    if (owners.length < 2) continue;
    const sortedOwners = [...owners].sort((left, right) => left.filePath.localeCompare(right.filePath));
    for (const owner of sortedOwners.slice(1)) {
      issues.push(issue("duplicate_alias", "error", `중복 alias 소유자: ${aliasKey} -> ${owner.id}`, owner.filePath));
    }
    if (hasConflictingStatuses(sortedOwners)) {
      for (const owner of sortedOwners) {
        const key = `alias-status:${aliasKey}:${owner.filePath}`;
        if (contradictionKeys.has(key)) continue;
        contradictionKeys.add(key);
        issues.push(
          issue(
            "contradiction_marker",
            "info",
            `동일 alias가 상충하는 status에 사용됩니다: ${aliasKey} (${sortedOwners.map((item) => `${item.id}:${item.status}`).join(", ")})`,
            owner.filePath,
          ),
        );
      }
    }
    const currentOwners = sortedOwners.filter((owner) => owner.status === "current");
    if (currentOwners.length > 1 && new Set(currentOwners.map((owner) => owner.bodyHash)).size > 1) {
      for (const owner of currentOwners) {
        const key = `alias-body:${aliasKey}:${owner.filePath}`;
        if (contradictionKeys.has(key)) continue;
        contradictionKeys.add(key);
        issues.push(
          issue(
            "contradiction_marker",
            "info",
            `동일 current alias가 서로 다른 본문을 가집니다: ${aliasKey}`,
            owner.filePath,
          ),
        );
      }
    }
  }

  for (const [titleKey, owners] of graph.titleOwners.entries()) {
    if (owners.length < 2 || !hasConflictingStatuses(owners)) continue;
    const sortedOwners = [...owners].sort((left, right) => left.filePath.localeCompare(right.filePath));
    for (const owner of sortedOwners) {
      const key = `title-status:${titleKey}:${owner.filePath}`;
      if (contradictionKeys.has(key)) continue;
      contradictionKeys.add(key);
      issues.push(
        issue(
          "contradiction_marker",
          "info",
          `동일 title이 상충하는 status에 사용됩니다: ${owner.title}`,
          owner.filePath,
        ),
      );
    }
  }

  const crossReferenceKeys = new Set<string>();
  for (const source of graph.entries) {
    const sourceContent = normalizeLookupKey(`${source.title}\n${source.body}`);
    for (const target of graph.entries) {
      if (source.id === target.id) continue;
      if (source.outgoingLinks.includes(target.id)) continue;
      const candidatePhrases = [target.title, ...target.aliases]
        .map((item) => item.trim())
        .filter((item) => item.length >= LOOKUP_PHRASE_MIN_LENGTH);
      const matchedPhrase = candidatePhrases.find((phrase) => containsNormalizedPhrase(sourceContent, normalizeLookupKey(phrase)));
      if (!matchedPhrase) continue;
      const key = `${source.id}->${target.id}`;
      if (crossReferenceKeys.has(key)) continue;
      crossReferenceKeys.add(key);
      issues.push(
        issue(
          "cross_reference_suggestion",
          "info",
          `명시적 cross reference 제안: ${source.id} -> [[wiki:${target.id}]] (${matchedPhrase})`,
          source.filePath,
        ),
      );
    }
  }

  for (const cycle of findSupersedesCycles(graph)) {
    for (const entry of cycle) {
      const key = `cycle:${cycle.map((item) => item.id).join("->")}:${entry.filePath}`;
      if (contradictionKeys.has(key)) continue;
      contradictionKeys.add(key);
      issues.push(
        issue(
          "contradiction_marker",
          "info",
          `supersedes cycle detected: ${cycle.map((item) => item.id).join(" -> ")}`,
          entry.filePath,
        ),
      );
    }
  }

  return issues;
}

function schemaViolationIssues(entry: ParsedSemanticEntry, byId: Map<string, ParsedSemanticEntry>): DryDockIssue[] {
  const issues: DryDockIssue[] = [];
  const frontmatter = entry.frontmatter;

  if ("tags" in frontmatter && !Array.isArray(frontmatter.tags)) {
    issues.push(issue("schema_violation", "warning", "frontmatter.tags must be an array", entry.filePath));
  }
  if ("aliases" in frontmatter && !Array.isArray(frontmatter.aliases)) {
    issues.push(issue("schema_violation", "warning", "frontmatter.aliases must be an array", entry.filePath));
  }
  if ("related" in frontmatter && !Array.isArray(frontmatter.related)) {
    issues.push(issue("schema_violation", "warning", "frontmatter.related must be an array", entry.filePath));
  }
  if ("supersedes" in frontmatter && !Array.isArray(frontmatter.supersedes)) {
    issues.push(issue("schema_violation", "warning", "frontmatter.supersedes must be an array", entry.filePath));
  }
  if ("rawSourceRefs" in frontmatter && normalizeRawSourceRefs(frontmatter).length === 0 && !hasRawSourceRef(frontmatter)) {
    issues.push(issue("schema_violation", "warning", "frontmatter.rawSourceRefs must be parseable provenance refs", entry.filePath));
  }
  if (typeof frontmatter.type === "string" && !NORMALIZED_TYPES.has(frontmatter.type)) {
    issues.push(issue("schema_violation", "warning", `unknown wiki type: ${frontmatter.type}`, entry.filePath));
  }
  if (typeof frontmatter.status === "string" && !NORMALIZED_STATUSES.has(frontmatter.status)) {
    issues.push(issue("schema_violation", "warning", `unknown wiki status: ${frontmatter.status}`, entry.filePath));
  }
  for (const key of ["created", "updated", "revalidateAfter"] as const) {
    if (!(key in frontmatter)) continue;
    const value = frontmatter[key];
    if (typeof value !== "string" || parseOptionalIsoDate(value) === null) {
      issues.push(issue("schema_violation", "warning", `frontmatter.${key} must be a valid ISO date`, entry.filePath));
    }
  }
  for (const relatedId of entry.related) {
    if (!byId.has(relatedId)) {
      issues.push(issue("schema_violation", "warning", `related id does not exist: ${relatedId}`, entry.filePath));
    }
  }
  for (const supersedesId of entry.supersedes) {
    if (!byId.has(supersedesId)) {
      issues.push(issue("schema_violation", "warning", `supersedes id does not exist: ${supersedesId}`, entry.filePath));
    }
  }

  return issues;
}

function hasRawSourceRef(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.rawSourceRef === "string" && frontmatter.rawSourceRef.trim().length > 0;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function parseBodySections(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.match(/^##\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((section): section is string => Boolean(section));
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeStatus(value: unknown): ParsedSemanticEntry["status"] {
  if (typeof value !== "string") return "unknown";
  if (value === "draft" || value === "current" || value === "deprecated" || value === "superseded") {
    return value;
  }
  return "unknown";
}

function normalizeRawSourceRefs(frontmatter: Record<string, unknown>): string[] {
  const refs: string[] = [];
  if (typeof frontmatter.rawSourceRef === "string" && frontmatter.rawSourceRef.trim().length > 0) {
    refs.push(frontmatter.rawSourceRef.trim());
  }
  const rawValue = frontmatter.rawSourceRefs;
  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      if (typeof item === "string" && item.trim().length > 0) {
        refs.push(item.trim());
      }
    }
    return dedupeStrings(refs);
  }
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return dedupeStrings(refs);
  }
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return dedupeStrings(refs);
    }
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof (item as { ref?: unknown }).ref === "string") {
        refs.push(String((item as { ref: string }).ref));
      }
    }
  } catch {
    return [];
  }
  return dedupeStrings(refs);
}

function parseOptionalIsoDate(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hashBodyForComparison(body: string): string {
  return crypto.createHash("sha256").update(body.replace(/\s+/g, " ").trim(), "utf8").digest("hex").slice(0, 8);
}

function hasConflictingStatuses(entries: ParsedSemanticEntry[]): boolean {
  const statuses = new Set(entries.map((entry) => entry.status).filter((status) => status !== "unknown"));
  return statuses.has("current") && (statuses.has("deprecated") || statuses.has("superseded"));
}

function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function findSupersedesCycles(graph: WikiSemanticGraph): ParsedSemanticEntry[][] {
  const cycles = new Map<string, ParsedSemanticEntry[]>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (entryId: string, trail: string[]): void => {
    if (visiting.has(entryId)) {
      const cycleStart = trail.indexOf(entryId);
      if (cycleStart !== -1) {
        const cycleIds = trail.slice(cycleStart);
        const key = [...cycleIds].sort().join("|");
        if (!cycles.has(key)) {
          cycles.set(
            key,
            cycleIds
              .map((id) => graph.byId.get(id))
              .filter((entry): entry is ParsedSemanticEntry => Boolean(entry)),
          );
        }
      }
      return;
    }
    if (visited.has(entryId)) return;
    const entry = graph.byId.get(entryId);
    if (!entry) return;
    visiting.add(entryId);
    for (const nextId of entry.supersedes) {
      visit(nextId, [...trail, entryId]);
    }
    visiting.delete(entryId);
    visited.add(entryId);
  };

  for (const entry of graph.entries) {
    visit(entry.id, []);
  }

  return [...cycles.values()].sort((left, right) => {
    const leftKey = left.map((entry) => entry.id).join("|");
    const rightKey = right.map((entry) => entry.id).join("|");
    return leftKey.localeCompare(rightKey);
  });
}

function issue(code: DryDockIssue["code"], severity: DryDockIssue["severity"], message: string, filePath: string): DryDockIssue {
  return {
    code,
    severity,
    message,
    path: filePath,
  };
}

async function listWikiMarkdownFiles(dirPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listWikiMarkdownFiles(filePath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name === INDEX_MD_FILENAME) continue;
    files.push(filePath);
  }
  return files;
}
