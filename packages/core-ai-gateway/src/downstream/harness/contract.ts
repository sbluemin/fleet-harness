import type {
  AnthropicMessagesRequest,
  UsageProjection,
} from "../wire/anthropic-messages/protocol.js";
import type { GatewayModel, GatewayModelLookup } from "../../models.js";

/**
 * One client's answer to "what does an agent CLI need from this gateway".
 *
 * The router serves whatever a harness declares here; it holds no client condition of
 * its own. Every field below was a Claude Code assumption written inline in `router.ts`
 * until a second harness had to state a different answer for it.
 *
 * A harness declares a `wire` rather than implementing one: two clients that speak the
 * same inbound protocol (Claude Code, and Grok Build with `api_backend = "messages"`)
 * share `downstream/wire/`, and differ only in the fields on this profile.
 */
export interface GatewayHarnessProfile {
  /** Stable id for logs and diagnostics. Never a wire value. */
  readonly id: string;
  /** The inbound protocol this client speaks. */
  readonly wire: GatewayHarnessWire;
  /**
   * Paths this client dials before its first turn, matched as a suffix of the mounted
   * route. Empty means the client opens with its first real request.
   */
  readonly probePaths: readonly string[];
  /**
   * Whether a credential the caller presented is one this harness is expected to send.
   *
   * The gateway spends its own subscriptions and never reads the value, so this is a
   * shape test, not authentication — but a client that sends nothing recognizable is
   * refused rather than silently billed to someone's account.
   */
  readonly acceptsCredential: (credential: string) => boolean;
  /** The catalog entry a caller's model string names, in this client's id grammar. */
  readonly findModel: GatewayModelLookup;
  /** The discovery payload this client reads, over the models the user exposed. */
  readonly buildModelList: (models: readonly GatewayModel[]) => unknown;
  /**
   * Rewrites that must reach every request, gateway target or native passthrough alike.
   *
   * A rewrite that must NOT reach the passthrough belongs in a provider's request policy
   * instead — that seam is the only one native traffic never enters.
   */
  readonly sanitizeRequest: (request: AnthropicMessagesRequest) => AnthropicMessagesRequest;
  /**
   * How this client meters context occupancy, given the user's compact-timing setting.
   *
   * Absent means the client reads the provider's real numbers and needs no map. A client
   * that knows only its own fixed coordinates returns one here.
   */
  readonly usageProjection?: (compactCeiling: CompactCeilingSetting) => UsageProjection | undefined;
  /**
   * How this client meters a passthrough turn, whose body is the provider's own bytes.
   *
   * Separate from `usageProjection` because the two paths hold different things: the
   * translated path maps a number the wire is about to encode, while this one rewrites
   * an already-encoded SSE or JSON body. Absent relays the provider's bytes untouched.
   */
  readonly passthroughProjection?: (
    compactCeiling: CompactCeilingSetting,
  ) => PassthroughBodyProjection | undefined;
  /**
   * Lift an upstream refusal onto a status this client's retry budget acts on.
   *
   * Absent forwards the upstream status unchanged.
   */
  readonly retryableStatus?: (status: number) => number;
  /** The status that carries a gateway-side fault this client should retry. */
  readonly transientErrorStatus: number;
}

/**
 * A rewrite of a passthrough response body, applied between the upstream bytes and
 * the client. `contentType` decides which encoding is being rewritten; a projection
 * that does not recognize it must relay the bytes unchanged.
 */
export type PassthroughBodyProjection = (
  chunks: AsyncIterable<Uint8Array>,
  options: {
    readonly contentType: string | null;
    readonly contextWindow?: number;
    readonly responseModel?: string;
  },
) => AsyncIterable<Uint8Array>;

/** The inbound protocols `downstream/wire/` implements. */
export type GatewayHarnessWire = "anthropic-messages";

/**
 * The compact-timing value a harness profile is handed.
 *
 * Typed structurally so the contract stays free of any one harness's vocabulary: the
 * profile that understands the setting is the one that receives it.
 */
export type CompactCeilingSetting = "early" | "late" | number | undefined;
