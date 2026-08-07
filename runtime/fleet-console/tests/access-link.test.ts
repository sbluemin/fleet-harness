import { describe, expect, it } from "vitest";

import { encodeAccessLink, isAccessLinkInput, parseAccessLink, sanitizeAccessLabel } from "../core/host/access-link.js";

const TOKEN = "sEPaty9_Yzq-N46FjCUfme4_DrCZeYlTitGcbWd8kLA";
const FINGERPRINT = "8D3FBB2A855053305C32280A2ABB566FFF9C5B14C353AE0527092ED476CBB70F";

function link(overrides: { endpoint?: string; token?: string; fingerprint?: string; label?: string } = {}): string {
  return encodeAccessLink({
    endpoint: overrides.endpoint ?? "https://172.30.1.35:54240",
    token: overrides.token ?? TOKEN,
    fingerprint: overrides.fingerprint ?? FINGERPRINT,
    label: overrides.label ?? "devbox",
  });
}

/** 봉투에 code 하나만 남기고 그 안의 JSON을 갈아 끼운다 — 거절 경로를 payload 단위로 겨눈다. */
function envelope(payload: unknown): string {
  return `fleet://join?code=${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

describe("access link envelope", () => {
  it("round-trips everything the opener needs", () => {
    const parsed = parseAccessLink(link());

    expect(parsed).toEqual({
      origin: "https://172.30.1.35:54240",
      hostname: "172.30.1.35",
      port: 54_240,
      label: "devbox",
      consoleUrl: "https://172.30.1.35:54240/console/",
      joinUrl: "https://172.30.1.35:54240/api/v1/join",
      token: TOKEN,
      fingerprint: FINGERPRINT,
    });
  });

  it("keeps the address out of the link text — that is the whole point of the envelope", () => {
    const value = link();

    expect(value.startsWith("fleet://join?code=")).toBe(true);
    expect(value).not.toContain("172.30.1.35");
    expect(value).not.toContain("54240");
    expect(value).not.toContain(TOKEN);
    expect(value).not.toContain(FINGERPRINT);
  });

  it("survives being carried through a chat window", () => {
    expect(parseAccessLink(`  ${link()}  `).label).toBe("devbox");
    expect(isAccessLinkInput(" FLEET://join?code=abc")).toBe(true);
    expect(isAccessLinkInput("https://172.30.1.35:54240/join#t=a&f=b")).toBe(false);
  });

  it("reads a hand-copied fingerprint with separators as the same value", () => {
    const colons = FINGERPRINT.match(/.{2}/gu)?.join(":") ?? "";

    expect(parseAccessLink(link({ fingerprint: colons })).fingerprint).toBe(FINGERPRINT);
  });

  it("unwraps an IPv6 literal for the certificate pin", () => {
    const parsed = parseAccessLink(link({ endpoint: "https://[fd00::1]:4310" }));

    expect(parsed.hostname).toBe("fd00::1");
    expect(parsed.origin).toBe("https://[fd00::1]:4310");
  });

  it.each([
    ["the superseded https link", "https://172.30.1.35:54240/join#t=abc&f=def"],
    ["a foreign scheme", link().replace("fleet://", "orca://")],
    ["another action", link().replace("fleet://join", "fleet://pair")],
    ["a port on the action host", link().replace("fleet://join", "fleet://join:8080")],
    ["credentials", link().replace("fleet://", "fleet://user@")],
    ["a fragment", `${link()}#extra`],
    ["a second parameter", `${link()}&mode=full`],
    ["a renamed parameter", link().replace("?code=", "?c=")],
    ["an empty envelope", "fleet://join?code="],
    ["a non-base64 envelope", "fleet://join?code=not*base64"],
    ["an embedded newline", `fleet://join?code=aGVsbG8\nd29ybGQ`],
  ])("refuses %s", (_label, value) => {
    expect(() => parseAccessLink(value)).toThrow("pairing_target_invalid");
  });

  it.each([
    ["a future version", { v: 2, endpoint: "https://a.test:4310", token: TOKEN, fingerprint: FINGERPRINT, label: "a" }],
    ["a missing field", { v: 1, endpoint: "https://a.test:4310", token: TOKEN, fingerprint: FINGERPRINT }],
    ["an extra field", { v: 1, endpoint: "https://a.test:4310", token: TOKEN, fingerprint: FINGERPRINT, label: "a", access: "full" }],
    ["a plaintext endpoint", { v: 1, endpoint: "http://a.test:4310", token: TOKEN, fingerprint: FINGERPRINT, label: "a" }],
    ["an endpoint carrying a path", { v: 1, endpoint: "https://a.test:4310/console/", token: TOKEN, fingerprint: FINGERPRINT, label: "a" }],
    ["an endpoint carrying credentials", { v: 1, endpoint: "https://u:p@a.test:4310", token: TOKEN, fingerprint: FINGERPRINT, label: "a" }],
    ["a short token", { v: 1, endpoint: "https://a.test:4310", token: "tiny", fingerprint: FINGERPRINT, label: "a" }],
    ["a truncated fingerprint", { v: 1, endpoint: "https://a.test:4310", token: TOKEN, fingerprint: "8D3FBB2A", label: "a" }],
    ["a label that sanitizes away", { v: 1, endpoint: "https://a.test:4310", token: TOKEN, fingerprint: FINGERPRINT, label: "\u200b\u200b" }],
    ["an array", [1, 2, 3]],
    ["a bare string", "nope"],
  ])("refuses a payload with %s", (_label, payload) => {
    expect(() => parseAccessLink(envelope(payload))).toThrow("pairing_target_invalid");
  });
});

describe("access label", () => {
  it("strips the characters that would let a name disguise its own address line", () => {
    expect(sanitizeAccessLabel("dev\u202ebox\u200b")).toBe("devbox");
    expect(sanitizeAccessLabel("two\u0000  \u2028lines  here")).toBe("two lines here");
  });

  it("caps the length so one host cannot crowd the list", () => {
    expect(sanitizeAccessLabel("x".repeat(200))).toHaveLength(48);
  });
});
