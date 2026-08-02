import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TheaterRegistry, type TheaterRegistration } from "../core/host/theaters/theater-domain.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TheaterRegistry order", () => {
  it("preserves the legacy MRU order when no Theater has a manual order", () => {
    const theaters = new TheaterRegistry();
    theaters.restore([
      registration("oldest", "2026-01-01T00:00:00.000Z"),
      registration("latest", "2026-03-01T00:00:00.000Z"),
      registration("middle", "2026-02-01T00:00:00.000Z"),
    ]);

    expect(theaters.list().map((theater) => theater.id)).toEqual(["latest", "middle", "oldest"]);
  });

  it("places unordered Theaters first by MRU and ordered Theaters by ascending order", () => {
    const theaters = new TheaterRegistry();
    theaters.restore([
      registration("ordered-last", "2026-04-01T00:00:00.000Z", 4),
      registration("unordered-old", "2026-01-01T00:00:00.000Z"),
      registration("ordered-first", "2026-03-01T00:00:00.000Z", 1),
      registration("unordered-new", "2026-02-01T00:00:00.000Z"),
    ]);

    expect(theaters.list().map((theater) => theater.id)).toEqual([
      "unordered-new",
      "unordered-old",
      "ordered-first",
      "ordered-last",
    ]);
  });

  it("updates order immutably and preserves it when the Theater is registered again", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-order-"));
    tempDirs.push(dir);
    const theaters = new TheaterRegistry();
    const original = await theaters.register(dir);

    const ordered = theaters.setOrder(original.id, 2);
    const reopened = await theaters.register(dir);

    expect(ordered).not.toBe(original);
    expect(ordered?.order).toBe(2);
    expect(reopened.order).toBe(2);
    expect(theaters.setOrder("missing", 0)).toBeNull();
  });

  it("keeps MRU fallback based on lastOpenedAt when removing the active Theater", () => {
    const theaters = new TheaterRegistry();
    theaters.restore([
      registration("ordered-first", "2026-01-01T00:00:00.000Z", 0),
      registration("next-mru", "2026-02-01T00:00:00.000Z", 2),
      registration("current-mru", "2026-03-01T00:00:00.000Z", 1),
    ]);

    expect(theaters.remove("current-mru")).toBe(true);
    expect(theaters.list().map((theater) => theater.id)).toEqual(["ordered-first", "next-mru"]);
    expect(theaters.getMru()?.id).toBe("next-mru");
  });
});

function registration(id: string, lastOpenedAt: string, order?: number): TheaterRegistration {
  return {
    id,
    path: `/work/${id}`,
    realpath: `/work/${id}`,
    label: id,
    registeredAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt,
    ...(order !== undefined ? { order } : {}),
  };
}
