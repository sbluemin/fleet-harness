import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "tsup";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fleet-remote-live-"));
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  await build({
    entry: ["src/runtime/remote/live-runner.ts"], outDir: temporaryDirectory,
    format: ["esm"], platform: "node", target: "node22", splitting: false,
    sourcemap: false, clean: true, silent: true, external: [],
  });
  const runner = await import(pathToFileURL(path.join(temporaryDirectory, "live-runner.mjs")).href);
  await runner.runRemoteLiveTest({ signal: controller.signal });
} catch (error) {
  process.exitCode = 1;
  const code = error instanceof Error ? error.message.replace(/[^a-z0-9_:-]/giu, "_").slice(0, 120) : "remote_live_failed";
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
