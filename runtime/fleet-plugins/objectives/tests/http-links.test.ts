import { describe, expect, it } from "vitest";

import { linkParts } from "../client/http-links.js";

describe("objective http links", () => {
  it("links only http(s) and leaves sentence punctuation outside the address", () => {
    expect(linkParts("See (https://example.com/a).")).toEqual([
      { kind: "text", text: "See (" },
      { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: ")." },
    ]);
    expect(linkParts("https://en.wikipedia.org/wiki/URL_(disambiguation).")).toEqual([
      { kind: "link", text: "https://en.wikipedia.org/wiki/URL_(disambiguation)", href: "https://en.wikipedia.org/wiki/URL_(disambiguation)" },
      { kind: "text", text: "." },
    ]);
  });

  it("does not link other schemes or a broken http address", () => {
    const text = "javascript:alert(1) file:///tmp data:text/html,hi http://";
    expect(linkParts(text).some((part) => part.kind === "link")).toBe(false);
    expect(linkParts(text).map((part) => part.text).join("")).toBe(text);
  });
});
