import { disconnect, listActivePoolKeys } from "@dotobokuri/core-agent";

import { matchesCarrierPoolKey } from "../dispatch/pool-key.js";

export async function disconnectCarrierExecutorPools(carrierId: string): Promise<void> {
  const poolKeys = new Set(listActivePoolKeys().filter((poolKey) => matchesCarrierPoolKey(poolKey, carrierId)));
  poolKeys.add(carrierId);
  await Promise.all([...poolKeys].map((poolKey) => disconnect(poolKey)));
}
