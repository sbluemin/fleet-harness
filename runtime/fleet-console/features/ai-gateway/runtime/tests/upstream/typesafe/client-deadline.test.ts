import { describe, expect, it, vi } from "vitest";

import { SystemOneClient, SystemOneError } from "../../../src/index.js";

describe("SystemOneClient deadline", () => {
  it("keeps the timeout armed through response body read, and cleans abort listeners", async () => {
    vi.useFakeTimers();
    try {
      let bodyRead = false;
      const client = new SystemOneClient({
        readApiKey: async () => "tsv_test",
        maxAttempts: 1,
        timeoutMs: 50,
        fetch: async (_input, init) => {
          const signal = init?.signal;
          expect(signal).toBeDefined();
          const response = new Response("{}", { status: 200 });
          response.text = async () => {
              bodyRead = true;
              await new Promise<void>((resolve, reject) => {
                const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
                signal?.addEventListener("abort", onAbort, { once: true });
                // Never resolves on its own — the deadline must cut the body read.
              });
              return "{}";
          };
          response.json = async () => {
            throw new Error("json() must not be used; body is read as text under the deadline");
          };
          return response;
        },
      });

      // 타이머를 먼저 돌리면 reject가 expect 핸들러보다 앞서 unhandled가 된다.
      const pending = expect(client.listModels()).rejects.toBeInstanceOf(SystemOneError);
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      expect(bodyRead).toBe(true);
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an already-aborted caller signal before fetch", async () => {
    const abort = new AbortController();
    abort.abort();
    const client = new SystemOneClient({
      readApiKey: async () => "tsv_test",
      maxAttempts: 1,
      timeoutMs: 2_000,
      fetch: async () => {
        throw new Error("fetch must not run");
      },
    });
    await expect(client.listModels(abort.signal)).rejects.toBeInstanceOf(SystemOneError);
  });
});
