import { createHash } from "node:crypto";
import { BROWSER_HISTORY_MAX_BYTES, BROWSER_HISTORY_MAX_ENTRIES, DESKTOP_BROWSER_HISTORY, type BrowserHistoryVisit } from "@fleet-console/protocol/desktop/browser-history";
import type { CdpClient } from "./cdp.js";

interface HistoryEntry extends BrowserHistoryVisit { readonly iconUrl: string | null }
interface Icon { readonly body: string; readonly type: string }
interface Snapshot { version: 1; entries: HistoryEntry[]; icons: Record<string, Icon> }
interface CachedProfile { readonly snapshot: Snapshot; readonly revision: string; readonly serialized: string | null }
export interface HistoryScope { readonly owner: string; readonly profile: string | null; readonly current: () => boolean }
export interface HistorySuggestion { readonly id: string; readonly url: string; readonly title: string }
const empty = (): Snapshot => ({ version: 1, entries: [], icons: {} });
const idOf = (url: string) => createHash("sha256").update(url).digest("hex");
const webUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const url = new URL(value); return /^(https?:)$/u.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
};
const validIcon = (value: unknown): value is Icon => {
  const icon = value as Icon | null;
  return Boolean(icon && typeof icon.body === "string" && icon.body.length <= 48 * 1024 && typeof icon.type === "string" && /^image\/[a-z0-9.+-]+$/u.test(icon.type));
};
function visit(input: BrowserHistoryVisit, iconUrl: string | null = null): HistoryEntry | null {
  const url = webUrl(input.url);
  if (!url || typeof input.title !== "string" || !Number.isFinite(input.lastVisited) || !Number.isFinite(input.visits)) return null;
  return { url, title: input.title.slice(0, 512), visits: Math.max(1, Math.min(1e9, input.visits)), lastVisited: Math.max(0, Math.min(Date.now(), input.lastVisited)), iconUrl: webUrl(iconUrl) };
}
function decode(data: string | null): Snapshot {
  if (data === null) return empty();
  const value = JSON.parse(data) as Snapshot;
  if (value.version !== 1 || !Array.isArray(value.entries) || !value.icons || typeof value.icons !== "object") throw new Error("browser_history_invalid");
  return { version: 1, entries: value.entries.slice(0, BROWSER_HISTORY_MAX_ENTRIES).flatMap((entry) => { const valid = visit(entry, entry.iconUrl); return valid ? [valid] : []; }), icons: Object.fromEntries(Object.entries(value.icons).filter(([key, icon]) => /^[a-f0-9]{64}$/u.test(key) && validIcon(icon)).slice(-32)) };
}
/** 이력의 예산을 먼저 확보한다. 작은 아이콘도 남은 공간에만 넣어 방문 항목을 밀어내지 않는다. */
function serialize(data: Snapshot): string {
  data.entries.sort((a, b) => b.lastVisited - a.lastVisited);
  let bytes = Buffer.byteLength(JSON.stringify(empty()));
  let count = 0;
  for (const entry of data.entries.slice(0, BROWSER_HISTORY_MAX_ENTRIES)) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > BROWSER_HISTORY_MAX_BYTES) break;
    count += 1;
  }
  data.entries = data.entries.slice(0, count);
  bytes = Buffer.byteLength(JSON.stringify({ ...data, icons: {} }));
  const icons: Record<string, Icon> = {};
  for (const [key, icon] of Object.entries(data.icons).slice(-32)) {
    if (!validIcon(icon) || Buffer.from(icon.body, "base64").byteLength > 32 * 1024) continue;
    const size = Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(icon)) + 2;
    if (bytes + size > BROWSER_HISTORY_MAX_BYTES) continue;
    icons[key] = icon;
    bytes += size;
  }
  data.icons = icons;
  return JSON.stringify(data);
}

/** 제품 정책은 Console에 둔다. 영속 snapshot IO만 창을 든 Desktop에 요청한다. */
export class BrowserHistory {
  private readonly ephemeral = new Map<string, Snapshot>();
  private readonly profiles = new Map<string, CachedProfile>();
  private readonly icons = new Map<string, { profile: string | null; entries: Map<string, { icon: Icon; at: number }> }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: () => Promise<CdpClient>) {}

  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  forget(owner: string): void { this.ephemeral.delete(owner); this.icons.delete(owner); }
  forgetProfile(profile: string): void {
    this.profiles.delete(profile);
    for (const [owner, cache] of this.icons) if (cache.profile === profile) this.icons.delete(owner);
  }
  forgetAll(): void { this.ephemeral.clear(); this.profiles.clear(); this.icons.clear(); }
  private access<T>(scope: HistoryScope, write: boolean, run: (data: Snapshot) => T): Promise<T | null> {
    return this.exclusive(async () => {
      if (!scope.current()) return null;
      const client = scope.profile ? await this.client() : null;
      // 제어 중인 이 Console이 유일한 writer라고 가정한다. revision 충돌이면 캐시를 버리고 한 번 다시 읽어 병합한다.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!scope.current()) return null;
        let stored = scope.profile ? this.profiles.get(scope.profile) : undefined;
        if (client && scope.profile && !stored) {
          const read = await client.send<{ data: string | null; revision: string }>(DESKTOP_BROWSER_HISTORY, { action: "read", browserProfile: scope.profile });
          if (!scope.current()) return null;
          stored = { snapshot: decode(read.data), serialized: read.data, revision: read.revision };
          this.profiles.set(scope.profile, stored);
        }
        const snapshot = stored?.snapshot ?? this.ephemeral.get(scope.owner) ?? empty();
        const data = write ? { ...snapshot, entries: [...snapshot.entries], icons: { ...snapshot.icons } } : snapshot;
        const result = run(data);
        if (!write || !scope.current()) return result;
        const serialized = serialize(data);
        if (stored && serialized === stored.serialized) return result;
        if (client && scope.profile && stored) {
          try {
            const written = await client.send<{ revision: string }>(DESKTOP_BROWSER_HISTORY, { action: "write", browserProfile: scope.profile, revision: stored.revision, data: serialized });
            if (scope.current()) this.profiles.set(scope.profile, { snapshot: data, revision: written.revision, serialized });
          } catch (error) {
            this.profiles.delete(scope.profile);
            if (attempt === 0 && error instanceof Error && /(?:^|: )browser_history_changed$/u.test(error.message)) continue;
            throw error;
          }
        } else this.ephemeral.set(scope.owner, data);
        return result;
      }
      return null;
    });
  }
  async record(scope: HistoryScope, entries: readonly BrowserHistoryVisit[], options: { imported?: boolean; iconUrl?: string | null; increment?: boolean } = {}): Promise<number> {
    return await this.access(scope, true, (data) => {
      const byUrl = new Map(data.entries.map((entry) => [entry.url, entry]));
      let count = 0;
      for (const input of entries.slice(0, BROWSER_HISTORY_MAX_ENTRIES)) {
        const item = visit(input, options.iconUrl ?? null);
        if (!item) continue;
        const old = byUrl.get(item.url);
        byUrl.set(item.url, { ...item, title: item.title || old?.title || "", iconUrl: item.iconUrl ?? old?.iconUrl ?? null, visits: options.imported ? Math.max(item.visits, old?.visits ?? 0) : (old?.visits ?? 0) + (options.increment === false && old ? 0 : 1), lastVisited: !options.imported && options.increment === false && old ? old.lastVisited : Math.max(item.lastVisited, old?.lastVisited ?? 0) });
        count += 1;
      }
      data.entries = [...byUrl.values()];
      return count;
    }) ?? 0;
  }
  async suggest(scope: HistoryScope, query: string): Promise<HistorySuggestion[]> {
    const terms = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/u);
    if (!query.trim() || query.length > 2048) return [];
    return await this.access(scope, false, (data) => {
      const now = Date.now();
      const score = (entry: HistoryEntry) => Math.log2(1 + entry.visits) + 10 / (1 + Math.max(0, now - entry.lastVisited) / 86400000);
      return data.entries.filter((entry) => { const haystack = `${entry.url} ${entry.title}`.normalize("NFKC").toLocaleLowerCase(); return terms.every((term) => haystack.includes(term)); })
        .sort((a, b) => score(b) - score(a) || b.lastVisited - a.lastVisited).slice(0, 5)
        .map((entry) => ({ id: idOf(entry.url), url: entry.url, title: entry.title }));
    }) ?? [];
  }
  /** 탭의 선언 아이콘은 이력 저장의 성공 여부와 무관하다. 큰 아이콘은 이 세션의 메모리에만 둔다. */
  async faviconForUrl(scope: HistoryScope, url: string, iconUrl: string): Promise<{ body: Buffer; type: string } | null> {
    if (!webUrl(iconUrl)) return null;
    const snapshot = scope.profile ? this.profiles.get(scope.profile)?.snapshot : this.ephemeral.get(scope.owner);
    return this.loadIcon(scope, iconUrl, snapshot?.icons[idOf(iconUrl)] ?? null, idOf(url), Boolean(snapshot));
  }
  async favicon(scope: HistoryScope, id: string): Promise<{ body: Buffer; type: string } | null> {
    const found = await this.access(scope, false, (data) => {
      const entry = data.entries.find((item) => idOf(item.url) === id);
      if (!entry) return null;
      const url = entry.iconUrl ?? new URL("/favicon.ico", entry.url).href;
      return { url, cached: data.icons[idOf(url)] };
    });
    return found ? this.loadIcon(scope, found.url, found.cached ?? null, id) : null;
  }
  private async loadIcon(scope: HistoryScope, url: string, cached: Icon | null, pageId: string, persist = true): Promise<{ body: Buffer; type: string } | null> {
    if (!scope.current()) return null;
    const memory = this.icons.get(scope.owner)?.entries.get(url);
    const icon = cached ?? (memory && Date.now() - memory.at < 60 * 60 * 1000 ? memory.icon : null) ?? await fetchIcon(url);
    if (!icon || !scope.current()) return null;
    let cache = this.icons.get(scope.owner);
    if (!cache) { cache = { profile: scope.profile, entries: new Map() }; this.icons.set(scope.owner, cache); }
    cache.entries.set(url, { icon, at: Date.now() });
    if (cache.entries.size > 32) cache.entries.delete(cache.entries.keys().next().value!);
    const body = Buffer.from(icon.body, "base64");
    if (persist && !cached && body.byteLength <= 32 * 1024) await this.access(scope, true, (data) => {
      if (!data.entries.some((entry) => idOf(entry.url) === pageId)) return;
      data.icons[idOf(url)] = icon;
    }).catch(() => undefined); // 이력 파일 오류가 이미 받은 탭 아이콘까지 없애지는 않는다.
    return scope.current() ? { body, type: icon.type } : null;
  }
}

/** 렌더러에는 같은 origin의 바이트만 준다. 응답을 다 읽기 전에 기존 탭 상한을 검사한다. */
async function fetchIcon(url: string): Promise<Icon | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "follow", credentials: "omit" });
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!response.ok || !/^image\/[a-z0-9.+-]+$/u.test(type) || !response.body) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) return null;
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return size ? { body: Buffer.concat(chunks).toString("base64"), type } : null;
  } catch { return null; }
}
