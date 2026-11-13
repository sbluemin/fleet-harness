import tls from "node:tls";

import { describe, expect, it, vi } from "vitest";

import {
  CERTIFICATE_ACCEPTED,
  CERTIFICATE_DEFAULT,
  CERTIFICATE_REJECTED,
  confirmRemoteIdentity,
  createPinLedger,
  installRemoteCertificatePins,
  joinRemoteConsole,
  type CertificateVerifyProc,
  type CertificateVerifyRequest,
} from "../src/remote-access.js";

const TOKEN = "y8bWk3Qm5r7uJ2pS4vX9zA1cE6gI0lN8oR2tU5wY7bD";
const FINGERPRINT = "4E65DB042A0B820A0833F016ADAD49B03D7DB5BC43100696AD023A77B647E325";
const FINGERPRINT_B = "5871C636450A21060C59E74EE5B8EDA12313AF894F48F379E680FE1B3247649C";
const OTHER_FINGERPRINT = "0".repeat(64);
const HOST = "192.168.1.20";
const ORIGIN_A = "https://192.168.1.20:4310";
const ORIGIN_B = "https://192.168.1.20:4311";
const JOIN_URL = "https://192.168.1.20:4310/api/v1/join";

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

/** 같은 호스트의 두 번째 콘솔. 지문이 TEST_CERTIFICATE와 다르다. */
const CERT_B = [
  "-----BEGIN CERTIFICATE-----",
  "MIICujCCAaICCQDzjHHouiciOTANBgkqhkiG9w0BAQsFADAfMR0wGwYDVQQDDBRm",
  "bGVldC1jb25zb2xlLXRlc3QtYjAeFw0yNjExMTMwMzI5NDJaFw0zNjExMTAwMzI5",
  "NDJaMB8xHTAbBgNVBAMMFGZsZWV0LWNvbnNvbGUtdGVzdC1iMIIBIjANBgkqhkiG",
  "9w0BAQEFAAOCAQ8AMIIBCgKCAQEArRyB2Xlv75mv0bW9Ab3/eSEZkyaOcK2DhuRe",
  "nZ3pfHYirZdcLomfbQBfdVnm4ZgwQk+Se+m7ECblpBL1s+ZDsoK5+2JiUtH7YTCX",
  "DMi8qZXWZdXEBil43SVcAPxPVoitHYxfFtc8vHo9BRk12nSTbtKn6HmX4EpU8aLD",
  "VRcn8Ht2XA+T1+DWD0WJqzMcHDX895kJRpLz8e2rtATc5gTXZ3nPmlu3PScNJmBl",
  "Ff0/hQIZwRH4RBi4hlqXngBdxHINNmtvplnH+Saz0tIMA9Hau72uzIdyhsmuS+b4",
  "oLB/ilKfr9rLgUmn575aEClgDUJPKN1ncQrWB+CX3Zi6hr5hywIDAQABMA0GCSqG",
  "SIb3DQEBCwUAA4IBAQB2cHEWIbkKBdPODKdYfwaXdMHhQjGwlQx5X0KVr/w6ZOhq",
  "orkcTyPLTcebJeKSCdkfBMJDCyVqbz+pVX8wK/mQlYCtvddqowaG/o0Z8ExX3Ugd",
  "ZTUVE6t3uPsFBnQVVzpuMxj9JN1l6P0dVCC9NiuLBgpb9naMH20K8w9Q9/Pw28SU",
  "ea85di2oNfdRRObsfA4TTS6g5UVkNCYZfj0yHi8XkVf2iJYJ5CThE4HePh8lOg8l",
  "MAJYg9R1fQM2/BSFrOHFk1jDIZAGcJrdJGJjxyqk+MbNyd2pSGK1aXPxMfcp2s0F",
  "QPDzQwEkOEtltITVF0RqZ8DUdiJaLc5pgMYDimDi",
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

  it("accepts every fingerprint registered for one host, and dropping one origin keeps the other", () => {
    const { pins, verify } = pinnedSession();
    pins.pin({ origin: ORIGIN_A, hostname: HOST, port: 4310, fingerprint: FINGERPRINT });
    pins.pin({ origin: ORIGIN_B, hostname: HOST, port: 4311, fingerprint: FINGERPRINT_B });

    expect(verify({ hostname: HOST, certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_ACCEPTED);
    expect(verify({ hostname: HOST, certificate: { data: CERT_B } })).toBe(CERTIFICATE_ACCEPTED);
    expect(verify({ hostname: HOST, certificate: { data: "" } })).toBe(CERTIFICATE_REJECTED);

    // 같은 origin의 지문 교체는 옛 지문만 뺀다. 형제의 지문은 남는다.
    pins.pin({ origin: ORIGIN_A, hostname: HOST, port: 4310, fingerprint: OTHER_FINGERPRINT });
    expect(verify({ hostname: HOST, certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_REJECTED);
    expect(verify({ hostname: HOST, certificate: { data: CERT_B } })).toBe(CERTIFICATE_ACCEPTED);

    pins.unpin(ORIGIN_A);
    expect(verify({ hostname: HOST, certificate: { data: CERT_B } })).toBe(CERTIFICATE_ACCEPTED);
    expect(verify({ hostname: HOST, certificate: { data: TEST_CERTIFICATE } })).toBe(CERTIFICATE_REJECTED);

    // 같은 지문을 두 origin이 쓰면, 하나를 지워도 그 지문은 집합에 남는다.
    pins.pin({ origin: ORIGIN_A, hostname: HOST, port: 4310, fingerprint: FINGERPRINT_B });
    pins.unpin(ORIGIN_B);
    expect(verify({ hostname: HOST, certificate: { data: CERT_B } })).toBe(CERTIFICATE_ACCEPTED);

    pins.unpin(ORIGIN_A);
    expect(verify({ hostname: HOST, certificate: { data: CERT_B } })).toBe(CERTIFICATE_DEFAULT);
  });
});

describe("remote console join", () => {
  it("sends the credential in the body, refuses redirects, and keeps it out of the URL", async () => {
    const sessionFetch = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(joinRemoteConsole(sessionFetch, JOIN_URL, TOKEN)).resolves.toBeUndefined();

    const [url, init] = sessionFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JOIN_URL);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe(JSON.stringify({ token: TOKEN }));
  });

  /**
   * 자격을 다 쓴 뒤 돌아오는 길. 본문에 토큰이 없어야 서버가 페어링 쿠키를 보고 세션을 연다 —
   * 그 요청을 아예 보내지 않으면 회수당한 기기는 새 링크 없이 영영 돌아오지 못한다.
   */
  it("resumes an existing pairing with a body that carries no credential", async () => {
    const sessionFetch = vi.fn(async () => new Response(null, { status: 204 }));

    await joinRemoteConsole(sessionFetch, JOIN_URL, null, "studio-linux");

    const [, init] = sessionFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ device: "studio-linux" }));
  });

  /**
   * 409에는 이유가 둘이고 사용자가 할 일이 정반대다 — 기다리거나, 남의 기기를 지우거나.
   * 하나로 뭉개면 상한에 걸린 사용자가 오지 않을 양보를 기다린다.
   */
  it("separates a full seat from a console that can hold no more devices", async () => {
    const held = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "remote_control_held" }), { status: 409, headers: { "content-type": "application/json" } });
    const full = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "paired_device_limit" }), { status: 409, headers: { "content-type": "application/json" } });
    const opaque = async (): Promise<Response> => new Response(null, { status: 409 });

    await expect(joinRemoteConsole(held, JOIN_URL, TOKEN)).rejects.toThrow("remote_link_control_held");
    await expect(joinRemoteConsole(full, JOIN_URL, TOKEN)).rejects.toThrow("remote_link_device_limit");
    // 본문을 읽을 수 없으면 지금까지의 뜻으로 되돌린다.
    await expect(joinRemoteConsole(opaque, JOIN_URL, TOKEN)).rejects.toThrow("remote_link_control_held");
  });
});

function pinnedSession(log?: (message: string) => void) {
  let installed: CertificateVerifyProc | null = null;
  const session = { setCertificateVerifyProc: (proc: CertificateVerifyProc | null) => { installed = proc; } };
  const pins = createPinLedger();
  installRemoteCertificatePins(session, pins, log);
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
      await expect(confirmRemoteIdentity("127.0.0.1", server.port, server.fingerprint, 2000)).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("names a mismatch as its own failure so it never reaches the browser", async () => {
    const server = await startTlsServer();
    try {
      await expect(confirmRemoteIdentity("127.0.0.1", server.port, OTHER_FINGERPRINT, 2000)).rejects.toThrow("remote_link_fingerprint_mismatch");
    } finally {
      await server.close();
    }
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
