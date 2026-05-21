import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { runApp } from "./app.js";
import { FLEET_HELP_TEXT, parseFleetCliOptions } from "./cli-args.js";

const argv = process.argv.slice(2);

if (argv[0] === "auth") {
  const status = await dispatchAuthCommand(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(status);
}

const options = parseFleetCliOptions(argv, process.env);

if (options.help) {
  process.stdout.write(FLEET_HELP_TEXT);
  process.exit(0);
}

runApp({
  cursorSync: options.cursorSync,
  native: options.native,
  replaceSystemPrompt: options.replaceSystemPrompt,
  enableMetaphor: options.enableMetaphor,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
