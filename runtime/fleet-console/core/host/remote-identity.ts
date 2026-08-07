import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import selfsigned from "selfsigned";

/**
 * 원격 리스너의 신원. 액세스 링크가 이 지문을 함께 실어 나르고, Desktop이 접속 직전
 * 제시된 인증서와 대조한다. 지문이 어긋나면 토큰은 전송되지 않으므로 중간자가 가로챌
 * 것이 없다 — 링크가 주소·자격·신원을 함께 나르는 이유다.
 */
export interface RemoteIdentity {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** 인증서 DER의 SHA-256, 대문자 16진수 콜론 구분. */
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RemoteIdentityStoreDeps {
  readonly fileSystem?: Pick<typeof fs, "existsSync" | "mkdirSync" | "readFileSync" | "writeFileSync" | "renameSync" | "rmSync">;
  readonly generate?: (host: string) => Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }>;
  readonly now?: () => number;
}

export interface RemoteIdentityStore {
  /** 저장된 신원을 읽고, 없거나 만료됐거나 host가 달라졌으면 새로 만든다. */
  ensure(host: string): Promise<RemoteIdentity>;
  read(): RemoteIdentity | null;
  /** 신원을 새로 만든다. 기존 링크와 세션은 모두 무효가 된다. */
  rotate(host: string): Promise<RemoteIdentity>;
}

const IDENTITY_DIR = "remote";
const CERTIFICATE_FILE = "identity-cert.pem";
const KEY_FILE = "identity-key.pem";
const META_FILE = "identity.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const VALIDITY_DAYS = 825;
// 만료 직전에 새로 만들지 않으면 원격 접속이 어느 날 갑자기 끊긴다.
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredMeta {
  readonly host: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export function createRemoteIdentityStore(consoleDir: string, deps: RemoteIdentityStoreDeps = {}): RemoteIdentityStore {
  const fileSystem = deps.fileSystem ?? fs;
  const generate = deps.generate ?? generateSelfSignedCertificate;
  const now = deps.now ?? Date.now;
  const directory = path.join(consoleDir, IDENTITY_DIR);

  function read(): RemoteIdentity | null {
    try {
      const meta = JSON.parse(fileSystem.readFileSync(path.join(directory, META_FILE), "utf8")) as StoredMeta;
      const certificatePem = fileSystem.readFileSync(path.join(directory, CERTIFICATE_FILE), "utf8");
      const privateKeyPem = fileSystem.readFileSync(path.join(directory, KEY_FILE), "utf8");
      if (typeof meta?.host !== "string" || typeof meta.expiresAt !== "number") return null;
      return { certificatePem, privateKeyPem, fingerprint: fingerprintOf(certificatePem), createdAt: meta.createdAt, expiresAt: meta.expiresAt };
    } catch {
      return null;
    }
  }

  async function ensure(host: string): Promise<RemoteIdentity> {
    const stored = read();
    const meta = readMeta();
    const usable = stored !== null && meta?.host === host && stored.expiresAt - RENEW_BEFORE_MS > now();
    return usable ? stored! : rotate(host);
  }

  async function rotate(host: string): Promise<RemoteIdentity> {
    const { certificatePem, privateKeyPem } = await generate(host);
    const createdAt = now();
    // 만료는 인증서 자신이 정한다. 별도로 계산해 두면 둘이 어긋나 어느 날 조용히 끊긴다.
    const expiresAt = Date.parse(new crypto.X509Certificate(certificatePem).validTo);
    fileSystem.mkdirSync(directory, { recursive: true, mode: DIR_MODE });
    writeSecret(path.join(directory, KEY_FILE), privateKeyPem);
    writeSecret(path.join(directory, CERTIFICATE_FILE), certificatePem);
    writeSecret(path.join(directory, META_FILE), `${JSON.stringify({ host, createdAt, expiresAt } satisfies StoredMeta)}\n`);
    return { certificatePem, privateKeyPem, fingerprint: fingerprintOf(certificatePem), createdAt, expiresAt };
  }

  function readMeta(): StoredMeta | null {
    try {
      return JSON.parse(fileSystem.readFileSync(path.join(directory, META_FILE), "utf8")) as StoredMeta;
    } catch {
      return null;
    }
  }

  function writeSecret(file: string, content: string): void {
    const temporary = `${file}.tmp`;
    fileSystem.writeFileSync(temporary, content, { encoding: "utf8", mode: FILE_MODE });
    fileSystem.renameSync(temporary, file);
  }

  return { ensure, read, rotate };
}

export function fingerprintOf(certificatePem: string): string {
  return new crypto.X509Certificate(certificatePem).fingerprint256;
}

/** 링크와 UI가 같은 표기를 쓰도록 지문 비교는 항상 정규화한 뒤 수행한다. */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/gu, "").toUpperCase();
}

export function fingerprintsMatch(left: string, right: string): boolean {
  const a = Buffer.from(normalizeFingerprint(left), "hex");
  const b = Buffer.from(normalizeFingerprint(right), "hex");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function generateSelfSignedCertificate(host: string): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
  // 클라이언트는 SAN으로만 호스트를 검증한다. IP 주소는 CN이 아니라 IP SAN에 들어가야 한다.
  const isIpAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host);
  const notBeforeDate = new Date();
  const generated = await selfsigned.generate([{ name: "commonName", value: host }], {
    notBeforeDate,
    notAfterDate: new Date(notBeforeDate.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000),
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [isIpAddress ? { type: 7, ip: host } : { type: 2, value: host }] },
    ],
  });
  return { certificatePem: generated.cert, privateKeyPem: generated.private };
}
