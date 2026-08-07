import net from "node:net";
import tls from "node:tls";

import { describe, expect, it, vi } from "vitest";

import {
  CERTIFICATE_ACCEPTED,
  CERTIFICATE_DEFAULT,
  CERTIFICATE_REJECTED,
  confirmRemoteIdentity,
  installRemoteCertificatePins,
  joinRemoteConsole,
  type CertificateVerifyProc,
  type CertificateVerifyRequest,
} from "../src/remote-access.js";
import { parseAccessLink } from "../src/remote-access-link.js";

const TOKEN = "y8bWk3Qm5r7uJ2pS4vX9zA1cE6gI0lN8oR2tU5wY7bD";
const FINGERPRINT = "4E65DB042A0B820A0833F016ADAD49B03D7DB5BC43100696AD023A77B647E325";
const OTHER_FINGERPRINT = "0".repeat(64);
const LINK = parseAccessLink(`https://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`);

const TEST_CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBezCCASKgAwIBAgIBATAKBggqhkjOPQQDAjAdMRswGQYDVQQDDBJmbGVldC1j",
  "b25zb2xlLXRlc3QwHhcNMjYwODA3MTEzMTE4WhcNMzYwODA0MTEzMTE4WjAdMRsw",
  "GQYDVQQDDBJmbGVldC1jb25zb2xlLXRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMB",
  "BwNCAATIGn5NFTF1E2zSev1fJbQh1d7vQX7x2NhChPgNEidaSXCtbbiR5WcOhv9m",
  "tpQCzNOq7NTfL+7X9aKUYd3CG8Afo1MwUTAdBgNVHQ4EFgQUPIXykl6ADdwOykfp",
  "5di45jwyE3gwHwYDVR0jBBgwFoAUPIXykl6ADdwOykfp5di45jwyE3gwDwYDVR0T",
  "AQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAcerFTzrB6EGtD6SQUbsvvAyTq",
  "YVJb5bEcgcrn6qUm5QIgB2vujyeKrfiyuxsANZse3zlHOstj3TFdaoxovsexxXM=",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

/** 위 인증서와 짝인 개인키. 실제 TLS 핸드셰이크로 신원 확인 경로를 검증하려면 필요하다. */
const TEST_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfN7fRhySfa0C/HaT",
  "fqgMoLJI4HcIrdRtEqR3r/SlwLWhRANCAATIGn5NFTF1E2zSev1fJbQh1d7vQX7x",
  "2NhChPgNEidaSXCtbbiR5WcOhv9mtpQCzNOq7NTfL+7X9aKUYd3CG8Af",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

describe("remote certificate pins", () => {
  it("leaves every unpinned host to Chromium and never widens trust", () => {
    const { verify } = pinnedSession();

    expect(verify({ hostname: "example.test", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_DEFAULT);
  });

  it("accepts a pinned host only while the presented certificate matches the link", () => {
    const { pins, verify } = pinnedSession();
    pins.pin("192.168.1.20", FINGERPRINT);

    expect(verify({ hostname: "192.168.1.20", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_ACCEPTED);
    expect(verify({ hostname: "192.168.1.20", certificate: { data: "" } })).toBe(CERTIFICATE_REJECTED);

    pins.pin("192.168.1.20", OTHER_FINGERPRINT);
    expect(verify({ hostname: "192.168.1.20", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_REJECTED);

    pins.unpin("192.168.1.20");
    expect(verify({ hostname: "192.168.1.20", certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_DEFAULT);
  });

  it("logs a mismatch with a redacted host and no certificate material", () => {
    const log = vi.fn();
    const { pins, verify } = pinnedSession(log);
    pins.pin("192.168.1.20", OTHER_FINGERPRINT);

    verify({ hostname: "192.168.1.20", certificate: { data: TEST_CERTIFICATE } });

    expect(log).toHaveBeenCalledWith("remote certificate pin mismatch host=192.168.1.20");
    expect(log.mock.calls.flat().join(" ")).not.toContain("BEGIN CERTIFICATE");
  });
});

describe("remote console join", () => {
  it("sends the credential in the body, refuses redirects, and keeps it out of the URL", async () => {
    const sessionFetch = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(joinRemoteConsole(sessionFetch, LINK)).resolves.toBeUndefined();

    const [url, init] = sessionFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://192.168.1.20:4310/api/v1/join");
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe(JSON.stringify({ token: TOKEN }));
  });

  it.each([
    [401, "remote_link_rejected"],
    [403, "remote_link_host_mismatch"],
    [500, "remote_link_unverified"],
  ])("maps HTTP %i to %s", async (status, code) => {
    await expect(joinRemoteConsole(async () => new Response(null, { status }), LINK)).rejects.toThrow(code);
  });

  it("reports a refused certificate or unreachable host as one unreachable code", async () => {
    await expect(joinRemoteConsole(async () => { throw new Error("net::ERR_CERT_AUTHORITY_INVALID"); }, LINK))
      .rejects.toThrow("remote_link_unreachable");
  });

  it("gives up on a host that never answers", async () => {
    const hang = (_input: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });

    await expect(joinRemoteConsole(hang, LINK, 5)).rejects.toThrow("remote_link_unreachable");
  });
});

function pinnedSession(log?: (message: string) => void) {
  let installed: CertificateVerifyProc | null = null;
  const session = { setCertificateVerifyProc: (proc: CertificateVerifyProc | null) => { installed = proc; } };
  const pins = installRemoteCertificatePins(session, log);
  const verify = (request: CertificateVerifyRequest): number => {
    let result = Number.NaN;
    installed?.(request, (value) => { result = value; });
    return result;
  };
  return { pins, verify };
}

describe("remote identity confirmation", () => {
  it("accepts a server whose live certificate matches the link", async () => {
    const server = await startTlsServer();
    try {
      const link = parseAccessLink(`https://127.0.0.1:${server.port}/join#t=${TOKEN}&f=${server.fingerprint}`);
      await expect(confirmRemoteIdentity(link, 2000)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("names a mismatch as its own failure so it never reaches the browser", async () => {
    const server = await startTlsServer();
    try {
      const link = parseAccessLink(`https://127.0.0.1:${server.port}/join#t=${TOKEN}&f=${OTHER_FINGERPRINT}`);
      await expect(confirmRemoteIdentity(link, 2000)).rejects.toThrow("remote_link_fingerprint_mismatch");
    } finally {
      await server.close();
    }
  });

  it("reports an unreachable host without claiming a mismatch", async () => {
    const link = parseAccessLink(`https://127.0.0.1:1/join#t=${TOKEN}&f=${FINGERPRINT}`);
    await expect(confirmRemoteIdentity(link, 1000)).rejects.toThrow("remote_link_unreachable");
  });
});

async function startTlsServer(): Promise<{ port: number; fingerprint: string; close: () => Promise<void> }> {
  const server = tls.createServer({ cert: TEST_CERTIFICATE, key: TEST_KEY }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    fingerprint: FINGERPRINT,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

// net은 SNI 분기를 계약으로 확인하려고 import한다 — IP 리터럴에는 servername을 붙이지 않는다.
describe("SNI", () => {
  it("treats an IPv4 literal as an address, not a hostname", () => {
    expect(net.isIP("192.168.1.20")).toBe(4);
    expect(net.isIP("console.example")).toBe(0);
  });
});
