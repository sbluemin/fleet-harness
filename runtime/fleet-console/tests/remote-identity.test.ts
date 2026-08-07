import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

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

  it("puts a hostname in a dns entry rather than an ip entry", async () => {
    const identity = await createRemoteIdentityStore(createDir()).ensure("devbox.local");
    const certificate = new crypto.X509Certificate(identity.certificatePem);

    expect(certificate.subjectAltName).toBe("DNS:devbox.local");
  });

  it("reuses the stored identity for the same host", async () => {
    const dir = createDir();
    const first = await createRemoteIdentityStore(dir).ensure("127.0.0.1");
    const second = await createRemoteIdentityStore(dir).ensure("127.0.0.1");

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("regenerates when the bound host changes", async () => {
    const dir = createDir();
    const first = await createRemoteIdentityStore(dir).ensure("127.0.0.1");
    const second = await createRemoteIdentityStore(dir).ensure("10.0.0.4");

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("renews before expiry so remote access does not drop without warning", async () => {
    const dir = createDir();
    const store = createRemoteIdentityStore(dir);
    const first = await store.ensure("127.0.0.1");

    const almostExpired = createRemoteIdentityStore(dir, { now: () => first.expiresAt - 1_000 });

    const renewed = await almostExpired.ensure("127.0.0.1");

    expect(renewed.fingerprint).not.toBe(first.fingerprint);
  });

  it("keeps the private key readable only by its owner", async () => {
    const dir = createDir();
    await createRemoteIdentityStore(dir).ensure("127.0.0.1");

    const mode = fs.statSync(path.join(dir, "remote", "identity-key.pem")).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it("rotates on request and leaves the previous fingerprint behind", async () => {
    const dir = createDir();
    const store = createRemoteIdentityStore(dir);
    const first = await store.ensure("127.0.0.1");
    const rotated = await store.rotate("127.0.0.1");

    expect(rotated.fingerprint).not.toBe(first.fingerprint);
    expect(store.read()?.fingerprint).toBe(rotated.fingerprint);
  });

  it("reports no identity before one is created", async () => {
    expect(createRemoteIdentityStore(createDir()).read()).toBeNull();
  });
});

describe("fingerprints", () => {
  it("derives the fingerprint from the certificate itself", async () => {
    const identity = await createRemoteIdentityStore(createDir()).ensure("127.0.0.1");

    expect(identity.fingerprint).toBe(fingerprintOf(identity.certificatePem));
    expect(identity.fingerprint).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
  });

  it("compares fingerprints regardless of separators or case", async () => {
    const identity = await createRemoteIdentityStore(createDir()).ensure("127.0.0.1");
    const compact = normalizeFingerprint(identity.fingerprint).toLowerCase();

    expect(fingerprintsMatch(identity.fingerprint, compact)).toBe(true);
    expect(fingerprintsMatch(identity.fingerprint, `${compact.slice(0, -2)}00`)).toBe(false);
    expect(fingerprintsMatch(identity.fingerprint, "")).toBe(false);
    // 길이가 다른 값은 접두사가 같아도 통과하면 안 된다.
    expect(fingerprintsMatch(identity.fingerprint, compact.slice(0, 40))).toBe(false);
  });
});

describe("stored expiry", () => {
  it("records the expiry the certificate itself declares", async () => {
    const identity = await createRemoteIdentityStore(createDir()).ensure("127.0.0.1");
    const certificate = new crypto.X509Certificate(identity.certificatePem);

    // 메타데이터가 인증서보다 길면 만료된 인증서를 계속 쓰다 어느 날 접속이 끊긴다.
    expect(identity.expiresAt).toBe(Date.parse(certificate.validTo));
    expect(identity.expiresAt).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
  });
});
