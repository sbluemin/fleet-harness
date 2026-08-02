/**
 * ai-gateway/role-fit — measured suitability of a gateway model for a stage role.
 *
 * Constraints live in the catalog because a provider states them. Suitability is
 * a judgement Fleet formed by measurement, so it lives here: the catalog is
 * regenerated from provider APIs and would carry these away with it.
 *
 * Declarations are deliberately sparse. Measurement separated the models on two
 * axes only; on every other axis the models tested were indistinguishable.
 * Filling the rest would hand the host a confident-looking reason to pin a model
 * where none was earned, which is worse than declaring nothing — an undeclared
 * axis resolves to inherit, which is the correct default.
 *
 * Keyed by {@link gatewayModelIdentity}, so a fact measured about one entry
 * covers its service-tier siblings without being restated.
 */

/** Stage roles a measurement has actually separated models on. */
export type GatewayRoleAxis = "map" | "tokenEfficiency";

export interface GatewayRoleFitEntry {
  readonly fit: "fit" | "unfit";
  /** What was observed, concretely enough to be re-checked or overturned. */
  readonly evidence: string;
  /** ISO date of the observation, so a stale claim is visible as stale. */
  readonly measuredAt: string;
}

export type GatewayRoleFit = Readonly<Partial<Record<GatewayRoleAxis, GatewayRoleFitEntry>>>;

const ROLE_FIT: Readonly<Record<string, GatewayRoleFit>> = Object.freeze({
  "codex::gpt-5.6-sol": Object.freeze({
    map: Object.freeze({
      fit: "fit",
      evidence: "Opened all 22 files of a subsystem when asked to map it; kimi::k3 opened 16 and cursor::grok-4.5-fast 10 on the identical task.",
      measuredAt: "2026-08-02",
    }),
  }),
  "kimi::k3": Object.freeze({
    tokenEfficiency: Object.freeze({
      fit: "fit",
      evidence: "Completed an implementation task in 37k tokens over 20 tool calls that codex::gpt-5.6-sol completed in 172k over 38, at equal quality.",
      measuredAt: "2026-08-02",
    }),
  }),
});

/** Declared suitability for an upstream identity, or `undefined` when unmeasured. */
export function gatewayRoleFit(identity: string): GatewayRoleFit | undefined {
  return ROLE_FIT[identity];
}

/** Every identity carrying a declaration. Used to keep this table and the catalog in step. */
export function declaredRoleFitIdentities(): readonly string[] {
  return Object.freeze(Object.keys(ROLE_FIT));
}
