import { createInfraServices } from "@dotobokuri/core-infra";

import { runApp } from "./app.js";
import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { buildFleetHelpText, parseFleetCliOptions } from "./cli-args.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";

const HELP_HINT = "Run 'fleet --help' for usage.";
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

if (argv[0] && !argv[0].startsWith("-")) {
  process.stderr.write(`Unknown fleet command: ${argv[0]}\n${HELP_HINT}\n`);
  process.exit(1);
}

const options = parseFleetCliOptionsOrExit(argv);

if (options.help) {
  process.stdout.write(buildFleetHelpText());
  process.exit(0);
}

runApp({
  argvOptions: options,
  cursorSync: options.cursorSync,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function parseFleetCliOptionsOrExit(argv: readonly string[]): ReturnType<typeof parseFleetCliOptions> {
  try {
    return parseFleetCliOptions(argv, process.env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
