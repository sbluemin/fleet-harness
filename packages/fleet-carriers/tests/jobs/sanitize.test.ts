import { describe, expect, it } from "vitest";

import { sanitizeChunk, sanitizeProviderReason, sanitizeToolBlockLabel, sanitizeToolLabel } from "../../src/jobs/sanitize.js";

describe("carrier job sanitizers", () => {
  it("removes terminal controls from stream chunks while preserving LF structure", () => {
    const esc = "\u001b";
    const text = [
      "alpha",
      `${esc}[2J`,
      " beta",
      "\u009b31m",
      " gamma",
      `${esc}]52;c;AAAA\x07`,
      " delta",
      "\u009d52;c;BBBB\u009c",
      " epsilon",
      `${esc}P1;payload${esc}\\`,
      " zeta",
      "\u0090payload\u009c",
      " eta\r\ntheta\rkappa\n",
      "\x07",
    ].join("");

    expect(sanitizeChunk(text)).toBe("alpha beta gamma delta epsilon zeta eta\ntheta\nkappa\n");
  });

  it("normalizes tool labels to one-line printable text", () => {
    const esc = "\u001b";
    expect(sanitizeToolBlockLabel("one\r\ntwo\rthree\nfour")).toBe("one two three four");
    expect(sanitizeToolLabel(` Audit\r\n${esc}]52;c;AAAA\x07Phase\u009b2J Done `)).toBe("Audit Phase Done");
    expect(sanitizeToolLabel(`${esc}[2J\u009b31m`)).toBe("(unnamed)");
  });
});

describe("sanitizeProviderReason", () => {
  it("redacts secrets, strips controls, and flattens to one capped line", () => {
    const esc = "\u001b";
    const raw = [
      `${esc}[31mconnect failed${esc}[0m`,
      "resume rejected",
      "OPENAI_API_KEY=sk-secret-value-000000",
      "bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123-_",
      "aws AKIAABCDEFGHIJKLMNOP",
    ].join("\n");

    const reason = sanitizeProviderReason(raw);

    expect(reason).not.toContain(esc);
    expect(reason).not.toContain("\n");
    expect(reason).toContain("connect failed");
    expect(reason).toContain("[REDACTED:generic_secret]");
    expect(reason).toContain("[REDACTED:jwt]");
    expect(reason).toContain("[REDACTED:aws_access_key]");
    expect(reason).not.toContain("sk-secret-value-000000");
    expect(reason).toBe(reason.trim());
  });

  it("caps overlength provider reasons at 500 characters", () => {
    const reason = sanitizeProviderReason("x".repeat(2000));
    expect(reason.length).toBe(500);
  });
});
