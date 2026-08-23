import { createProviderAuthService } from "@dotobokuri/core-ai-gateway";

import { runApp } from "./app.js";
import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { dispatchFleetArgv } from "./fleet-dispatch.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";
import { resolveSiblingConsoleCliPath } from "./update/stop-console.js";

const status = await dispatchFleetArgv(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  runApp,
  createAuthService: () => createProviderAuthService(),
  dispatchAuthCommand,
  dispatchUpdateCommand,
  siblingCliPath: resolveSiblingConsoleCliPath(import.meta.url),
  moduleUrl: import.meta.url,
});

process.exitCode = status;
