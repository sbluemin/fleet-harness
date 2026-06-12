import type http from "node:http";

import type { createGatewayObservabilityStore } from "./observability-store.js";
import { withSecurityHeaders } from "./security-headers.js";
import type { GatewayTenantRecord } from "./tenant-store.js";

type TenantResolver = (tenantId: string) => GatewayTenantRecord | null;

interface AggregateObserverEventsOptions {
  readonly subscribeAll?: boolean;
}

export function writeObserverEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tenant: GatewayTenantRecord,
  store: ReturnType<typeof createGatewayObservabilityStore>,
): void {
  res.writeHead(200, withSecurityHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  }));
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

export function writeAggregateObserverEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tenants: readonly GatewayTenantRecord[],
  store: ReturnType<typeof createGatewayObservabilityStore>,
  resolveTenant: TenantResolver,
  options: AggregateObserverEventsOptions = {},
): void {
  res.writeHead(200, withSecurityHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  }));
  res.write(": connected\n\n");
  for (const tenant of tenants) {
    for (const event of store.listEvents(tenant.tenantId)) {
      writeEvent(res, event.id, event.type, { tenant: tenantSnapshot(tenant), event });
    }
    const truncation = store.getTruncation(tenant.tenantId);
    if (truncation.droppedCount > 0) {
      writeEvent(res, 0, "observer:truncated", { tenant: tenantSnapshot(tenant), truncation });
    }
  }
  const unsubscribers = options.subscribeAll
    ? [
      store.subscribeAll((event) => {
        writeEvent(res, event.id, event.type, { tenant: resolvedTenantSnapshot(resolveTenant, event.tenantId), event });
      }),
    ]
    : tenants.map((tenant) =>
      store.subscribe(tenant.tenantId, (event) => {
        writeEvent(res, event.id, event.type, { tenant: tenantSnapshot(tenant), event });
      }),
    );
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(keepalive);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });
}

function writeEvent(res: http.ServerResponse, id: number, event: string, data: unknown): void {
  if (id > 0) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function tenantSnapshot(tenant: GatewayTenantRecord) {
  return {
    tenantId: tenant.tenantId,
    tenantLabel: tenant.tenantLabel,
  };
}

function resolvedTenantSnapshot(resolveTenant: TenantResolver, tenantId: string) {
  const tenant = resolveTenant(tenantId);
  if (tenant) return tenantSnapshot(tenant);
  return {
    tenantId,
    tenantLabel: tenantId,
  };
}
