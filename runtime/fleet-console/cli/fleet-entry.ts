import { createInfraServices } from "@dotobokuri/core-infra";

import { runApp } from "./app.js";
import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { dispatchFleetArgv } from "./fleet-dispatch.js";
import { suppressSqliteExperimentalWarning } from "./suppress-sqlite-warning.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";
import { resolveSiblingConsoleCliPath } from "./update/stop-console.js";

suppressSqliteExperimentalWarning();

const status = await dispatchFleetArgv(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  runApp,
  createInfraServices: () => createInfraServices(),
  dispatchAuthCommand,
  dispatchUpdateCommand,
  siblingCliPath: resolveSiblingConsoleCliPath(import.meta.url),
  moduleUrl: import.meta.url,
});

process.exitCode = status;
