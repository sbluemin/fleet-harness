import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: unknown) => query(input),
  createSdkMcpServer: vi.fn(),
  getSessionInfo: vi.fn(),
  tool: vi.fn(),
}));

const { runVendorQuery } = await import("../src/claude/vendor-sdk.js");

afterEach(() => {
  query.mockReset();
});

describe("runVendorQuery close", () => {
  it("swallows a synchronous return() throw and is exact-once", () => {
    const returnFn = vi.fn(() => {
      throw new Error("sync cleanup");
    });
    query.mockReturnValue(makeVendorRun(returnFn));
    const run = runVendorQuery({ prompt: "hi", options: {} });
    expect(() => run.close()).not.toThrow();
    expect(() => run.close()).not.toThrow();
    expect(returnFn).toHaveBeenCalledOnce();
  });

  it("swallows a rejected return() Promise and is exact-once", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const returnFn = vi.fn(() => Promise.reject(new Error("async cleanup")));
      query.mockReturnValue(makeVendorRun(returnFn));
      const run = runVendorQuery({ prompt: "hi", options: {} });
      expect(() => run.close()).not.toThrow();
      expect(() => run.close()).not.toThrow();
      expect(returnFn).toHaveBeenCalledOnce();
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

function makeVendorRun(returnFn: () => Promise<unknown>): AsyncGenerator<unknown, void> {
  return {
    async *[Symbol.asyncIterator]() {},
    async next() {
      return { done: true, value: undefined };
    },
    return: returnFn,
    async throw() {
      return { done: true, value: undefined };
    },
  } as unknown as AsyncGenerator<unknown, void>;
}
