import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { certificateFingerprint, isAccessLinkInput, normalizeFingerprint, parseAccessLink } from "../src/remote-access-link.js";

const TOKEN = "y8bWk3Qm5r7uJ2pS4vX9zA1cE6gI0lN8oR2tU5wY7bD";
const FINGERPRINT = "6FB70D9F321A91894CC16D613078FB13E6E0B0042D985D395F04EDC2103E95F8";

describe("remote access link", () => {
  it("derives every address it will use from the link itself", () => {
    const link = parseAccessLink(`https://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`);

    expect(link).toEqual({
      origin: "https://192.168.1.20:4310",
      hostname: "192.168.1.20",
      port: 4310,
      consoleUrl: "https://192.168.1.20:4310/console/",
      joinUrl: "https://192.168.1.20:4310/api/v1/join",
      token: TOKEN,
      fingerprint: FINGERPRINT,
    });
  });

  it("accepts a colon-grouped fingerprint and a default https port", () => {
    const grouped = FINGERPRINT.match(/.{2}/gu)!.join(":").toLowerCase();
    const link = parseAccessLink(`https://console.example/join#t=${TOKEN}&f=${grouped}`);

    expect(link.fingerprint).toBe(FINGERPRINT);
    expect(link.port).toBe(443);
    expect(link.origin).toBe("https://console.example");
  });

  it.each([
    ["plaintext transport", `http://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`],
    ["embedded credentials", `https://user:pw@192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}`],
    ["a query string", `https://192.168.1.20:4310/join?next=/console#t=${TOKEN}&f=${FINGERPRINT}`],
    ["another path", `https://192.168.1.20:4310/console/#t=${TOKEN}&f=${FINGERPRINT}`],
    ["a missing fingerprint", `https://192.168.1.20:4310/join#t=${TOKEN}`],
    ["a missing token", `https://192.168.1.20:4310/join#f=${FINGERPRINT}`],
    ["a truncated fingerprint", `https://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT.slice(0, 62)}`],
    ["a non-hex fingerprint", `https://192.168.1.20:4310/join#t=${TOKEN}&f=${"Z".repeat(64)}`],
    ["a smuggled extra parameter", `https://192.168.1.20:4310/join#t=${TOKEN}&f=${FINGERPRINT}&next=https://evil.test`],
    ["a duplicated token", `https://192.168.1.20:4310/join#t=${TOKEN}&t=${TOKEN}`],
    ["whitespace", `https://192.168.1.20:4310/join #t=${TOKEN}&f=${FINGERPRINT}`],
    ["a token with punctuation", `https://192.168.1.20:4310/join#t=${TOKEN.slice(0, 20)}.'"&f=${FINGERPRINT}`],
  ])("refuses a link with %s", (_label, input) => {
    expect(() => parseAccessLink(input)).toThrow("pairing_target_invalid");
  });

  it("recognizes only https strings as link candidates", () => {
    expect(isAccessLinkInput("https://host/join#t=a&f=b")).toBe(true);
    expect(isAccessLinkInput("127.0.0.1:4310")).toBe(false);
    expect(isAccessLinkInput("ssh:devbox")).toBe(false);
  });

  it("reads the presented certificate fingerprint the same way the console reports it", () => {
    expect(certificateFingerprint(TEST_CERTIFICATE)).toBe(TEST_CERTIFICATE_FINGERPRINT);
    expect(certificateFingerprint(TEST_CERTIFICATE)).toBe(normalizeFingerprint(new crypto.X509Certificate(TEST_CERTIFICATE).fingerprint256));
    expect(certificateFingerprint("not a certificate")).toBeNull();
    expect(certificateFingerprint("")).toBeNull();
  });
});

/** openssl로 만든 고정 자체서명 인증서. 지문 상수와 함께 계산 자체를 계약으로 고정한다. */
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

const TEST_CERTIFICATE_FINGERPRINT = "4E65DB042A0B820A0833F016ADAD49B03D7DB5BC43100696AD023A77B647E325";
