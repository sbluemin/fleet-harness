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
 * where none was earned, which is worse than declaring nothing.
 *
 * An undeclared axis is a statement about quality, not about cost: it means no
 * measurement has told these models apart on that role. The choice then falls to
 * the allowances in `gateway_models`, never to whichever model the session itself
 * happens to be running on.
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
      evidence: "Opened all 22 files of a subsystem when asked to map it; kimi::k3 opened 16 and cursor::grok-4.5-fast 10 on the identical task. A 12-file remap separated nobody — all 12 identities tested answered it fully, so this holds for large maps only.",
      measuredAt: "2026-08-02",
    }),
    tokenEfficiency: Object.freeze({
      fit: "unfit",
      evidence: "Spent 5.20M total tokens over 29 tool calls mapping 12 files, an answer kimi::k3-256k produced identically on 176k over 5 calls — 29x the spend for no measured quality gain.",
      measuredAt: "2026-08-02",
    }),
  }),
  "codex::gpt-5.6-terra": Object.freeze({
    tokenEfficiency: Object.freeze({
      fit: "unfit",
      evidence: "Spent 2.69M total tokens over 28 tool calls on the 12-file map that kimi::k3-256k answered identically on 176k over 5; its 20.3k output tokens against 1.7k rules out cache-read inflation.",
      measuredAt: "2026-08-02",
    }),
  }),
  "codex::gpt-5.6-luna": Object.freeze({
    tokenEfficiency: Object.freeze({
      fit: "unfit",
      evidence: "Took 47 tool calls, the most of 12 identities measured, and 3.54M total tokens on the 12-file map that kimi::k3-256k completed correctly in 5 calls and 176k.",
      measuredAt: "2026-08-02",
    }),
  }),
  "kimi::k3": Object.freeze({
    tokenEfficiency: Object.freeze({
      fit: "fit",
      evidence: "Completed an implementation task in 37k tokens over 20 tool calls that codex::gpt-5.6-sol completed in 172k over 38; on a later 12-file map it used 472k over 15 against sol's 5.20M over 29, both at equal quality.",
      measuredAt: "2026-08-02",
    }),
  }),
  "kimi::k3-256k": Object.freeze({
    tokenEfficiency: Object.freeze({
      fit: "fit",
      evidence: "Cheapest of 12 identities on an identical 12-file map: 176k total tokens and 1.7k output over 5 tool calls, fully correct, against codex::gpt-5.6-sol's 5.20M over 29.",
      measuredAt: "2026-08-02",
    }),
  }),
  "cursor::kimi-k3": Object.freeze({
    tokenEfficiency: Object.freeze({
      fit: "fit",
      evidence: "Mapped 12 files fully correctly on 262k total tokens over 8 tool calls, against codex::gpt-5.6-sol's 5.20M over 29 for the same answer.",
      measuredAt: "2026-08-02",
    }),
  }),
  "cursor::kimi-k3-max": Object.freeze({
    tokenEfficiency: Object.freeze({
      fit: "fit",
      evidence: "Mapped 12 files fully correctly on 291k total tokens over 9 tool calls, reaching line counts with wc -l rather than opening every file; codex::gpt-5.6-sol spent 5.20M over 29 for the same answer.",
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
