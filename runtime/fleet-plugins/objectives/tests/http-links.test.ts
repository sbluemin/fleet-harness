import { describe, expect, it } from "vitest";

import { linkParts } from "../client/http-links.js";

describe("objective http links", () => {
  it("links an http(s) address and stops at the address boundary", () => {
    expect(linkParts("시안(https://x.com/b)를 보세요.")).toEqual([
      { kind: "text", text: "시안(" },
      { kind: "link", text: "https://x.com/b", href: "https://x.com/b" },
      { kind: "text", text: ")" },
      { kind: "text", text: "를 보세요." },
    ]);
  });

  it("does not link other schemes or a broken http address", () => {
    const text = "javascript:alert(1) file:///tmp data:text/html,hi http://";
    expect(linkParts(text).some((part) => part.kind === "link")).toBe(false);
    expect(linkParts(text).map((part) => part.text).join("")).toBe(text);
  });
});
