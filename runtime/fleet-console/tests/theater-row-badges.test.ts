import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  handleTheaterRowBadges,
  MAX_THEATER_ROW_BADGES,
  resolveTheaterRowBadges,
  sanitizeTheaterRowBadgeContributions,
} from "../core/host/theater-row-badges.js";
import type { TheaterRowBadgeProvider } from "../sdk/plugin/types.js";

describe("Theater row badge host", () => {
  it("sanitizes unknown Theaters, excessive badges, control characters, absolute paths, and undeclared fields", () => {
    const excessive = Array.from({ length: MAX_THEATER_ROW_BADGES + 3 }, (_, index) => ({
      id: `badge-${index}`,
      text: `value-${index}`,
      tone: "neutral",
    }));
    const result = sanitizeTheaterRowBadgeContributions([
      [
        { theaterId: "unknown", badges: [{ id: "branch", text: "main" }] },
        { theaterId: "known", badges: excessive, path: "/Users/secret/repo", realpath: "/private/repo" },
        { theaterId: "known-path", badges: [
          { id: "absolute-text", text: "/Users/secret/repo" },
          { id: "C:\\secret\\repo", text: "windows" },
          { id: "control", text: "main\u0000secret" },
          { id: "absolute-aria", text: "main", ariaLabel: "\\\\server\\share" },
          { id: "safe", text: "clean", tone: "positive", cwd: "/private/repo" },
        ] },
      ],
    ], ["known", "known-path"]);

    expect(result[0]?.badges).toHaveLength(MAX_THEATER_ROW_BADGES);
    expect(result[1]).toEqual({
      theaterId: "known-path",
      badges: [{ id: "safe", text: "clean", tone: "positive" }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("unknown");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("realpath");
    expect(serialized).not.toContain("cwd");
  });

  it("isolates provider timeouts and failures while preserving successful results", async () => {
    const success: TheaterRowBadgeProvider = async () => [
      { theaterId: "known", badges: [{ id: "branch", text: "main" }] },
    ];
    const failure: TheaterRowBadgeProvider = async () => {
      throw new Error("provider failed");
    };
    const timeout: TheaterRowBadgeProvider = ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

    await expect(resolveTheaterRowBadges(
      [timeout, failure, success],
      ["known"],
      { providerTimeoutMs: 20, deadlineMs: 100 },
    )).resolves.toEqual([
      { theaterId: "known", badges: [{ id: "branch", text: "main" }] },
    ]);
  });

  it("runs no more than four providers concurrently", async () => {
    let active = 0;
    let peak = 0;
    const providers = Array.from({ length: 12 }, (_, index): TheaterRowBadgeProvider => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [{ theaterId: "known", badges: [{ id: `badge-${index}`, text: String(index) }] }];
    });

    const result = await resolveTheaterRowBadges(providers, ["known"]);

    expect(peak).toBe(4);
    expect(result[0]?.badges).toHaveLength(MAX_THEATER_ROW_BADGES);
  });

  it("requires GET and the Theater Origin authorization gate", async () => {
    const responses: { status: number; payload: unknown }[] = [];
    let resolved = false;
    const deps = {
      isAuthorized: (req: { readonly headers: { readonly origin?: string } }) => req.headers.origin === "http://127.0.0.1:4312",
      listTheaterIds: () => ["known"],
      resolve: async () => {
        resolved = true;
        return [];
      },
      writeJson: (_res: unknown, status: number, payload: unknown) => responses.push({ status, payload }),
    };

    await handleTheaterRowBadges(
      { method: "GET", headers: { origin: "http://evil.example" } } as never,
      {} as never,
      deps as never,
    );
    await handleTheaterRowBadges(
      { method: "POST", headers: { origin: "http://127.0.0.1:4312" } } as never,
      {} as never,
      deps as never,
    );

    expect(responses).toEqual([
      { status: 401, payload: { error: "unauthorized" } },
      { status: 405, payload: { error: "Method not allowed" } },
    ]);
    expect(resolved).toBe(false);
  });

  it("matches the row-badges route before the Theater item regular expression", () => {
    const serverSource = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../core/host/server.ts"),
      "utf8",
    );
    const routeIndex = serverSource.indexOf('pathname === "/api/v1/theaters/row-badges"');
    const itemIndex = serverSource.indexOf("const theaterItemMatch = pathname.match");

    expect(routeIndex).toBeGreaterThan(-1);
    expect(itemIndex).toBeGreaterThan(routeIndex);
  });
});
