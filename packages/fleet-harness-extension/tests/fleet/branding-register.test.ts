import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerFleetBrandingLifecycle } from "../../src/branding/register.js";

const tempDirs: string[] = [];
const ORIGINAL_AGENT_DIR_ENV = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (ORIGINAL_AGENT_DIR_ENV === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR_ENV;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.useFakeTimers();
});

describe("fleet branding register", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resources_discover가 존재하는 브랜드 테마 절대 경로를 반환한다", () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
    };

    registerFleetBrandingLifecycle(pi as any);

    const result = handlers.get("resources_discover")?.({ cwd: process.cwd(), reason: "startup" });
    const themePaths = result?.themePaths as string[];

    expect(themePaths).toHaveLength(2);
    for (const themePath of themePaths) {
      expect(themePath.startsWith("/")).toBe(true);
      expect(existsSync(themePath)).toBe(true);
    }
  });

  it("builtin dark/light일 때만 session_start에서 fleet 테마 이름을 영구 적용한다", async () => {
    process.env.PI_CODING_AGENT_DIR = createTempDir("fleet-branding-agent-");

    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
    };

    registerFleetBrandingLifecycle(pi as any);

    const setTheme = vi.fn();
    await handlers.get("session_start")?.(
      { reason: "launch" },
      {
        cwd: createTempDir("fleet-branding-cwd-"),
        hasUI: true,
        ui: {
          theme: { name: "dark" },
          setTheme,
        },
      },
    );

    await vi.runAllTimersAsync();

    expect(setTheme).toHaveBeenCalledWith("fleet-dark");
    expect(typeof setTheme.mock.calls[0][0]).toBe("string");
  });

  it("settings.json에 custom theme가 있으면 자동 적용을 건너뛴다", async () => {
    process.env.PI_CODING_AGENT_DIR = createTempDir("fleet-branding-agent-");

    const cwd = createTempDir("fleet-branding-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ theme: "aurora" }));

    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
    };

    registerFleetBrandingLifecycle(pi as any);

    const setTheme = vi.fn();
    await handlers.get("session_start")?.(
      { reason: "launch" },
      {
        cwd,
        hasUI: true,
        ui: {
          theme: { name: "dark" },
          getTheme: (name: string) => ({ name }),
          setTheme,
        },
      },
    );

    await vi.runAllTimersAsync();

    expect(setTheme).not.toHaveBeenCalled();
  });

  it("settings.json에 fleet 테마가 박혀 있고 PI가 fallback한 경우 자동 복구한다", async () => {
    process.env.PI_CODING_AGENT_DIR = createTempDir("fleet-branding-agent-");

    const cwd = createTempDir("fleet-branding-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ theme: "fleet-dark" }));

    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
    };

    registerFleetBrandingLifecycle(pi as any);

    const setTheme = vi.fn();
    await handlers.get("session_start")?.(
      { reason: "launch" },
      {
        cwd,
        hasUI: true,
        ui: {
          theme: { name: "dark" },
          setTheme,
        },
      },
    );

    await vi.runAllTimersAsync();

    expect(setTheme).toHaveBeenCalledWith("fleet-dark");
  });

  it("현재 테마가 builtin이 아니면 자동 적용을 건너뛴다", async () => {
    process.env.PI_CODING_AGENT_DIR = createTempDir("fleet-branding-agent-");

    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
    };

    registerFleetBrandingLifecycle(pi as any);

    const setTheme = vi.fn();
    await handlers.get("session_start")?.(
      { reason: "launch" },
      {
        cwd: createTempDir("fleet-branding-cwd-"),
        hasUI: true,
        ui: {
          theme: { name: "aurora" },
          getTheme: (name: string) => ({ name }),
          setTheme,
        },
      },
    );

    await vi.runAllTimersAsync();

    expect(setTheme).not.toHaveBeenCalled();
  });
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
