import { runReaper } from "./reaper.js";

// The reaper leads a session of its own: a terminal's SIGINT or SIGHUP is not about it. A SIGTERM while its Console runs
// comes from someone else; it leaves the Console's children alone and exits, and the Console starts another reaper.
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
process.on("SIGTERM", () => process.exit(0));

runReaper({ input: process.stdin, env: process.env, exit: (code) => process.exit(code) });
