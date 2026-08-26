import { describe, expect, it } from "vitest";

// @ts-expect-error The executable manifest transformer is intentionally JavaScript.
import { createPublishedFleetConsoleManifest } from "../../../scripts/pack-fleet-console-manifest.mjs";

describe("published Console manifest", () => {
  it("removes workspace specifiers from every copied dependency section", () => {
    const manifest = createPublishedFleetConsoleManifest({
      name: "@dotobokuri/fleet-console",
      private: true,
      dependencies: {
        "node-pty": "^1.0.0",
        "@anthropic-ai/claude-agent-sdk": "^0.3.212",
        ws: "^8.18.0",
        "font-list": "^2.1.0",
        selfsigned: "^5.5.0",
        esbuild: "0.27.7",
        "@vscode/ripgrep": "1.18.0",
        "@fleet-console/desktop-protocol": "workspace:*",
      },
      devDependencies: {
        typescript: "^6.0.2",
        "@fleet-console/desktop-protocol": "workspace:*",
      },
      optionalDependencies: { fixture: "workspace:^" },
      peerDependencies: { react: "^19.0.0" },
      scripts: { build: "pnpm build" },
    });

    for (const [section, entries] of Object.entries(manifest)) {
      if (!section.endsWith("Dependencies") || entries === null || typeof entries !== "object" || Array.isArray(entries)) continue;
      expect(Object.values(entries).some((value) => typeof value === "string" && value.startsWith("workspace:"))).toBe(false);
    }
    expect(manifest.devDependencies).toEqual({ typescript: "^6.0.2" });
    expect(manifest.dependencies).toEqual({ "node-pty": "^1.0.0", "@anthropic-ai/claude-agent-sdk": "^0.3.212", ws: "^8.18.0", "font-list": "^2.1.0", selfsigned: "^5.5.0", esbuild: "0.27.7", "@vscode/ripgrep": "1.18.0" });
  });
});
