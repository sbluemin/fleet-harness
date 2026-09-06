import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { encodeAccessLink, parseAccessLink } from "../core/host/access-link.js";
import { createPairedDeviceStore } from "../core/host/paired-devices.js";
import { createRemoteEndpointStore } from "../core/host/remote-endpoint.js";
import { createRemoteHostStore } from "../core/host/remote-hosts.js";
import { createRemoteIdentityStore, fingerprintOf, fingerprintsMatch, normalizeFingerprint } from "../core/host/remote-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { force: true, recursive: true });
});

function createDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-identity-"));
  tempDirs.push(dir);
  return dir;
}

describe("remote identity store", () => {
  it("generates a certificate a tls client can verify for the bound address", async () => {
    const identity = await createRemoteIdentityStore(createDir()).ensure("127.0.0.1");
    const certificate = new crypto.X509Certificate(identity.certificatePem);

    // Node의 TLS 클라이언트는 CN이 아니라 SAN으로 호스트를 검증한다.
    expect(certificate.subjectAltName).toContain("127.0.0.1");
    expect(tls.checkServerIdentity("127.0.0.1", certificate.toLegacyObject())).toBeUndefined();
    expect(identity.privateKeyPem).toContain("PRIVATE KEY");
  });

  it("keeps the private key readable only by its owner", async () => {
    const dir = createDir();
    await createRemoteIdentityStore(dir).ensure("127.0.0.1");

    const mode = fs.statSync(path.join(dir, "remote", "identity-key.pem")).mode & 0o777;

    expect(mode).toBe(0o600);
  });
});

describe("fingerprints", () => {

  it("compares fingerprints regardless of separators or case", async () => {
    const identity = await createRemoteIdentityStore(createDir()).ensure("127.0.0.1");
    const compact = normalizeFingerprint(identity.fingerprint).toLowerCase();

    // 마지막 바이트는 고정값이 아니라 실제 값을 뒤집어 바꾼다 — 고정값이면 지문이 마침 그 값으로 끝나는
    // 256분의 1의 인증서에서 "다른 지문"이 원본과 같아져 이 케이스가 무작위로 무너진다.
    const flippedTail = ((Number.parseInt(compact.slice(-2), 16) ^ 0xff) >>> 0).toString(16).padStart(2, "0");

    expect(fingerprintsMatch(identity.fingerprint, compact)).toBe(true);
    expect(fingerprintsMatch(identity.fingerprint, `${compact.slice(0, -2)}${flippedTail}`)).toBe(false);
    expect(fingerprintsMatch(identity.fingerprint, "")).toBe(false);
    // 길이가 다른 값은 접두사가 같아도 통과하면 안 된다.
    expect(fingerprintsMatch(identity.fingerprint, compact.slice(0, 40))).toBe(false);
  });
});

/**
 * 공표한 포트는 신원과 같은 성격의 사실이다 — 손님이 돌아올 때 믿는 것. 그래서 같은
 * 디렉터리에 살고, 손님을 전부 내보내는 자리에서만 놓인다.
 */
