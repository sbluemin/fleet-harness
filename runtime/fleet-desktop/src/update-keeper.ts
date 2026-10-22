import { connectSessionUpdateKeeper } from "@fleet-console/lifecycle";
import type { SessionUpdateRef } from "@fleet-console/protocol/lifecycle";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Heartbeat-only helper survives the old Electron process; it owns no agent or product state. */
async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("desktop_keeper_boot_limit");
  }
  const ref = JSON.parse(text) as SessionUpdateRef;
  text = "";
  if (!Number.isFinite(ref.expiresAt) || ref.expiresAt <= Date.now()) throw new Error("desktop_keeper_expired");
  const keeper = await connectSessionUpdateKeeper(ref);
  const timeout = setTimeout(() => keeper.close(), Math.max(1, ref.expiresAt - Date.now())); timeout.unref();
  process.on("message", (message) => { if (message === "cancel") { keeper.close(); clearTimeout(timeout); } });
  process.once("SIGTERM", () => { keeper.close(); clearTimeout(timeout); });
  process.once("SIGINT", () => { keeper.close(); clearTimeout(timeout); });
  process.stdout.write("ready\n");
  // Parent disconnection is expected after commit. A connected IPC channel must not keep the helper alive.
  process.channel?.unref();
  process.once("beforeExit", () => {
    const own = fileURLToPath(import.meta.url);
    const dir = path.dirname(own);
    if (path.basename(dir).startsWith(".session-keeper-") && path.basename(own) === "update-keeper.mjs") void fs.rm(dir, { recursive: true, force: true });
  });
}
void main().catch(() => { process.exitCode = 1; });
