/**
 * OAuth credential management for AI providers.
 *
 * This module preserves the registry abstraction only.
 * Built-in OAuth provider registration is intentionally empty.
 */

import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.js";

export * from "./types.js";

/**
 * Canonical zero-OAuth-provider steady state for stripped fleet-ai.
 * External hosts/extensions may register providers explicitly.
 */
const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [];
const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((provider) => ({
		id: provider.id,
		name: provider.name,
		available: true,
	}));
}

export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return provider.refreshToken(credentials);
}

export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let providerCredentials = credentials[providerId];
	if (!providerCredentials) {
		return null;
	}

	if (Date.now() >= providerCredentials.expires) {
		try {
			providerCredentials = await provider.refreshToken(providerCredentials);
		} catch {
			throw new Error(`Failed to refresh OAuth token for ${providerId}`);
		}
	}

	return {
		newCredentials: providerCredentials,
		apiKey: provider.getApiKey(providerCredentials),
	};
}
