import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { CommodoreStoreError } from "./errors.js";

/**
 * fleet-memory — 사령관만 쓰는 Theater 의 기억. 사령관 폴더 안 `memory/` 하나에 갈래·주제·항목 세 단계로 둔다.
 *
 * ```
 * commodore/memory/MEMORY.md                  쓰기마다 다시 만드는 인덱스(손으로 쓰지 않는다)
 * commodore/memory/<갈래>/<주제>/<slug>.md    항목 하나 = 사실 하나
 * ```
 *
 * 쓰는 쪽은 사령관 도구뿐이고 화면은 읽기만 한다. 사령관 상태와 같은 원칙으로 잠금·감시 없이 tmp→rename 으로 쓰고, 다 쓴 뒤에
 * 인덱스를 다시 만들고 마지막에 알린다. 읽기는 세 단계 밖의 파일·링크를 건너뛰고, 깨진 항목은 빼고 보여 준다.
 */

import { MEMORY_BRANCHES, type MemoryBranch, type MemoryEntry, type MemorySource } from "@fleet-console/sdk/commodore";
export { MEMORY_BRANCHES, type MemoryBranch, type MemoryEntry, type MemorySource } from "@fleet-console/sdk/commodore";

export const MAX_MEMORY_ENTRIES = 200;
export const MAX_MEMORY_LINKS = 10;
export const MAX_MEMORY_SOURCES = 10;
export const MAX_MEMORY_TITLE = 80;
export const MAX_MEMORY_DESCRIPTION = 200;
export const MAX_MEMORY_BODY = 1_500;
/** 턴마다 싣는 인덱스의 상한 — 넘으면 잘라 싣고 잘렸다고 적는다. */
export const MAX_MEMORY_INDEX_PROMPT = 8 * 1024;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 주제 이름은 화면에 그대로 서는 디렉터리 이름이다 — 글자·숫자로 시작하고, 끝이 공백·점이 아니다. */
const TOPIC = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]{0,38}[\p{L}\p{N}_-])?$/u;
const INDEX_FILE = "MEMORY.md";
/** 항목 파일이 절을 나누는 제목 줄 — 본문에는 들어올 수 없다. */
const BODY_HEADING = /^## /m;

export const memoryBranchSchema = z.enum(MEMORY_BRANCHES);
export const memoryTopicSchema = z.string().transform((value) => value.normalize("NFC")).pipe(z.string().regex(TOPIC));
export const memorySlugSchema = z.string().regex(SLUG);
export const memoryRefSchema = z.string().min(5).max(160);


export interface MemorySaveInput {
  readonly branch: MemoryBranch;
  readonly topic: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly why: string;
  readonly how: string;
  readonly sources?: readonly MemorySource[];
  readonly links?: readonly string[];
}

export type MemoryPatch = Partial<Pick<MemorySaveInput, "title" | "description" | "why" | "how" | "sources" | "links">>;
export type MemoryChange = "save" | "update" | "verify" | "delete";

export interface CommodoreMemory {
  /** 갈래·주제·제목 순. 사령관 폴더를 모르면 `theater_unavailable`. */
  list(commodoreId: string): readonly MemoryEntry[];
  /** 없으면 `unknown_memory`, 이름이 규칙 밖이면 `invalid_ref`. */
  read(commodoreId: string, ref: string): MemoryEntry;
  /** 이미 있으면 `memory_exists`, 상한이면 `too_many_memories`, 비밀 값 모양이면(이름·연결 포함) `memory_secret`, 본문에 `## ` 줄이 있으면 `memory_heading`. */
  save(commodoreId: string, input: MemorySaveInput): MemoryEntry;
  /** 준 필드만 바꾸고 갱신·검증 시각을 지금으로. 필드가 없으면 검증 시각만 지금으로(다시 확인함). */
  update(commodoreId: string, ref: string, patch: MemoryPatch): { readonly entry: MemoryEntry; readonly change: "update" | "verify" };
  remove(commodoreId: string, ref: string): void;
  /** MEMORY.md 본문 — 항목이 없으면 빈 문자열. */
  index(commodoreId: string): string;
}

export interface CommodoreMemoryOptions {
  /** Console 데이터의 사령관 폴더(`commodore/<UUID>`). 모르면 `theater_unavailable` 을 던진다. */
  readonly dirFor: (commodoreId: string) => string;
  readonly now: () => number;
  readonly onChange: (commodoreId: string, change: MemoryChange, ref: string) => void;
  readonly writeFile: (file: string, data: string) => void;
}

/**
 * 비밀 값처럼 보이는 문자열 — 기억은 오래 남고 사람 화면에 보이므로 키·토큰은 받지 않는다. 정확한 판별이 아니라 흔한 모양의 거절이다.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** ref 를 갈래·주제·slug 로 — 규칙 밖이면 `invalid_ref`. 디렉터리 이름은 NFC 로 맞춘다. */
export function parseMemoryRef(ref: string): { readonly branch: MemoryBranch; readonly topic: string; readonly slug: string } {
  const parts = ref.normalize("NFC").split("/");
  if (parts.length !== 3) throw new CommodoreStoreError("invalid_ref");
  const branch = memoryBranchSchema.safeParse(parts[0]);
  const topic = memoryTopicSchema.safeParse(parts[1]);
  const slug = memorySlugSchema.safeParse(parts[2]);
  if (!branch.success || !topic.success || !slug.success) throw new CommodoreStoreError("invalid_ref");
  return { branch: branch.data, topic: topic.data, slug: slug.data };
}

const refOf = (branch: string, topic: string, slug: string) => `${branch}/${topic}/${slug}`;

export function createCommodoreMemory(options: CommodoreMemoryOptions): CommodoreMemory {
  const rootFor = (commodoreId: string) => path.join(options.dirFor(commodoreId), "memory");

  /** 실경로가 기억 폴더 안인지 — 밖을 가리키는 링크로 된 갈래·주제·파일은 없는 것으로 본다. */
  const contained = (root: string, target: string): boolean => {
    try {
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(target);
      const relative = path.relative(realRoot, real);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    } catch { return false; }
  };

  const list = (commodoreId: string): MemoryEntry[] => {
    const root = rootFor(commodoreId);
    if (!fs.existsSync(root)) return [];
    const entries: MemoryEntry[] = [];
    for (const branch of MEMORY_BRANCHES) {
      const branchDir = path.join(root, branch);
      if (!isRealDir(branchDir) || !contained(root, branchDir)) continue;
      for (const topicName of fs.readdirSync(branchDir)) {
        const topic = topicName.normalize("NFC");
        if (!memoryTopicSchema.safeParse(topic).success) continue;
        const topicDir = path.join(branchDir, topicName);
        if (!isRealDir(topicDir) || !contained(root, topicDir)) continue;
        for (const fileName of fs.readdirSync(topicDir)) {
          if (!fileName.endsWith(".md")) continue;
          const slug = fileName.slice(0, -3);
          if (!SLUG.test(slug)) continue;
          const file = path.join(topicDir, fileName);
          if (!isRealFile(file) || !contained(root, file)) continue;
          const entry = parseEntryFile(fs.readFileSync(file, "utf8"), branch, topic, slug);
          if (entry) entries.push(entry);
          else console.warn(`[objectives] commodore memory entry unreadable, skipped: ${refOf(branch, topic, slug)}`);
        }
      }
    }
    return entries.sort(compareEntries);
  };

  const fileOf = (commodoreId: string, ref: string) => {
    const { branch, topic, slug } = parseMemoryRef(ref);
    const root = rootFor(commodoreId);
    return { root, branch, topic, slug, file: path.join(root, branch, topic, `${slug}.md`) };
  };

  const find = (commodoreId: string, ref: string): MemoryEntry => {
    const { branch, topic, slug } = parseMemoryRef(ref);
    const found = list(commodoreId).find((entry) => entry.branch === branch && entry.topic === topic && entry.slug === slug);
    if (!found) throw new CommodoreStoreError("unknown_memory");
    return found;
  };

  /**
   * 쓰기 전에 기억 폴더·갈래·주제 자리 중 이미 있는 것이 링크면 거절한다 — mkdir 이 링크를 따라 밖에 디렉터리를 만들기 전에 막는다.
   * 만든 뒤에도 실경로 담김을 한 번 더 본다.
   */
  const prepareDir = (root: string, dirs: readonly string[]) => {
    for (const dir of [root, ...dirs]) {
      try { if (fs.lstatSync(dir).isSymbolicLink()) throw new CommodoreStoreError("invalid_ref"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    fs.mkdirSync(dirs.at(-1) ?? root, { recursive: true, mode: 0o700 });
    for (const dir of dirs) if (!contained(root, dir)) throw new CommodoreStoreError("invalid_ref");
  };

  /** 항목을 쓰고 인덱스를 다시 만든다. */
  const write = (commodoreId: string, entry: MemoryEntry) => {
    const { root, branch, topic, file } = fileOf(commodoreId, entry.ref);
    prepareDir(root, [path.join(root, branch), path.join(root, branch, topic)]);
    options.writeFile(file, serializeEntry(entry));
    rebuildIndex(commodoreId);
  };

  const rebuildIndex = (commodoreId: string) => {
    const root = rootFor(commodoreId);
    prepareDir(root, []);
    options.writeFile(path.join(root, INDEX_FILE), renderIndex(list(commodoreId)));
  };

  const checkText = (fields: readonly (string | undefined)[]) => {
    if (fields.some((field) => field !== undefined && looksSecret(field))) throw new CommodoreStoreError("memory_secret");
  };
  /** 항목 파일의 절 제목(`## `)과 같은 줄이 본문에 있으면 다시 읽을 때 절이 갈린다 — 쓰기 전에 거절한다. */
  const checkBody = (fields: readonly (string | undefined)[]) => {
    if (fields.some((field) => field !== undefined && BODY_HEADING.test(field))) throw new CommodoreStoreError("memory_heading");
  };

  const checkLinks = (commodoreId: string, self: string, links: readonly string[] | undefined): string[] | undefined => {
    if (links === undefined) return undefined;
    const normalized = [...new Set(links.map((link) => { const { branch, topic, slug } = parseMemoryRef(link); return refOf(branch, topic, slug); }))].filter((link) => link !== self);
    if (normalized.length > MAX_MEMORY_LINKS) throw new CommodoreStoreError("invalid_request");
    return normalized;
  };

  return {
    list,
    read: find,
    save(commodoreId, input) {
      const { branch, topic, slug } = parseMemoryRef(refOf(input.branch, input.topic, input.slug));
      const ref = refOf(branch, topic, slug);
      checkText([input.title, input.description, input.why, input.how, topic, slug, ...(input.links ?? []), ...(input.sources ?? []).map((source) => source.title)]);
      checkBody([input.why, input.how]);
      const existing = list(commodoreId);
      if (existing.some((entry) => entry.ref === ref)) throw new CommodoreStoreError("memory_exists");
      if (existing.length >= MAX_MEMORY_ENTRIES) throw new CommodoreStoreError("too_many_memories");
      const at = options.now();
      const entry: MemoryEntry = {
        ref, branch, topic, slug,
        title: input.title, description: input.description, why: input.why, how: input.how,
        sources: (input.sources ?? []).slice(0, MAX_MEMORY_SOURCES),
        links: checkLinks(commodoreId, ref, input.links) ?? [],
        created: at, updated: at, verified: at,
      };
      write(commodoreId, entry);
      options.onChange(commodoreId, "save", ref);
      return entry;
    },
    update(commodoreId, ref, patch) {
      const current = find(commodoreId, ref);
      checkText([patch.title, patch.description, patch.why, patch.how, ...(patch.links ?? []), ...(patch.sources ?? []).map((source) => source.title)]);
      checkBody([patch.why, patch.how]);
      const links = checkLinks(commodoreId, current.ref, patch.links);
      const changed = Object.values(patch).some((value) => value !== undefined);
      const at = options.now();
      const entry: MemoryEntry = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.why !== undefined ? { why: patch.why } : {}),
        ...(patch.how !== undefined ? { how: patch.how } : {}),
        ...(patch.sources !== undefined ? { sources: patch.sources.slice(0, MAX_MEMORY_SOURCES) } : {}),
        ...(links !== undefined ? { links } : {}),
        ...(changed ? { updated: at } : {}),
        verified: at,
      };
      write(commodoreId, entry);
      const change = changed ? "update" : "verify";
      options.onChange(commodoreId, change, current.ref);
      return { entry, change };
    },
    remove(commodoreId, ref) {
      const current = find(commodoreId, ref);
      const { root, file } = fileOf(commodoreId, current.ref);
      if (!contained(root, file)) throw new CommodoreStoreError("unknown_memory");
      fs.unlinkSync(file);
      // 빈 주제 디렉터리는 함께 걷는다 — 화면의 빈 주제가 남지 않게. 갈래 디렉터리는 고정이라 둔다.
      try { fs.rmdirSync(path.dirname(file)); } catch { /* 비어 있지 않으면 그대로 */ }
      rebuildIndex(commodoreId);
      options.onChange(commodoreId, "delete", current.ref);
    },
    index(commodoreId) {
      const file = path.join(rootFor(commodoreId), INDEX_FILE);
      try { return fs.readFileSync(file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    },
  };
}

function isRealDir(target: string): boolean {
  try { return fs.lstatSync(target).isDirectory(); } catch { return false; }
}

function isRealFile(target: string): boolean {
  try { return fs.lstatSync(target).isFile(); } catch { return false; }
}

function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
  const branch = MEMORY_BRANCHES.indexOf(a.branch) - MEMORY_BRANCHES.indexOf(b.branch);
  if (branch) return branch;
  return a.topic.localeCompare(b.topic) || a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug);
}

const FRONTMATTER_KEYS = ["title", "description", "sources", "links", "created", "updated", "verified"] as const;

/** frontmatter 값은 한 줄 JSON 이다 — 문자열·배열 모두 유효한 YAML 이기도 해 사람이 열어도 읽힌다. */
function serializeEntry(entry: MemoryEntry): string {
  const head = {
    title: entry.title,
    description: entry.description,
    sources: entry.sources.map((source) => ({ objectiveId: source.objectiveId, title: source.title })),
    links: entry.links,
    created: new Date(entry.created).toISOString(),
    updated: new Date(entry.updated).toISOString(),
    verified: new Date(entry.verified).toISOString(),
  };
  return [
    "---",
    ...FRONTMATTER_KEYS.map((key) => `${key}: ${JSON.stringify(head[key])}`),
    "---",
    "",
    "## Why",
    entry.why.trim(),
    "",
    "## How to apply",
    entry.how.trim(),
    "",
  ].join("\n");
}

const sourceSchema = z.object({ objectiveId: z.string().min(1).max(128), title: z.string().min(1).max(300) });
const headSchema = z.object({
  title: z.string().min(1).max(MAX_MEMORY_TITLE),
  description: z.string().min(1).max(MAX_MEMORY_DESCRIPTION),
  sources: z.array(sourceSchema).max(MAX_MEMORY_SOURCES).catch([]),
  links: z.array(z.string().max(160)).max(MAX_MEMORY_LINKS).catch([]),
  created: z.iso.datetime(),
  updated: z.iso.datetime(),
  verified: z.iso.datetime(),
});

function parseEntryFile(raw: string, branch: MemoryBranch, topic: string, slug: string): MemoryEntry | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replaceAll("\r\n", "\n"));
  if (!match) return null;
  const head: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+): (.*)$/.exec(line);
    if (!field) continue;
    try { head[field[1]!] = JSON.parse(field[2]!); } catch { return null; }
  }
  const parsed = headSchema.safeParse(head);
  if (!parsed.success) return null;
  const body = match[2]!;
  const why = section(body, "Why");
  const how = section(body, "How to apply");
  if (!why || !how) return null;
  return {
    ref: refOf(branch, topic, slug), branch, topic, slug,
    title: parsed.data.title, description: parsed.data.description, why, how,
    sources: parsed.data.sources,
    links: parsed.data.links.filter((link) => { try { parseMemoryRef(link); return true; } catch { return false; } }),
    created: Date.parse(parsed.data.created), updated: Date.parse(parsed.data.updated), verified: Date.parse(parsed.data.verified),
  };
}

function section(body: string, heading: string): string {
  const lines = body.split("\n");
  // 절 제목은 줄 맨 앞의 `## ` 뿐이다 — 쓰기 검사(BODY_HEADING)와 같은 기준이라, 본문의 들여쓴 `## ` 줄은 본문으로 남는다.
  const start = lines.findIndex((line) => line.trimEnd() === `## ${heading}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** MEMORY.md — 갈래·주제 머리 아래 한 줄씩. 사령관이 턴마다 받는 목록이자 사람이 폴더를 열었을 때의 입구다. */
function renderIndex(entries: readonly MemoryEntry[]): string {
  if (!entries.length) return "";
  const lines: string[] = ["# fleet-memory", ""];
  for (const branch of MEMORY_BRANCHES) {
    const inBranch = entries.filter((entry) => entry.branch === branch);
    if (!inBranch.length) continue;
    lines.push(`## ${branch}`);
    for (const topic of [...new Set(inBranch.map((entry) => entry.topic))]) {
      lines.push(`### ${topic}`);
      for (const entry of inBranch.filter((item) => item.topic === topic)) {
        lines.push(`- [${entry.title.replaceAll("]", ")")}](${entry.branch}/${encodeURI(entry.topic)}/${entry.slug}.md) — ${entry.description} (verified ${new Date(entry.verified).toISOString().slice(0, 10)})`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
