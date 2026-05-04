import crypto from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { INDEX_FILENAME, REQUIRED_WIKI_FRONTMATTER_KEYS } from "./constants.js";
import { ensureMemoryRoot } from "./paths.js";
import type { WikiIndexEntry, MemoryPaths, RawSourceEntry, WikiEntry } from "./types.js";

type FrontmatterShape = Record<string, unknown>;

export async function readWikiEntry(id: string, paths: MemoryPaths): Promise<WikiEntry | null> {
  const index = await loadIndex(paths);
  const indexed = index[id];
  if (indexed) {
    return readMarkdownFile<WikiEntry>(path.join(paths.root, indexed.path));
  }
  const fallbackPath = path.join(paths.wikiDir, `${id}.md`);
  if (!(await pathExists(fallbackPath))) return null;
  return readMarkdownFile<WikiEntry>(fallbackPath);
}

export async function writeWikiEntry(entry: WikiEntry, paths: MemoryPaths): Promise<string> {
  await ensureMemoryRoot(paths);
  assertSafeEntryId(entry.id);
  const relativePath = `wiki/${entry.id}.md`;
  await writeMarkdownAtomic(path.join(paths.root, relativePath), serializeWikiEntry(entry), paths);
  return relativePath;
}

export async function writeRawSourceEntry(entry: RawSourceEntry, paths: MemoryPaths): Promise<string> {
  await ensureMemoryRoot(paths);
  assertSafeEntryId(entry.id);
  const datePrefix = entry.created.slice(0, 10);
  const relativePath = `raw/${datePrefix}-${entry.id}.md`;
  const content = serializeMarkdown(
    {
      id: entry.id,
      created: entry.created,
      sourceType: entry.sourceType,
      title: entry.title ?? "",
      tags: entry.tags,
    },
    entry.content,
  );
  await writeMarkdownAtomic(path.join(paths.root, relativePath), content, paths);
  return relativePath;
}

export async function listWiki(paths: MemoryPaths): Promise<WikiEntry[]> {
  return listMarkdownEntries(paths.wikiDir, (content) => parseWikiEntry(content));
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
  const entries = await listWiki(paths);
  const nextIndex: Record<string, WikiIndexEntry> = {};
  for (const entry of entries) {
    nextIndex[entry.id] = {
      path: `wiki/${entry.id}.md`,
      title: entry.title,
      tags: entry.tags,
      updated: entry.updated,
    };
  }
  await writeJsonAtomic(paths.indexFile, nextIndex, paths);
  return nextIndex;
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
    body: parsed.body,
  };
}

async function listMarkdownEntries<T>(dirPath: string, parser: (content: string) => T): Promise<T[]> {
  const names = await listFileNames(dirPath);
  const items: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const content = await readFile(path.join(dirPath, name), "utf8");
    items.push(parser(content));
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
