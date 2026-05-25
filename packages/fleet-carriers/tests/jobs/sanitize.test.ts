import { describe, expect, it } from "vitest";

import { sanitizeChunk, sanitizeToolBlockLabel, sanitizeToolLabel } from "../../src/jobs/index.js";

describe("carrier job sanitizers", () => {
  it("removes terminal controls from stream chunks while preserving LF structure", () => {
    const text = [
      "alpha",
      "\x1b[2J",
      " beta",
      "\u009b31m",
      " gamma",
      "\x1b]52;c;AAAA\x07",
      " delta",
      "\u009d52;c;BBBB\u009c",
      " epsilon",
      "\x1bP1;payload\x1b\\",
      " zeta",
      "\u0090payload\u009c",
      " eta\r\ntheta\rkappa\n",
      "\x07",
    ].join("");

    expect(sanitizeChunk(text)).toBe("alpha beta gamma delta epsilon zeta eta\ntheta\nkappa\n");
  });

  it("normalizes tool labels to one-line printable text", () => {
    expect(sanitizeToolBlockLabel("one\r\ntwo\rthree\nfour")).toBe("one two three four");
    expect(sanitizeToolLabel(" Audit\r\n\x1b]52;c;AAAA\x07Phase\u009b2J Done ")).toBe("Audit Phase Done");
    expect(sanitizeToolLabel("\x1b[2J\u009b31m")).toBe("(unnamed)");
  });
});
