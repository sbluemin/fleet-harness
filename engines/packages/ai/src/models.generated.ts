import type { Api, Model } from "./types.js";

/**
 * Canonical zero-model steady state for stripped fleet-ai.
 * External hosts/extensions may register models elsewhere; built-in models remain empty.
 */
export const MODELS: Record<string, Record<string, Model<Api>>> = {};
