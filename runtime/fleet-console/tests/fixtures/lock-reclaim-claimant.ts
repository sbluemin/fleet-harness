// A separate reclaimer process for the lock protocol test: it tries to reclaim the lock named on the command line once,
// prints the outcome, and stays alive so its reclaim marker keeps the state that outcome left behind.
import { createConsoleLock } from "../../core/host/bootstrap/lock.js";

const lockFile = process.argv[2];
if (!lockFile) throw new Error("lock file argument is missing");
const lock = createConsoleLock({ report: () => {} });
const observed = lock.observeLock(lockFile);
if (observed.kind !== "owner") throw new Error(`expected a lock with an owner, got ${observed.kind}`);
void lock.reclaimLock(lockFile, observed.instance).then((result) => {
  process.stdout.write(`${result.kind}\n`);
  setInterval(() => {}, 60_000);
});
