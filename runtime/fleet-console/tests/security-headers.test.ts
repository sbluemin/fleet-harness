import { describe, expect, it } from "vitest";

import { CONSOLE_SECURITY_HEADERS } from "../core/host/http-infra.js";

describe("console security headers", () => {
  it("allows only the badge image host needed by markdown previews", () => {
    const policy = CONSOLE_SECURITY_HEADERS["Content-Security-Policy"];
    // blob:은 Quick Launch 첨부 썸네일(같은 오리진 스크립트만 만들 수 있는 object URL) 전용 허용.
    expect(policy).toContain("img-src 'self' data: blob: https://img.shields.io");
    expect(policy).not.toContain("img-src *");
  });
});
