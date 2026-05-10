import { clearApiProviders } from "../api-registry.js";

/**
 * Intentional no-op extension seam.
 * Zero built-in API providers is the canonical steady state after strip.
 * Automatic provider registration is forbidden; hosts must register providers explicitly.
 */
export function registerBuiltInApiProviders(): void {}

/**
 * Reset returns the registry to the canonical zero-provider steady state.
 */
export function resetApiProviders(): void {
	clearApiProviders();
}
