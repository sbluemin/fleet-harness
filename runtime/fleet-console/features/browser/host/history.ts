import { createHash } from "node:crypto";
import { BROWSER_HISTORY_MAX_BYTES, BROWSER_HISTORY_MAX_ENTRIES, DESKTOP_BROWSER_HISTORY, type BrowserHistoryVisit } from "@fleet-console/protocol/desktop/browser-history";
import type { CdpClient } from "./cdp.js";

interface HistoryEntry extends BrowserHistoryVisit { readonly iconUrl: string | null }
interface Icon { readonly body: string; readonly type: string }
interface Snapshot { version: 1; entries: HistoryEntry[]; icons: Record<string, Icon> }
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
  return Boolean(icon && typeof icon.body === "string" && icon.body.length <= 48 * 1024 && typeof icon.type === "string" && /^image\/(png|jpeg|gif|webp|x-icon|vnd.microsoft.icon|svg\+xml)$/u.test(icon.type));
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

/** 제품 정책은 Console에 둔다. 영속 snapshot IO만 창을 든 Desktop에 요청한다. */
export class BrowserHistory {
  private readonly ephemeral = new Map<string, Snapshot>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: () => Promise<CdpClient>) {}

  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  forget(owner: string): void { this.ephemeral.delete(owner); }
  forgetAll(): void { this.ephemeral.clear(); }
  private access<T>(scope: HistoryScope, write: boolean, run: (data: Snapshot) => T): Promise<T | null> {
    return this.exclusive(async () => {
      if (!scope.current()) return null;
      const client = scope.profile ? await this.client() : null;
      const stored = client ? await client.send<{ data: string | null; revision: string }>(DESKTOP_BROWSER_HISTORY, { action: "read", browserProfile: scope.profile }) : null;
      if (!scope.current()) return null;
      const data = stored ? decode(stored.data) : this.ephemeral.get(scope.owner) ?? empty();
      const result = run(data);
      if (write && scope.current()) {
        data.entries.sort((a, b) => b.lastVisited - a.lastVisited);
        data.entries = data.entries.slice(0, BROWSER_HISTORY_MAX_ENTRIES);
        // UTF-8 상한은 전송·파일 양쪽에서 지킨다. 오래된 항목부터 내려놓는다.
        let bytes = Buffer.byteLength(JSON.stringify({ ...data, entries: [] }));
        let count = 0;
        for (const entry of data.entries) {
          bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (bytes > BROWSER_HISTORY_MAX_BYTES) break;
          count += 1;
        }
        data.entries = data.entries.slice(0, count);
        const serialized = JSON.stringify(data);
        if (client) await client.send(DESKTOP_BROWSER_HISTORY, { action: "write", browserProfile: scope.profile, revision: stored!.revision, data: serialized });
        else this.ephemeral.set(scope.owner, data);
      }
      return result;
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
        byUrl.set(item.url, { ...item, title: item.title || old?.title || "", iconUrl: item.iconUrl ?? old?.iconUrl ?? null, visits: options.imported ? Math.max(item.visits, old?.visits ?? 0) : (old?.visits ?? 0) + (options.increment === false && old ? 0 : 1), lastVisited: Math.max(item.lastVisited, old?.lastVisited ?? 0) });
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
  faviconForUrl(scope: HistoryScope, url: string): Promise<{ body: Buffer; type: string } | null> {
    return this.favicon(scope, idOf(url));
  }
  async favicon(scope: HistoryScope, id: string): Promise<{ body: Buffer; type: string } | null> {
    const found = await this.access(scope, false, (data) => {
      const entry = data.entries.find((item) => idOf(item.url) === id);
      if (!entry) return null;
      const url = entry.iconUrl ?? new URL("/favicon.ico", entry.url).href;
      return { url, cached: data.icons[idOf(url)] };
    });
    if (!found || !scope.current()) return null;
    let icon = found.cached ?? null;
    if (!icon) {
      icon = await fetchIcon(found.url);
      if (icon && scope.current()) await this.access(scope, true, (data) => {
        if (!data.entries.some((entry) => idOf(entry.url) === id)) return;
        data.icons[idOf(found.url)] = icon!;
        const keys = Object.keys(data.icons);
        for (const key of keys.slice(0, Math.max(0, keys.length - 32))) delete data.icons[key];
      });
    }
    return icon && scope.current() ? { body: Buffer.from(icon.body, "base64"), type: icon.type } : null;
  }
}

/** 렌더러에는 같은 origin의 바이트만 준다. 응답을 다 읽기 전에 상한을 검사한다. */
async function fetchIcon(url: string): Promise<Icon | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "follow", credentials: "omit" });
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!response.ok || !validIcon({ body: "", type }) || !response.body) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32 * 1024) return null;
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return size ? { body: Buffer.concat(chunks).toString("base64"), type } : null;
  } catch { return null; }
}
