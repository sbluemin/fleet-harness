import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { observeConsoleLockFile, type ConsoleLockFilePayload } from "@fleet-console/lifecycle";
import { DESKTOP_SESSION_UPDATE_PATH, DESKTOP_SESSION_UPDATE_OWNER_HEADER, type ConsoleOwnerMetadata, type DesktopSessionUpdatePrepared } from "@fleet-console/protocol/desktop";

/** A native-only request: neither the control token nor the keeper ref reaches a renderer. */
export async function prepareDesktopSessionUpdate(options: { lockFile: string; ownerId: string; helperRoot: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const observed = observeConsoleLockFile<ConsoleLockFilePayload & { owner?: ConsoleOwnerMetadata }>(options.lockFile);
  if (observed.kind !== "owner" || !observed.alive || observed.untrusted || observed.instance.payload.owner?.kind !== "desktop" || observed.instance.payload.owner.id !== options.ownerId) throw new Error("desktop_update_owner_unverified");
  const lock = observed.instance.payload;
  const updateId = randomUUID();
  const request = async <T>(intent: "prepare" | "commit" | "cancel"): Promise<T> => {
    const response = await fetch(new URL(DESKTOP_SESSION_UPDATE_PATH, lock.endpoint), { method: "POST", headers: { Authorization: `Bearer ${lock.token}`, [DESKTOP_SESSION_UPDATE_OWNER_HEADER]: options.ownerId, "content-type": "application/json" }, body: JSON.stringify({ intent, updateId }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: string } | null;
      if (response.status === 409 && failure?.error === "session_business_pending") throw new Error("session_business_pending");
      throw new Error(`desktop_update_handoff_${response.status}`);
    }
    return response.json() as Promise<T>;
  };
  const prepared = await request<DesktopSessionUpdatePrepared>("prepare");
  if (prepared.ref === null) {
    try { await request("commit"); }
    catch (error) { await request("cancel").catch(() => undefined); throw error; }
    return;
  }
  let dir: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await fs.mkdir(options.helperRoot, { recursive: true, mode: 0o700 });
    dir = await fs.mkdtemp(path.join(options.helperRoot, ".session-keeper-"));
    if (!path.isAbsolute(prepared.nodePath)) throw new Error("desktop_keeper_node_invalid");
    const entry = path.join(dir, "update-keeper.mjs");
    await fs.writeFile(entry, await fs.readFile(new URL("./update-keeper.mjs", import.meta.url)), { mode: 0o600, flag: "wx" });
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "PATH"]) if (options.env[name]) env[name] = options.env[name];
    child = spawn(prepared.nodePath, [entry], { cwd: dir, env, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore", "ipc"] });
    const keeper = child;
    await new Promise<void>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => finish(new Error("desktop_keeper_start_timeout")), 15_000);
      const finish = (error?: Error) => {
        clearTimeout(timer); keeper.removeListener("error", onError); keeper.removeListener("exit", onExit); keeper.stdout!.removeListener("data", onData);
        if (error) reject(error); else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error("desktop_keeper_exited"));
      const onData = (chunk: Buffer) => { text += chunk.toString(); if (text === "ready\n") finish(); else if (text.length > 64) finish(new Error("desktop_keeper_reply_invalid")); };
      keeper.once("error", onError); keeper.once("exit", onExit); keeper.stdout!.on("data", onData);
      keeper.stdin!.end(JSON.stringify(prepared.ref));
    });
    await request("commit");
    child.stdout?.destroy(); child.disconnect(); child.unref();
  } catch (error) {
    // The helper has heartbeat-only rights. Cancellation is still decided by the original Console owner.
    await request("cancel").catch(() => undefined);
    child?.kill("SIGTERM");
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
