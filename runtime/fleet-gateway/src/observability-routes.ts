import type http from "node:http";

import type { createGatewayObservabilityStore } from "./observability-store.js";
import type { GatewayTenantRecord } from "./tenant-store.js";

export function writeObserverEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tenant: GatewayTenantRecord,
  store: ReturnType<typeof createGatewayObservabilityStore>,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  for (const event of store.listEvents(tenant.tenantId)) {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  const unsubscribe = store.subscribe(tenant.tenantId, (event) => {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  req.on("close", unsubscribe);
}
