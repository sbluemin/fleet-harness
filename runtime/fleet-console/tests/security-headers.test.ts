import { describe, expect, it } from "vitest";

import { CONSOLE_SECURITY_HEADERS } from "../core/host/security-headers.js";

describe("console security headers", () => {
  it("allows only the badge image host needed by markdown previews", () => {
    const policy = CONSOLE_SECURITY_HEADERS["Content-Security-Policy"];
    expect(policy).toContain("img-src 'self' data: https://img.shields.io");
    expect(policy).not.toContain("img-src *");
  });
});
