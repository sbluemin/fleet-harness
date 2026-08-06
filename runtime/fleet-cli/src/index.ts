import { createInfraServices } from "@dotobokuri/core-infra";

import { runApp } from "./app.js";
import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { buildFleetHelpText, parseFleetCliOptions } from "./cli-args.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";

const argv = process.argv.slice(2);

if (argv[0] === "update") {
  const status = await dispatchUpdateCommand(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(status);
}

if (argv[0] === "auth") {
  const status = await dispatchAuthCommand(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
  }, createInfraServices());
  process.exit(status);
}

const options = parseFleetCliOptions(argv);

if (options.help) {
  process.stdout.write(buildFleetHelpText());
  process.exit(0);
}

runApp({ passthroughArgs: options.passthroughArgs }).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
