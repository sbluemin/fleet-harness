import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  retries: 0,
  workers: 1,
  use: { headless: false, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
