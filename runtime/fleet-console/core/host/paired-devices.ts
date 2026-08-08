import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AccessAudience, AccessClass } from "./auth.js";

/**
 * 액세스 링크가 만든 페어링. 링크 자체는 여전히 1회용이지만, 그 교환으로 생긴 이 기록은
 * 회수할 때까지 남는다 — 그래서 한 번 붙은 기기는 링크 없이 다시 붙는다.
 *
 * 이것이 세션과 갈라지는 지점이 이 파일의 존재 이유다. 세션은 "지금 붙어 있는가"이고
 * 페어링은 "붙어도 되는가"이다. 둘을 하나로 두면 제어권 회수·유휴 만료·콘솔 재시작이
 * 전부 자격까지 지워 버려, 상대는 새 링크를 받기 전에는 돌아올 수 없다.
 *
 * 비밀값은 저장하지 않는다. 남는 것은 해시뿐이라 이 파일이 새어도 그것으로 붙을 수 없다.
 */
export interface PairedDevice {
  /** 목록에 실리고 회수가 가리키는 공개 이름. 쿠키에 담기는 비밀값과 다르다. */
  readonly id: string;
  readonly audience: AccessAudience;
  readonly access: AccessClass;
  /** 페어링할 때 기기가 스스로 밝힌 이름. 목록에서 사람이 자기 기기를 알아보는 단서다. */
  readonly device: string | null;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
}

export interface PairedDeviceGrant {
  readonly device: PairedDevice;
  /** 발급 시점에만 존재한다. 저장되지 않으므로 이 값을 놓치면 다시 받을 수 없다. */
  readonly secret: string;
}

export interface PairedDeviceStore {
  list(audience: AccessAudience): readonly PairedDevice[];
  find(id: string): PairedDevice | null;
  /** 새 페어링과 그 비밀값. 상한에 닿으면 null을 돌려주고 조용히 밀어내지 않는다. */
  pair(input: { readonly audience: AccessAudience; readonly access: AccessClass; readonly device: string | null }): PairedDeviceGrant | null;
  /** 비밀값을 그 페어링으로 되돌린다. audience가 다르면 없는 것으로 본다. */
  resolve(secret: string | null, audience: AccessAudience): PairedDevice | null;
  revoke(id: string): PairedDevice | null;
  /** 이 audience의 페어링을 전부 걷어낸다. 인증서 신원이 바뀌면 어차피 붙을 수 없다. */
  revokeAll(audience: AccessAudience): readonly PairedDevice[];
}

export interface PairedDeviceStoreDeps {
  readonly fileSystem?: Pick<typeof fs, "mkdirSync" | "readFileSync" | "renameSync" | "writeFileSync">;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly randomSecret?: () => string;
}

const DEVICES_FILE = "paired-devices.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const STORE_VERSION = 1;
/** 한 콘솔이 기억하는 페어링 수. 상한에 닿으면 조용히 밀어내지 않고 거절한다. */
export const PAIRED_DEVICE_LIMIT = 64;
const MAX_DEVICES = PAIRED_DEVICE_LIMIT;
/**
 * `lastSeenAt`은 붙을 때마다 움직이지만 그 정확도는 목록에 "몇 분 전"을 그리는 수준이면
 * 충분하다. 매번 디스크에 내려쓰면 재접속이 잦은 기기가 파일을 계속 다시 쓰게 된다.
 */
const LAST_SEEN_FLUSH_MS = 60_000;

interface StoredDevice extends PairedDevice {
  readonly secretHash: string;
}

interface StoredFile {
  readonly version: number;
  readonly devices: readonly StoredDevice[];
}

export function hashPairingSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createPairedDeviceStore(consoleDir: string, deps: PairedDeviceStoreDeps = {}): PairedDeviceStore {
  const fileSystem = deps.fileSystem ?? fs;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomBytes(8).toString("hex"));
  const randomSecret = deps.randomSecret ?? (() => crypto.randomBytes(32).toString("base64url"));
  const file = path.join(consoleDir, DEVICES_FILE);
  let devices: StoredDevice[] = read();
  let flushedAt = now();

  function read(): StoredDevice[] {
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(file, "utf8")) as StoredFile;
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.devices)) return [];
      return parsed.devices.filter(isStoredDevice).slice(0, MAX_DEVICES);
    } catch {
      return [];
    }
  }

  function write(): void {
    const body: StoredFile = { version: STORE_VERSION, devices };
    const temporary = `${file}.tmp`;
    fileSystem.mkdirSync(consoleDir, { recursive: true, mode: DIR_MODE });
    fileSystem.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
    fileSystem.renameSync(temporary, file);
    flushedAt = now();
  }

  function publish(entry: StoredDevice): PairedDevice {
    const { secretHash: _secretHash, ...rest } = entry;
    return rest;
  }

  return {
    list: (audience) => devices.filter((entry) => entry.audience === audience).map(publish).sort((left, right) => right.pairedAt - left.pairedAt),

    find(id) {
      const found = devices.find((entry) => entry.id === id);
      return found ? publish(found) : null;
    },

    pair(input) {
      if (devices.length >= MAX_DEVICES) return null;
      const secret = randomSecret();
      const paired = now();
      const entry: StoredDevice = {
        id: randomId(),
        secretHash: hashPairingSecret(secret),
        audience: input.audience,
        access: input.access,
        device: input.device,
        pairedAt: paired,
        lastSeenAt: paired,
      };
      devices = [entry, ...devices];
      write();
      return { device: publish(entry), secret };
    },

    resolve(secret, audience) {
      if (!secret) return null;
      const hash = hashPairingSecret(secret);
      const index = devices.findIndex((entry) => entry.secretHash === hash);
      if (index === -1) return null;
      const entry = devices[index]!;
      // audience가 어긋나면 없는 것으로 본다 — 루프백에서 얻은 쿠키가 원격 리스너를 열 수 없다.
      if (entry.audience !== audience) return null;
      const seen = now();
      const refreshed: StoredDevice = { ...entry, lastSeenAt: seen };
      devices = devices.map((candidate, position) => (position === index ? refreshed : candidate));
      // 갱신 실패가 접속을 막을 이유는 없다. 사실은 메모리에 이미 반영되어 있다.
      if (seen - flushedAt >= LAST_SEEN_FLUSH_MS) {
        try {
          write();
        } catch {
          flushedAt = seen;
        }
      }
      return publish(refreshed);
    },

    revoke(id) {
      const target = devices.find((entry) => entry.id === id);
      if (!target) return null;
      devices = devices.filter((entry) => entry.id !== id);
      write();
      return publish(target);
    },

    revokeAll(audience) {
      const removed = devices.filter((entry) => entry.audience === audience);
      if (removed.length === 0) return [];
      devices = devices.filter((entry) => entry.audience !== audience);
      write();
      return removed.map(publish);
    },
  };
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.secretHash === "string" && /^[0-9a-f]{64}$/u.test(entry.secretHash)
    && (entry.audience === "local" || entry.audience === "remote")
    && (entry.access === "full" || entry.access === "monitoring")
    && (entry.device === null || typeof entry.device === "string")
    && typeof entry.pairedAt === "number" && Number.isFinite(entry.pairedAt)
    && typeof entry.lastSeenAt === "number" && Number.isFinite(entry.lastSeenAt);
}
