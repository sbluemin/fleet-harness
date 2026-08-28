import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `existsSync`를 세는 이유는 캐시가 이 수정의 본체이기 때문이다. vendor는 경로 해석을 캐시하지
 * 않아 턴마다 같은 판정을 다시 했고, 그 반복이 이벤트 루프를 세웠다. 호출 수가 늘지 않는 것이
 * "한 번만 푼다"의 유일한 관측 가능한 증거다.
 */
const fsProbe = vi.hoisted(() => ({ existsCalls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    existsSync: (target: string) => {
      fsProbe.existsCalls.push(String(target));
      return actual.existsSync(target);
    },
  };
});

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: unknown) => query(input),
  createSdkMcpServer: vi.fn(),
  getSessionInfo: vi.fn(),
  tool: vi.fn(),
}));

const { resolveClaudeExecutable, runVendorQuery, runVendorSession } = await import(
  "../src/claude/vendor-sdk.js"
);

const VENDOR = "@anthropic-ai/claude-agent-sdk";

/** 설치된 플랫폼 패키지 집합을 흉내 내는 시드. 실제 디스크를 건드리지 않는다. */
function seedProbe(
  installed: readonly string[],
  overrides: { readonly platform: string; readonly arch: string; readonly preferMusl: boolean },
) {
  const present = new Set(installed);
  return {
    ...overrides,
    resolve: (specifier: string) => {
      if (!present.has(specifier)) throw new Error(`MODULE_NOT_FOUND: ${specifier}`);
      return `/store/${specifier}`;
    },
    exists: (candidate: string) => candidate.startsWith("/store/"),
  };
}

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

describe("resolveClaudeExecutable", () => {
  const BOTH_LINUX = [`${VENDOR}-linux-x64/claude`, `${VENDOR}-linux-x64-musl/claude`];

  it("takes the glibc build when the musl loader is absent", () => {
    const probe = seedProbe(BOTH_LINUX, { platform: "linux", arch: "x64", preferMusl: false });
    expect(resolveClaudeExecutable(probe)).toBe(`/store/${VENDOR}-linux-x64/claude`);
  });

  // 이 리포는 8개 플랫폼 패키지를 전부 설치하므로 두 후보가 늘 함께 있다. 그래서 순서가 곧
  // 판정이고, preferMusl이 뒤집혔을 때 결과도 뒤집히는 것이 이 함수의 실질이다.
  it("takes the musl build when the musl loader is present", () => {
    const probe = seedProbe(BOTH_LINUX, { platform: "linux", arch: "x64", preferMusl: true });
    expect(resolveClaudeExecutable(probe)).toBe(`/store/${VENDOR}-linux-x64-musl/claude`);
  });

  it("falls through to the other libc build when the preferred one is not installed", () => {
    const probe = seedProbe([`${VENDOR}-linux-arm64-musl/claude`], {
      platform: "linux",
      arch: "arm64",
      preferMusl: false,
    });
    expect(resolveClaudeExecutable(probe)).toBe(`/store/${VENDOR}-linux-arm64-musl/claude`);
  });

  it("appends the Windows extension and uses the android package name", () => {
    const win = seedProbe([`${VENDOR}-win32-x64/claude.exe`], {
      platform: "win32",
      arch: "x64",
      preferMusl: false,
    });
    expect(resolveClaudeExecutable(win)).toBe(`/store/${VENDOR}-win32-x64/claude.exe`);

    const android = seedProbe([`${VENDOR}-linux-arm64-android/claude`], {
      platform: "android",
      arch: "arm64",
      preferMusl: false,
    });
    expect(resolveClaudeExecutable(android)).toBe(`/store/${VENDOR}-linux-arm64-android/claude`);
  });

  // 못 고르면 vendor가 오늘처럼 스스로 푼다. 여기서 예외를 던지면 최적화 실패가 기능 실패가 된다.
  it("returns null when nothing is installed", () => {
    const probe = seedProbe([], { platform: "linux", arch: "x64", preferMusl: false });
    expect(resolveClaudeExecutable(probe)).toBeNull();
  });
});

describe("child binary handoff", () => {
  it("hands the vendor a path so its own resolver never runs", () => {
    query.mockReturnValue(makeVendorRun(async () => undefined));
    const report = vi.spyOn(process.report, "getReport");
    try {
      runVendorQuery({ prompt: "hi", options: { model: "sonnet" } });
      runVendorSession({ options: { model: "sonnet" } });

      for (const call of query.mock.calls) {
        const options = (call[0] as { options: Record<string, unknown> }).options;
        // vendor는 이 키가 비었을 때만 자기 해석 분기에 들어가고, 그 분기가 getReport를 부른다.
        expect(typeof options.pathToClaudeCodeExecutable).toBe("string");
        // 호출자가 고른 옵션은 그대로 남아야 한다 — 경로는 더해질 뿐 덮지 않는다.
        expect(options.model).toBe("sonnet");
      }
      expect(query).toHaveBeenCalledTimes(2);
      expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
    }
  });

  it("resolves the path once and reuses it across runs", async () => {
    vi.resetModules();
    const fresh = await import("../src/claude/vendor-sdk.js");
    query.mockReturnValue(makeVendorRun(async () => undefined));
    fsProbe.existsCalls.length = 0;

    fresh.runVendorQuery({ prompt: "one", options: {} });
    const afterFirst = fsProbe.existsCalls.length;
    fresh.runVendorQuery({ prompt: "two", options: {} });
    fresh.runVendorSession({ options: {} });

    expect(afterFirst).toBeGreaterThan(0);
    expect(fsProbe.existsCalls.length).toBe(afterFirst);
  });
});
