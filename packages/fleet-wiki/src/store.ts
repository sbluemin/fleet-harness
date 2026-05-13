import crypto from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { INDEX_FILENAME, INDEX_MD_FILENAME, REQUIRED_WIKI_FRONTMATTER_KEYS } from "./constants.js";
import { appendLog } from "./log.js";
import { ensureMemoryRoot, getIndexMarkdownFile } from "./paths.js";
import {
  WIKI_ENTRY_CONFIDENCES,
  WIKI_ENTRY_STATUSES,
  WIKI_ENTRY_TYPES,
  type WikiIndexEntry,
  type MemoryPaths,
  type RawSourceEntry,
  type WikiEntry,
  type WikiRawSourceRef,
} from "./types.js";

type FrontmatterShape = Record<string, unknown>;

export async function readWikiEntry(id: string, paths: MemoryPaths): Promise<WikiEntry | null> {
  if (id === "index") {
    return null;
  }
  // Validate caller-supplied id to block path traversal attempts.
  try {
    assertSafeEntryId(id);
  } catch {
    return null;
  }
  const index = await loadIndex(paths);
  const indexed = index[id];
  if (indexed) {
    // Validate index.json-supplied path stays within wikiDir before trusting it.
    const resolved = path.resolve(paths.root, indexed.path);
    const rel = path.relative(paths.wikiDir, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return readMarkdownFile<WikiEntry>(resolved);
  }
  const fallbackPath = path.join(paths.wikiDir, `${id}.md`);
  if (await pathExists(fallbackPath)) {
    return readMarkdownFile<WikiEntry>(fallbackPath);
  }
  // index.json drift / nested-namespace fallback: recursive scan finds entries under
  // wiki/queries/, wiki/sources/, wiki/synthesis/ even when index.json is stale or missing.
  const records = await listWikiRecords(paths);
  const match = records.find((record) => record.entry.id === id);
  return match ? match.entry : null;
}

export async function writeWikiEntry(entry: WikiEntry, paths: MemoryPaths): Promise<string> {
  await ensureMemoryRoot(paths);
  assertSafeEntryId(entry.id);
  const relativePath = `wiki/${entry.id}.md`;
  await writeMarkdownAtomic(path.join(paths.root, relativePath), serializeWikiEntry(entry), paths);
  return relativePath;
}

export async function writeWikiEntryAtTarget(entry: WikiEntry, target: string, paths: MemoryPaths): Promise<string> {
  await ensureMemoryRoot(paths);
  assertSafeEntryId(entry.id);
  const absoluteTarget = path.resolve(paths.root, target);
  const relativeTarget = path.relative(paths.wikiDir, absoluteTarget);
  if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`[fleet-wiki] wiki target escapes wiki/: ${target}`);
  }
  if (!absoluteTarget.endsWith(".md")) {
    throw new Error(`[fleet-wiki] wiki target must end with .md: ${target}`);
  }
  if (path.basename(absoluteTarget, ".md") !== entry.id) {
    throw new Error("wiki patch body id must match target filename");
  }
  await mkdir(path.dirname(absoluteTarget), { recursive: true });
  await writeMarkdownAtomic(absoluteTarget, serializeWikiEntry(entry), paths);
  return path.join("wiki", relativeTarget).replaceAll(path.sep, "/");
}

export async function writeRawSourceEntry(entry: RawSourceEntry, paths: MemoryPaths): Promise<string> {
  await ensureMemoryRoot(paths);
  assertSafeEntryId(entry.id);
  const datePrefix = entry.created.slice(0, 10);
  const contentHash = computeContentHash(entry.content);
  const relativePath = `raw/${datePrefix}-${entry.id}-${contentHash}.md`;
  const content = serializeMarkdown(
    {
      id: entry.id,
      created: entry.created,
      sourceType: entry.sourceType,
      title: entry.title ?? "",
      tags: entry.tags,
      contentHash,
    },
    entry.content,
  );
  await writeMarkdownAtomic(path.join(paths.root, relativePath), content, paths);
  return relativePath;
}

export async function readRawSourceEntry(rawSourceRef: string, paths: MemoryPaths): Promise<RawSourceEntry> {
  const absolutePath = path.resolve(paths.root, rawSourceRef);
  assertWithinRawDir(absolutePath, paths);
  const parsed = parseMarkdown(await readFile(absolutePath, "utf8"));
  return {
    id: String(parsed.frontmatter.id),
    created: String(parsed.frontmatter.created),
    sourceType: parsed.frontmatter.sourceType === "file" ? "file" : "inline",
    title: parsed.frontmatter.title ? String(parsed.frontmatter.title) : undefined,
    tags: normalizeStringArray(parsed.frontmatter.tags),
    contentHash: parsed.frontmatter.contentHash ? String(parsed.frontmatter.contentHash) : undefined,
    content: parsed.body,
  };
}

export async function listWiki(paths: MemoryPaths): Promise<WikiEntry[]> {
  const entries = await listWikiRecords(paths);
  return entries.map((entry) => entry.entry);
}

export async function loadIndex(paths: MemoryPaths): Promise<Record<string, WikiIndexEntry>> {
  try {
    const raw = await readFile(paths.indexFile, "utf8");
    return JSON.parse(raw) as Record<string, WikiIndexEntry>;
  } catch {
    return {};
  }
}

export async function rebuildIndex(paths: MemoryPaths): Promise<Record<string, WikiIndexEntry>> {
  await ensureMemoryRoot(paths);
  const entries = await listWikiRecords(paths);
  const nextIndex: Record<string, WikiIndexEntry> = {};
  const entryPathMap: Record<string, string> = {};
  for (const item of entries) {
    nextIndex[item.entry.id] = {
      path: item.path,
      title: item.entry.title,
      tags: item.entry.tags,
      updated: item.entry.updated,
      type: item.entry.type,
      status: item.entry.status,
      confidence: item.entry.confidence,
      aliases: item.entry.aliases,
    };
    entryPathMap[item.entry.id] = item.path;
  }
  await writeJsonAtomic(paths.indexFile, nextIndex, paths);
  await writeMarkdownAtomic(getIndexMarkdownFile(paths), renderIndexMarkdown(entries.map((item) => item.entry), entryPathMap), paths);
  await appendLog(paths, "index rebuilt", { entry_count: entries.length });
  return nextIndex;
}

export function renderIndexMarkdown(entries: WikiEntry[], entryPaths: Record<string, string> = {}): string {
  const sortedEntries = [...entries].sort((left, right) => left.id.localeCompare(right.id));
  const tagGroups = new Map<string, WikiEntry[]>();
  for (const entry of sortedEntries) {
    const tags = entry.tags.length > 0 ? entry.tags : ["(untagged)"];
    for (const tag of tags) {
      const group = tagGroups.get(tag) ?? [];
      group.push(entry);
      tagGroups.set(tag, group);
    }
  }
  const sortedTags = [...tagGroups.keys()].sort((left, right) => {
    if (left === "(untagged)") return 1;
    if (right === "(untagged)") return -1;
    return left.localeCompare(right);
  });

  const lines = [
    "# Fleet Wiki Index",
    "",
    "## Summary",
    "",
    `- total_entries: \`${sortedEntries.length}\``,
    "- generated_from: `index.json`",
    "- ordering: `id ascending`",
    "",
    "## Entries",
    "",
  ];

  for (const entry of sortedEntries) {
    lines.push(`### ${entry.id}`);
    lines.push("");
    lines.push(`- title: \`${escapeInlineCode(entry.title)}\``);
    lines.push(`- path: \`${escapeInlineCode(entryPaths[entry.id] ?? `wiki/${entry.id}.md`)}\``);
    lines.push(`- tags: \`${escapeInlineCode(entry.tags.length > 0 ? entry.tags.join(", ") : "(none)")}\``);
    lines.push(`- updated: \`${escapeInlineCode(entry.updated)}\``);
    if (entry.type) {
      lines.push(`- type: \`${escapeInlineCode(entry.type)}\``);
    }
    if (entry.status) {
      lines.push(`- status: \`${escapeInlineCode(entry.status)}\``);
    }
    if (entry.confidence) {
      lines.push(`- confidence: \`${escapeInlineCode(entry.confidence)}\``);
    }
    if (entry.aliases?.length) {
      lines.push(`- aliases: \`${escapeInlineCode(entry.aliases.join(", "))}\``);
    }
    const summary = summarizeWikiEntry(entry.body);
    if (summary) {
      lines.push(`- summary: \`${escapeInlineCode(summary)}\``);
    }
    if (entry.rawSourceRef) {
      lines.push(`- raw_source_ref: \`${escapeInlineCode(entry.rawSourceRef)}\``);
    }
    if (entry.rawSourceRefs?.length) {
      lines.push(`- raw_source_refs: \`${escapeInlineCode(entry.rawSourceRefs.map((item) => item.ref).join(", "))}\``);
    }
    lines.push("");
  }

  lines.push("## Tags");
  lines.push("");
  for (const tag of sortedTags) {
    lines.push(`### ${tag}`);
    lines.push("");
    const group = [...(tagGroups.get(tag) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    for (const entry of group) {
      lines.push(`- [[wiki:${entry.id}]] — ${entry.title}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export async function readPatchFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function writePatchFile(filePath: string, content: string, paths: MemoryPaths): Promise<void> {
  await writeMarkdownAtomic(filePath, content, paths);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(filePath: string, value: unknown, paths: MemoryPaths): Promise<void> {
  await writeJsonAtomic(filePath, value, paths);
}

export async function movePath(fromPath: string, toPath: string): Promise<void> {
  await rename(fromPath, toPath);
}

export async function removePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function listDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function listFileNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export function assertSafeEntryId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error(`unsafe wiki id: ${id}`);
  }
  if (RESERVED_WIKI_ENTRY_IDS.has(id)) {
    throw new Error(
      `[fleet-wiki] reserved wiki id: ${id} - this id collides with a generated catalog file (e.g., wiki/index.md)`,
    );
  }
}

const RESERVED_WIKI_ENTRY_IDS = new Set<string>(["index"]);

function assertWithinRawDir(absolutePath: string, paths: MemoryPaths): void {
  const relative = path.relative(paths.rawDir, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[fleet-wiki] raw source ref escapes raw/: ${absolutePath}`);
  }
}

export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 8);
}

function serializeWikiEntry(entry: WikiEntry): string {
  const frontmatter: FrontmatterShape = {
    id: entry.id,
    title: entry.title,
    tags: entry.tags,
    created: entry.created,
    updated: entry.updated,
    version: entry.version,
  };
  if (entry.rawSourceRef) frontmatter.rawSourceRef = entry.rawSourceRef;
  if (entry.aliases?.length) frontmatter.aliases = entry.aliases;
  if (entry.type) frontmatter.type = entry.type;
  if (entry.status) frontmatter.status = entry.status;
  if (entry.confidence) frontmatter.confidence = entry.confidence;
  if (entry.owner) frontmatter.owner = entry.owner;
  if (entry.language) frontmatter.language = entry.language;
  if (entry.revalidateAfter) frontmatter.revalidateAfter = entry.revalidateAfter;
  if (entry.supersedes?.length) frontmatter.supersedes = entry.supersedes;
  if (entry.related?.length) frontmatter.related = entry.related;
  if (entry.rawSourceRefs?.length) frontmatter.rawSourceRefs = JSON.stringify(entry.rawSourceRefs);
  assertRequiredKeys(frontmatter, REQUIRED_WIKI_FRONTMATTER_KEYS);
  return serializeMarkdown(frontmatter, entry.body);
}

function parseWikiEntry(content: string): WikiEntry {
  const parsed = parseMarkdown(content);
  assertRequiredKeys(parsed.frontmatter, REQUIRED_WIKI_FRONTMATTER_KEYS);
  return {
    id: String(parsed.frontmatter.id),
    title: String(parsed.frontmatter.title),
    tags: normalizeStringArray(parsed.frontmatter.tags),
    created: String(parsed.frontmatter.created),
    updated: String(parsed.frontmatter.updated),
    version: Number(parsed.frontmatter.version),
    rawSourceRef: parsed.frontmatter.rawSourceRef ? String(parsed.frontmatter.rawSourceRef) : undefined,
    aliases: optionalStringArray(parsed.frontmatter.aliases),
    type: optionalEnum(parsed.frontmatter.type, WIKI_ENTRY_TYPES),
    status: optionalEnum(parsed.frontmatter.status, WIKI_ENTRY_STATUSES),
    confidence: optionalEnum(parsed.frontmatter.confidence, WIKI_ENTRY_CONFIDENCES),
    owner: optionalString(parsed.frontmatter.owner),
    language: optionalString(parsed.frontmatter.language),
    revalidateAfter: optionalString(parsed.frontmatter.revalidateAfter),
    supersedes: optionalStringArray(parsed.frontmatter.supersedes),
    related: optionalStringArray(parsed.frontmatter.related),
    rawSourceRefs: optionalRawSourceRefs(parsed.frontmatter.rawSourceRefs),
    body: parsed.body,
  };
}

async function listWikiRecords(paths: MemoryPaths): Promise<Array<{ entry: WikiEntry; path: string }>> {
  return listMarkdownEntriesRecursive(paths.wikiDir, paths, (content, filePath) => ({
    entry: parseWikiEntry(content),
    path: path.relative(paths.root, filePath).replaceAll(path.sep, "/"),
  }));
}

async function listMarkdownEntriesRecursive<T>(
  dirPath: string,
  paths: MemoryPaths,
  parser: (content: string, filePath: string) => T,
): Promise<T[]> {
  const items: T[] = [];
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return items;
  }
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      items.push(...await listMarkdownEntriesRecursive(filePath, paths, parser));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (filePath === getIndexMarkdownFile(paths)) continue;
    const content = await readFile(filePath, "utf8");
    items.push(parser(content, filePath));
  }
  return items;
}

async function readMarkdownFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf8");
  if (filePath.endsWith(`${INDEX_FILENAME}`)) {
    throw new Error("JSON index file cannot be read as markdown");
  }
  return parseWikiEntry(content) as T;
}

function parseMarkdown(content: string): { frontmatter: FrontmatterShape; body: string } {
  const match = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("missing frontmatter");
  const [, rawFrontmatter, body] = match;
  const frontmatter: FrontmatterShape = {};
  for (const line of rawFrontmatter.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    frontmatter[key] = parseFrontmatterValue(rawValue);
  }
  return { frontmatter, body };
}

function parseFrontmatterValue(rawValue: string): unknown {
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const inner = rawValue.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim())
      .map((item) => decodeFrontmatterString(item.replace(/^"(.*)"$/, "$1")));
  }
  if (/^-?\d+$/.test(rawValue)) return Number(rawValue);
  return decodeFrontmatterString(rawValue.replace(/^"(.*)"$/, "$1"));
}

function serializeMarkdown(frontmatter: FrontmatterShape, body: string): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${serializeFrontmatterValue(value)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function serializeFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => `"${escapeFrontmatterString(item)}"`).join(", ")}]`;
  }
  if (typeof value === "number") return String(value);
  return `"${escapeFrontmatterString(value)}"`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("expected string array");
  return value.map((item) => String(item));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((item) => String(item)) : undefined;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function optionalRawSourceRefs(value: unknown): WikiRawSourceRef[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const refs = parsed
      .map((item) => normalizeRawSourceRef(item))
      .filter((item): item is WikiRawSourceRef => item !== undefined);
    return refs.length > 0 ? refs : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRawSourceRef(value: unknown): WikiRawSourceRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ref !== "string") return undefined;
  return {
    ref: candidate.ref,
    title: typeof candidate.title === "string" ? candidate.title : undefined,
    hash: typeof candidate.hash === "string" ? candidate.hash : undefined,
  };
}

function escapeFrontmatterString(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function decodeFrontmatterString(value: string): string {
  // 단일 패스로 backslash escape를 풀어 순서 의존을 제거한다.
  // 순차 replace를 사용하면 직렬화된 `\\n`(literal `\n`)이 디코드 단계에서
  // 실제 newline으로 잘못 변환되어 원본이 손상될 수 있다.
  return value.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case "r": return "\r";
      case "n": return "\n";
      case "\"": return "\"";
      case "\\": return "\\";
      default: return `\\${ch}`;
    }
  });
}

function assertRequiredKeys(value: object, keys: readonly string[]): void {
  for (const key of keys) {
    if (!(key in value)) throw new Error(`missing required key: ${key}`);
  }
}

async function writeMarkdownAtomic(filePath: string, content: string, paths: MemoryPaths): Promise<void> {
  await writeAtomic(filePath, content, paths);
}

async function writeJsonAtomic(filePath: string, value: unknown, paths: MemoryPaths): Promise<void> {
  await writeAtomic(filePath, JSON.stringify(value, null, 2), paths);
}

async function writeAtomic(filePath: string, content: string, paths: MemoryPaths): Promise<void> {
  await ensureMemoryRoot(paths);
  const tempPath = path.join(
    path.dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}-${os.hostname()}`,
  );
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function summarizeWikiEntry(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  return normalizeSummaryWhitespace(firstLine).slice(0, 160);
}

function normalizeSummaryWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}
