import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@dotobokuri/core-agent": path.join(workspaceRoot, "packages/core-agent/src"),
      "@dotobokuri/core-unified-agent": path.join(workspaceRoot, "packages/core-unified-agent/src"),
      "@dotobokuri/fleet-admiral": path.join(workspaceRoot, "packages/fleet-admiral/src"),
      "@dotobokuri/fleet-carriers": path.join(workspaceRoot, "packages/fleet-carriers/src"),
      "@dotobokuri/core-infra": path.join(workspaceRoot, "packages/fleet-infra/src"),
      "@dotobokuri/fleet-wiki": path.join(workspaceRoot, "packages/fleet-wiki/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
