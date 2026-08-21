import { describe, expect, it } from "vitest";

import {
  GATEWAY_TRANSIENT_ERROR_STATUS,
  claudeRetryableUpstreamStatus,
} from "../../src/anthropic/claude-context.js";

/**
 * Claude Code retries 408/409/429/500/529 and nothing else. A transient upstream failure that
 * reaches it as any other code ends the turn on the first attempt, so these mappings are the
 * contract that keeps the client's retry budget reachable.
 */
describe("claudeRetryableUpstreamStatus", () => {
  it("lifts the transient 5xx family onto overloaded_error", () => {
    expect(claudeRetryableUpstreamStatus(502)).toBe(529);
    expect(claudeRetryableUpstreamStatus(503)).toBe(529);
    expect(claudeRetryableUpstreamStatus(504)).toBe(529);
  });

  it("lifts Cloudflare-family edge failures the same way", () => {
    for (const status of [520, 521, 522, 523, 524]) {
      expect(claudeRetryableUpstreamStatus(status)).toBe(529);
    }
  });

  it("leaves statuses the client already retries untouched", () => {
    for (const status of [408, 409, 429, 500, 529]) {
      expect(claudeRetryableUpstreamStatus(status)).toBe(status);
    }
  });

  it("never rewrites a verdict about the request itself", () => {
    // Retrying cannot change a 400/401/403/413, and a rewrite would hide the real cause.
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(claudeRetryableUpstreamStatus(status)).toBe(status);
    }
  });

  it("leaves a success status alone", () => {
    expect(claudeRetryableUpstreamStatus(200)).toBe(200);
  });

  it("reports a gateway-side transient fault as a status the client retries", () => {
    expect(GATEWAY_TRANSIENT_ERROR_STATUS).toBe(500);
    expect(claudeRetryableUpstreamStatus(GATEWAY_TRANSIENT_ERROR_STATUS))
      .toBe(GATEWAY_TRANSIENT_ERROR_STATUS);
  });
});
