import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { runApp } from "./app.js";
import { FLEET_HELP_TEXT, parseFleetCliOptions } from "./cli-args.js";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);

if (argv[0] === "auth") {
  const status = await dispatchAuthCommand(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(status);
}

if (argv[0] === "wiki") {
  const cliPath = require.resolve("@dotobokuri/fleet-wiki-ui/dist/cli.mjs");
  const child = spawn(process.execPath, [cliPath, ...argv.slice(1)], {
    stdio: "inherit",
    cwd: process.env.INIT_CWD || process.cwd(),
  });
  const status = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      if (signal) {
        resolve(1);
        return;
      }
      resolve(0);
    });
  });
  process.exit(status);
}

const options = parseFleetCliOptions(argv, process.env);

if (options.help) {
  process.stdout.write(FLEET_HELP_TEXT);
  process.exit(0);
}

runApp({
  cliId: options.cliId,
  cursorSync: options.cursorSync,
  model: options.model,
  native: options.native,
  replaceSystemPrompt: options.replaceSystemPrompt,
  enableMetaphor: options.enableMetaphor,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
