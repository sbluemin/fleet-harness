import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@sbluemin/fleet-wiki": fileURLToPath(new URL("../fleet-wiki/src/index.ts", import.meta.url)),
    },
  },
});
