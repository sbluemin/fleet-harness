import { SESSION_HOST_WIRE, SESSION_KEEPER_HEARTBEAT_MS, type SessionUpdateRef } from "@fleet-console/protocol/session-host";
import { connectSessionRpc } from "./rpc.js";
/** An updater keeps this private connection until the successor has attached or recovery has finished. */
export async function connectSessionUpdateKeeper(ref: SessionUpdateRef): Promise<{ close(): void }> {
  const peer = await connectSessionRpc(ref.host.socket);
  try {
    await peer.call("hello", { wire: SESSION_HOST_WIRE, role: "keeper", hostId: ref.host.hostId, updateId: ref.updateId, keeperCapability: ref.keeperCapability });
  } catch (error) { peer.close(); throw error; }
  const heartbeat = setInterval(() => { void peer.call("heartbeat", undefined, SESSION_KEEPER_HEARTBEAT_MS).catch(() => { clearInterval(heartbeat); peer.close(); }); }, SESSION_KEEPER_HEARTBEAT_MS);
  heartbeat.unref();
  return { close() { clearInterval(heartbeat); peer.close(); } };
}
