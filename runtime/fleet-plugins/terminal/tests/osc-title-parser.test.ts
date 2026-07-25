import { describe, expect, it } from "vitest";

import { createOscTitleParser } from "../server/shared/osc-title-parser.js";

describe("OSC title parser", () => {
  it("extracts OSC 0 and OSC 2 titles terminated by BEL or ST", () => {
    const parser = createOscTitleParser();

    expect(parser.push(Buffer.from("\x1b]0;⠐ project\x07plain\x1b]2;✳ project\x1b\\", "utf8"))).toEqual([
      "⠐ project",
      "✳ project",
    ]);
  });

  it("retains incomplete prefixes, UTF-8 title bytes, and terminators across chunk boundaries", () => {
    const parser = createOscTitleParser();
    const sequence = Buffer.from("\x1b]0;⠂ long title\x1b\\", "utf8");
    const titles: string[] = [];

    for (const byte of sequence) {
      titles.push(...parser.push(Buffer.from([byte])));
    }

    expect(titles).toEqual(["⠂ long title"]);
  });

  it("drops an over-cap residual without producing a title or poisoning the next sequence", () => {
    const parser = createOscTitleParser(8);

    expect(parser.push(Buffer.from("\x1b]0;12345", "utf8"))).toEqual([]);
    expect(parser.push(Buffer.from("\x1b]0;ok\x07", "utf8"))).toEqual(["ok"]);
  });

  it("takes the no-OSC hot path without mutating the observed bytes", () => {
    const parser = createOscTitleParser();
    const chunk = Buffer.from("\x1b[31mordinary terminal output\x1b[0m", "utf8");
    const before = Buffer.from(chunk);

    expect(parser.push(chunk)).toEqual([]);
    expect(chunk.equals(before)).toBe(true);
  });

  it("ignores malformed and unsupported OSC sequences without throwing", () => {
    const parser = createOscTitleParser();

    expect(() => parser.push(Buffer.from("\x1b]1;ignored\x07\x1b]0xbroken\x07\x1b]9;also ignored\x1b\\", "utf8"))).not.toThrow();
    expect(parser.push(Buffer.from("\x1b]0;valid\x07", "utf8"))).toEqual(["valid"]);
  });
});
