import { SESSION_ATTACH_POLL_MS, SESSION_HOST_WIRE, SESSION_HOST_START_MS } from "@fleet-console/protocol/session-host";
import { isPidAlive } from "../process.js";
import { readSessionHostManifest } from "./files.js";
import { authenticateSessionPeer } from "./auth.js";
import { connectSessionRpc } from "./rpc.js";

/** Explicit stop also reaches a live host during the update interval with no Console lock. */
export async function terminateSessionHost(dataDir: string): Promise<boolean> {
  const manifest = readSessionHostManifest(dataDir);
  if (!manifest || !isPidAlive(manifest.pid)) return false;
  const peer = await connectSessionRpc(manifest.socket);
  try {
    await authenticateSessionPeer(peer, { wire: SESSION_HOST_WIRE, role: "control", hostId: manifest.hostId }, manifest.capability);
    await peer.call("terminate-all");
    const until = performance.now() + SESSION_HOST_START_MS;
    while (isPidAlive(manifest.pid) && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, SESSION_ATTACH_POLL_MS));
    if (isPidAlive(manifest.pid)) throw new Error("session_host_stop_incomplete");
    return true;
  } finally { peer.close(); }
}
