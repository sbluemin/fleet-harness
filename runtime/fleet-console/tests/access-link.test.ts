import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  encodeAccessLink,
  isAccessLinkInput,
  parseAccessLink,
  sanitizeAccessLabel,
  type AccessLinkPayload,
  type ValidatedAccessLink,
} from "@fleet-console/access-protocol";

interface AccessProtocolVectors {
  readonly positive: ReadonlyArray<{
    readonly name: string;
    readonly payload: Omit<AccessLinkPayload, "v">;
    readonly link: string;
    readonly parsed: ValidatedAccessLink;
  }>;
  readonly negative: ReadonlyArray<{
    readonly name: string;
    readonly link: string;
  }>;
}

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../access-protocol/vectors.json", import.meta.url)), "utf8")) as AccessProtocolVectors;
const IPV4_VECTOR = vectors.positive[0]!;
const TOKEN = IPV4_VECTOR.payload.token;
const FINGERPRINT = IPV4_VECTOR.parsed.fingerprint;

function link(overrides: { endpoint?: string; token?: string; fingerprint?: string; label?: string } = {}): string {
  return encodeAccessLink({
    endpoint: overrides.endpoint ?? IPV4_VECTOR.payload.endpoint,
    token: overrides.token ?? TOKEN,
    fingerprint: overrides.fingerprint ?? FINGERPRINT,
    label: overrides.label ?? IPV4_VECTOR.payload.label,
  });
}

describe("access link envelope", () => {
  it.each(vectors.positive)("matches the language-neutral $name vector", (vector) => {
    expect(encodeAccessLink(vector.payload)).toBe(vector.link);
    expect(parseAccessLink(vector.link)).toEqual(vector.parsed);
  });

  it("keeps the address out of the link text — that is the whole point of the envelope", () => {
    const value = link();

    expect(value.startsWith("fleet://join?code=")).toBe(true);
    expect(value).not.toContain("172.30.1.35");
    expect(value).not.toContain("54240");
    expect(value).not.toContain(TOKEN);
    expect(value).not.toContain(FINGERPRINT);
  });

  it.each(vectors.negative)("refuses the language-neutral $name vector", (vector) => {
    expect(() => parseAccessLink(vector.link)).toThrow("pairing_target_invalid");
  });
});

describe("access label", () => {
  it("strips the characters that would let a name disguise its own address line", () => {
    expect(sanitizeAccessLabel("dev\u202ebox\u200b")).toBe("devbox");
    expect(sanitizeAccessLabel("two\u0000  \u2028lines  here")).toBe("two lines here");
  });
});
