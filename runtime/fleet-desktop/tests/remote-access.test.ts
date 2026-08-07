import { describe, expect, it, vi } from "vitest";

import {
  CERTIFICATE_ACCEPTED,
  CERTIFICATE_DEFAULT,
  CERTIFICATE_REJECTED,
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
