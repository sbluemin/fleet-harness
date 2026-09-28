import crypto from "node:crypto";
import fs from "node:fs";

import { sanitizeAccessLabel, type ValidatedAccessLink } from "./access-link.js";
import { createRemoteStorage, type RemoteStorageDeps } from "./remote-storage.js";

/**
 * 이 콘솔에서 건너갈 수 있는 다른 콘솔들. 사용자가 액세스 링크를 붙여넣으면 여기에 남고,
 * 이후로는 링크 없이 이름으로 고른다.
 *
 * 자격은 절대 저장하지 않는다. 링크의 토큰은 1회용이라 한 번 쓰면 사라지고, 그 다음부터는
 * 브라우저(또는 Desktop 세션)가 들고 있는 세션 쿠키가 유일한 통행증이다. 여기에 남는 것은
 * "어디로, 어떤 인증서를 믿고 가는가" 뿐이다 — 이 파일이 새어도 남의 콘솔에 들어갈 수는 없다.
 */
export interface RemoteHostRecord {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  /** 인증서 핀의 키. 대괄호 없는 소문자 호스트명. */
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly addedAt: number;
  readonly lastOpenedAt: number | null;
}

/** 방금 붙여넣은 링크의 1회용 자격. 디스크에 닿지 않고, 한 번 꺼내면 사라진다. */
export interface RemoteHostHandoff {
  readonly host: RemoteHostRecord;
  readonly token: string | null;
}

export interface RemoteHostStore {
  list(): readonly RemoteHostRecord[];
  find(id: string): RemoteHostRecord | null;
  findByOrigin(origin: string): RemoteHostRecord | null;
  /** 링크를 호스트로 바꾼다. 같은 origin이 이미 있으면 지문과 이름을 갱신한다. */
  remember(link: ValidatedAccessLink): RemoteHostRecord;
  rename(id: string, label: string): RemoteHostRecord | null;
  forget(id: string): boolean;
  /** 넘겨줄 것을 한 번에 꺼낸다 — 토큰은 이 호출로 소진된다. */
  takeHandoff(origin: string): RemoteHostHandoff | null;
}

export interface RemoteHostStoreDeps extends RemoteStorageDeps {
  readonly readFile?: (file: string) => string;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

/** SSH의 known_hosts와 같은 뜻이다 — 이 콘솔이 아는 상대와, 그 상대에게 기대하는 신원. */
const HOSTS_FILE = "known-hosts.json";
const STORE_VERSION = 1;
const MAX_HOSTS = 64;
/** 붙여넣은 링크를 실제로 여는 데 걸리는 시간. 그 창을 넘기면 토큰은 버려진다. */
const HANDOFF_TTL_MS = 5 * 60 * 1000;

interface StoredFile {
  readonly version: number;
  readonly hosts: readonly RemoteHostRecord[];
}

export function createRemoteHostStore(consoleDir: string, deps: RemoteHostStoreDeps = {}): RemoteHostStore {
  const storage = createRemoteStorage(consoleDir, deps);
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  const pending = new Map<string, { readonly token: string; readonly expiresAt: number }>();
  let hosts: RemoteHostRecord[] = read();

  function read(): RemoteHostRecord[] {
    try {
      const parsed = JSON.parse(readFile(storage.path(HOSTS_FILE))) as StoredFile;
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.hosts)) return [];
      return parsed.hosts.filter(isRecord).slice(0, MAX_HOSTS);
    } catch {
      return [];
    }
  }

  function write(): void {
    const body: StoredFile = { version: STORE_VERSION, hosts };
    storage.write(HOSTS_FILE, `${JSON.stringify(body, null, 2)}\n`);
  }

  return {
    list: () => hosts,
    find: (id) => hosts.find((entry) => entry.id === id) ?? null,
    findByOrigin: (origin) => hosts.find((entry) => entry.origin === origin) ?? null,

    remember(link) {
      const existing = hosts.find((entry) => entry.origin === link.origin);
      const record: RemoteHostRecord = {
        id: existing?.id ?? randomId(),
        // 이름은 사용자가 고쳐 부를 수 있으므로, 이미 고쳐 부른 이름을 링크가 덮어쓰지 않는다.
        label: existing?.label ?? link.label,
        origin: link.origin,
        hostname: link.hostname,
        port: link.port,
        // 지문은 링크가 항상 이긴다 — 서버가 신원을 교체했다면 새 링크가 그 사실을 나른다.
        fingerprint: link.fingerprint,
        addedAt: existing?.addedAt ?? now(),
        lastOpenedAt: existing?.lastOpenedAt ?? null,
      };
      hosts = [record, ...hosts.filter((entry) => entry.origin !== link.origin)].slice(0, MAX_HOSTS);
      pending.set(record.origin, { token: link.token, expiresAt: now() + HANDOFF_TTL_MS });
      write();
      return record;
    },

    rename(id, label) {
      const cleaned = sanitizeAccessLabel(label);
      const target = hosts.find((entry) => entry.id === id);
      if (!target || cleaned.length === 0) return null;
      const renamed: RemoteHostRecord = { ...target, label: cleaned };
      hosts = hosts.map((entry) => (entry.id === id ? renamed : entry));
      write();
      return renamed;
    },

    forget(id) {
      const target = hosts.find((entry) => entry.id === id);
      if (!target) return false;
      hosts = hosts.filter((entry) => entry.id !== id);
      pending.delete(target.origin);
      write();
      return true;
    },

    takeHandoff(origin) {
      const host = hosts.find((entry) => entry.origin === origin);
      if (!host) return null;
      const waiting = pending.get(origin);
      pending.delete(origin);
      const fresh = waiting && waiting.expiresAt > now() ? waiting.token : null;
      const opened: RemoteHostRecord = { ...host, lastOpenedAt: now() };
      hosts = hosts.map((entry) => (entry.id === host.id ? opened : entry));
      write();
      return { host: opened, token: fresh };
    },
  };
}

function isRecord(value: unknown): value is RemoteHostRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.label === "string"
    && typeof entry.origin === "string" && entry.origin.startsWith("https://")
    && typeof entry.hostname === "string" && entry.hostname.length > 0
    && typeof entry.port === "number" && Number.isSafeInteger(entry.port)
    && typeof entry.fingerprint === "string" && /^[0-9A-F]{64}$/u.test(entry.fingerprint)
    && typeof entry.addedAt === "number"
    && (entry.lastOpenedAt === null || typeof entry.lastOpenedAt === "number");
}
