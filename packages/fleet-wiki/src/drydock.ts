import path from "node:path";

import { INDEX_MD_FILENAME, PATCH_FILENAME, PATCH_META_FILENAME, REQUIRED_WIKI_FRONTMATTER_KEYS } from "./constants.js";
import { extractLegacyMarkdownWikiLinks, extractWikiLinks } from "./links.js";
import { appendLog, parseLog } from "./log.js";
import { getIndexMarkdownFile, getLogFile } from "./paths.js";
import { findUnsafeMemoryText } from "./safety.js";
import {
  REQUIRED_WORKSPACE_SCHEMA_SECTIONS,
  WORKSPACE_SCHEMA_AGENTS_FILENAME,
  WORKSPACE_SCHEMA_FILENAME,
  readWorkspaceSchemaSummary,
} from "./schema.js";
import { listDirectoryNames, listFileNames, pathExists, readJsonFile, readPatchFile } from "./store.js";
import type { DryDockIssue, DryDockReport, MemoryPaths, PatchMeta } from "./types.js";

const INLINE_RAW_SOURCE_REF_PATTERN = /(^|\n)raw_source_ref\s*:/i;

export async function runDryDock(paths: MemoryPaths): Promise<DryDockReport> {
  const issues: DryDockIssue[] = [];
  const wikiIds = new Map<string, string>();
  const parsedWikiFiles: Array<{ filePath: string; body: string }> = [];
  const indexMarkdownFile = getIndexMarkdownFile(paths);
  const logFile = getLogFile(paths);

  for (const fileName of await listFileNames(paths.wikiDir)) {
    if (!fileName.endsWith(".md")) continue;
    if (fileName === INDEX_MD_FILENAME) continue;
    const filePath = path.join(paths.wikiDir, fileName);
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
    parsedWikiFiles.push({ filePath, body: parsed.body });
  }

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
    const queueDir = path.join(paths.queueDir, queueId);
    try {
      const patchContent = await readPatchFile(path.join(queueDir, PATCH_FILENAME));
      issues.push(...safetyIssues(patchContent, path.join(queueDir, PATCH_FILENAME)));
      await readJsonFile<PatchMeta>(path.join(queueDir, PATCH_META_FILENAME));
    } catch {
      issues.push(issue("malformed_queue", "error", "손상된 queue 엔트리", queueDir));
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
  });
  return report;
}

function safetyIssues(content: string, filePath: string): DryDockIssue[] {
  return findUnsafeMemoryText(content).map((issueItem) => ({
    ...issueItem,
    path: filePath,
  }));
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
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
  return { frontmatter, body };
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

function issue(code: DryDockIssue["code"], severity: DryDockIssue["severity"], message: string, filePath: string): DryDockIssue {
  return {
    code,
    severity,
    message,
    path: filePath,
  };
}
