import crypto from "node:crypto";

import type {
  GatewayRegisterTenantRequest,
  GatewayRegisterTenantResponse,
  GatewayToolSnapshot,
} from "./api-types.js";

export type GatewayTokenKind = "control" | "session" | "observer";

export interface GatewayTenantRecord {
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly controlToken: string;
  readonly observerToken: string;
  readonly createdAt: number;
  readonly sessions: Map<string, GatewaySessionRecord>;
}

export interface GatewaySessionRecord {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly token: string;
  readonly tools: readonly GatewayToolSnapshot[];
  readonly createdAt: number;
}

export interface GatewayTokenLookup {
  readonly kind: GatewayTokenKind;
  readonly tenant: GatewayTenantRecord;
  readonly session?: GatewaySessionRecord;
}

export interface GatewayTenantStoreDeps {
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly randomToken?: () => string;
}

export interface GatewayTenantRelease {
  readonly tenantId: string;
  readonly sessionIds: readonly string[];
}

export function createGatewayTenantStore(deps: GatewayTenantStoreDeps = {}) {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const tenants = new Map<string, GatewayTenantRecord>();
  const tokens = new Map<string, GatewayTokenLookup>();

  function registerTenant(input: GatewayRegisterTenantRequest, endpoint: string): GatewayRegisterTenantResponse {
    const tenantId = randomId();
    const sessionId = randomId();
    const controlToken = randomToken();
    const sessionToken = randomToken();
    const observerToken = randomToken();
    const tenant: GatewayTenantRecord = {
      tenantId,
      tenantLabel: input.tenantLabel,
      cwd: input.cwd,
      controlToken,
      observerToken,
      createdAt: now(),
      sessions: new Map(),
    };
    const session: GatewaySessionRecord = {
      sessionId,
      tenantId,
      token: sessionToken,
      tools: input.tools.map(copyToolSnapshot),
      createdAt: now(),
    };
    tenant.sessions.set(sessionId, session);
    tenants.set(tenantId, tenant);
    tokens.set(controlToken, { kind: "control", tenant });
    tokens.set(observerToken, { kind: "observer", tenant });
    tokens.set(sessionToken, { kind: "session", tenant, session });
    return { tenantId, sessionId, endpoint, controlToken, sessionToken, observerToken };
  }

  function lookupToken(token: string): GatewayTokenLookup | null {
    return tokens.get(token) ?? null;
  }

  function releaseTenant(controlToken: string): GatewayTenantRelease | null {
    const lookup = tokens.get(controlToken);
    if (!lookup || lookup.kind !== "control") return null;
    const sessionIds = Array.from(lookup.tenant.sessions.keys());
    tenants.delete(lookup.tenant.tenantId);
    tokens.delete(lookup.tenant.controlToken);
    tokens.delete(lookup.tenant.observerToken);
    for (const session of lookup.tenant.sessions.values()) {
      tokens.delete(session.token);
    }
    lookup.tenant.sessions.clear();
    return { tenantId: lookup.tenant.tenantId, sessionIds };
  }

  function clear(): void {
    tenants.clear();
    tokens.clear();
  }

  return { registerTenant, lookupToken, releaseTenant, clear };
}

function copyToolSnapshot(tool: GatewayToolSnapshot): GatewayToolSnapshot {
  return JSON.parse(JSON.stringify(tool)) as GatewayToolSnapshot;
}
