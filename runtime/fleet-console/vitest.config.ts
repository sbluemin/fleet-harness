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
      // 서브패스 alias는 bare alias보다 먼저 와야 한다: 접두 매칭이라 뒤에 두면 절대 도달하지 않는다.
      "@dotobokuri/core-infra/data-dir/settings": path.join(workspaceRoot, "packages/core-infra/src/data-dir/settings/store.ts"),
      "@dotobokuri/core-infra/data-dir": path.join(workspaceRoot, "packages/core-infra/src/data-dir/paths.ts"),
      "@dotobokuri/core-infra/workspace-dir": path.join(workspaceRoot, "packages/core-infra/src/workspace-dir/workspace-dir.ts"),
      "@dotobokuri/core-infra": path.join(workspaceRoot, "packages/core-infra/src"),
      "@dotobokuri/fleet-wiki": path.join(workspaceRoot, "packages/fleet-wiki/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
