import { runSessionRunner, type SessionRunnerBoot } from "../../../features/execution/host/session-host/runner.js";
import { createWindowsJobContainment, loadWindowsJobBindings } from "./windows-job-containment.js";

delete process.env.FLEET_SESSION_RUNNER_BOOT;
const chunks: Buffer[] = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  const data = Buffer.from(chunk); bytes += data.length;
  if (bytes > 64 * 1024) throw new Error("session_runner_boot_limit");
  chunks.push(data);
}
let boot: SessionRunnerBoot;
try { boot = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SessionRunnerBoot; }
catch { throw new Error("session_runner_boot_invalid"); }
const containment = process.platform === "win32" ? createWindowsJobContainment(loadWindowsJobBindings(), () => { throw new Error("session_runner_containment_failed"); }) : undefined;
await runSessionRunner(boot, containment);
