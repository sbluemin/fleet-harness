import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(desktopRoot, "src");
const entryRoot = path.join(desktopRoot, "assets", "entry");

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

  it("keeps the entry page scriptless and independent from Console renderer assets", () => {
    const html = fs.readFileSync(path.join(entryRoot, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(entryRoot, "entry.css"), "utf8");
    expect(html).toContain("default-src 'none'; style-src 'self'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'");
    expect(html).not.toMatch(/<(script|button|a|form|input)\b|contenteditable|tabindex/i);
    expect(html).not.toMatch(/https?:|runtime\/fleet-console/i);
    expect(css).toContain("--brass:");
    expect(css).toContain("--positive:");
    expect(css).toContain("--coral:");
    expect(css).toContain("--chrome-band-height");
    expect(css).not.toMatch(/@import|url\(/i);
  });
});
