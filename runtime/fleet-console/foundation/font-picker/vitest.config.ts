import { defineConfig } from "vitest/config";

// A local config so this source-only package is not silently governed by the
// parent Console vitest config (environment: "node", include: tests/**/*.test.ts),
// which drops the React component .test.tsx suite. jsdom + .tsx inclusion keeps the
// FontPicker component tests live.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
