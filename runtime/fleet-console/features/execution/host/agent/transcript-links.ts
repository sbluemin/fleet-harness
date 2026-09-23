import { promises as fs } from "node:fs";

/**
 * 이 Operation의 transcript에 실제로 적힌 http(s) 주소들 — 터미널이 줄바꿈으로 가른 URL을 잇기 전에
 * 맞춰 볼 원문이다.
 *
 * Claude Code는 긴 URL을 터미널 폭에 맞춰 직접 줄을 바꿔 그린다(자동 줄바꿈 표시가 없다). 그래서
 * 화면만 보고는 어디까지가 한 주소인지 알 수 없고, 추측으로 이으면 엉뚱한 주소를 열 수 있다.
 * 클라이언트가 화면에서 이어 붙인 글을 보내면, 그 글 안에 들어 있는 원문 주소만 돌려준다
 * ({@link selectLinksIn}) — transcript의 내용은 호스트 밖으로 나가지 않는다.
 *
 * 꼬리만 읽는다: 화면에 남아 있는 주소는 최근 기록이고, 거대한 transcript 전체를 매 호버마다 읽지 않는다.
 * 사이드체인(서브에이전트) 기록은 본 화면에 그려지지 않으므로 뺀다.
 */
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_URLS = 500;
const MAX_URL_CHARS = 8192;
/** 클라이언트가 한 번에 보낼 수 있는 화면 글의 상한 — 이어 따라가는 줄 수와 넓은 터미널을 넉넉히 덮는다. */
export const MAX_LINK_TEXT_CHARS = 64 * 1024;
// 따옴표·꺾쇠·백틱·역슬래시·공백은 주소 안에 그대로 올 수 없다 — 마크다운·코드 조각의 경계로 본다.
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\\u0000-\u001f\u007f]+/g;
// 문장·강조의 끝에 붙은 문자는 주소가 아니다. 괄호는 짝이 맞지 않을 때만 뗀다(위키 주소 등 보존).
const TRAILING_PUNCTUATION = /[.,;:!?*_~]+$/;
// 화면에 그려지지 않는 이진·서명 필드는 건너뛴다.
const SKIPPED_KEYS = new Set(["signature", "data", "source"]);

/** 화면 글 안에 그대로 들어 있는 원문 주소만 고른다. */
export function selectLinksIn(text: string, urls: readonly string[]): readonly string[] {
  return urls.filter((url) => text.includes(url));
}

/** 같은 파일을 크기·수정 시각이 바뀔 때만 다시 읽는다. 세션마다 한 파일이므로 최근 몇 개만 둔다. */
export function createTranscriptLinkReader(maxFiles = 16): { readonly read: (file: string) => Promise<readonly string[]> } {
  const cache = new Map<string, { readonly key: string; readonly urls: readonly string[] }>();
  return {
    async read(file) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) return [];
      const key = `${stat.size}:${stat.mtimeMs}`;
      const hit = cache.get(file);
      if (hit?.key === key) return hit.urls;
      const urls = await readTranscriptLinks(file);
      cache.delete(file);
      cache.set(file, { key, urls });
      while (cache.size > maxFiles) cache.delete(cache.keys().next().value!);
      return urls;
    },
  };
}

export async function readTranscriptLinks(file: string): Promise<readonly string[]> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return [];
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return [];
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    // 꼬리의 첫 줄은 중간에서 잘렸을 수 있다 — 반쪽 JSON은 버린다.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return extractTranscriptLinks(text);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** JSONL 본문에서 주소를 뽑는다. 최근 것이 뒤에 오며, 같은 주소는 마지막 한 번만 남는다. */
export function extractTranscriptLinks(jsonl: string): readonly string[] {
  const found = new Map<string, true>();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.includes("http")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.isSidechain === true) continue;
    const message = record.message;
    if (!isRecord(message)) continue;
    collectStrings(message.content, (value) => {
      for (const match of value.matchAll(URL_PATTERN)) {
        const url = trimUrl(match[0]);
        if (url.length < 10 || url.length > MAX_URL_CHARS) continue;
        found.delete(url);
        found.set(url, true);
      }
    });
  }
  const urls = [...found.keys()];
  return urls.length > MAX_URLS ? urls.slice(-MAX_URLS) : urls;
}

function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const next = url.replace(TRAILING_PUNCTUATION, "");
    const closer = next.at(-1);
    const opener = closer === ")" ? "(" : closer === "]" ? "[" : closer === "}" ? "{" : null;
    if (opener && count(next, closer!) > count(next, opener)) {
      url = next.slice(0, -1);
      continue;
    }
    if (next === url) return url;
    url = next;
  }
}

function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) if (c === char) total += 1;
  return total;
}

function collectStrings(value: unknown, visit: (text: string) => void, depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (value.includes("http")) visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, visit, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SKIPPED_KEYS.has(key)) continue;
    collectStrings(item, visit, depth + 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
