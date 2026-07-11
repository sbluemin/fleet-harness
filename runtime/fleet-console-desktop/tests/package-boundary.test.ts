import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(desktopRoot, "src");

describe("desktop package boundary", () => {
  it("has no copied renderer, HTTP server, PTY, preload, or raw IPC surface", () => {
    const source = fs.readdirSync(sourceRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
      .map((entry) => fs.readFileSync(path.join(sourceRoot, entry), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/from ["'](?:react|vite|xterm|node-pty|ws)["']/);
    expect(source).not.toMatch(/\b(ipcMain|ipcRenderer|contextBridge|preload|createServer)\b/);
  });

  it("keeps desktop dependencies lean and free of workspace runtime dependencies", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {})).not.toEqual(expect.arrayContaining(["react", "vite", "xterm", "node-pty"]));
    expect(Object.values(packageJson.dependencies ?? {})).not.toContain("workspace:*");
  });
});
