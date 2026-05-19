import { runApp } from "./app.js";
import { FLEET_HELP_TEXT, parseFleetCliOptions } from "./cli-args.js";

const options = parseFleetCliOptions(process.argv.slice(2));

if (options.help) {
  process.stdout.write(FLEET_HELP_TEXT);
  process.exit(0);
}

runApp({ native: options.native }).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
