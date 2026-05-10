import { afterEach, describe, expect, it } from "vitest";
import {
	getOAuthProvider,
	getOAuthProviders,
	registerOAuthProvider,
	resetOAuthProviders,
	unregisterOAuthProvider,
} from "../src/oauth.js";
import type { OAuthProviderInterface } from "../src/utils/oauth/types.js";

const testProvider: OAuthProviderInterface = {
	id: "test-oauth",
	name: "Test OAuth",
	async login() {
		return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
	},
	async refreshToken(credentials) {
		return credentials;
	},
	getApiKey(credentials) {
		return String(credentials.access);
	},
};

describe("oauth registry", () => {
	afterEach(() => {
		unregisterOAuthProvider(testProvider.id);
		resetOAuthProviders();
	});

	it("starts empty and supports explicit registration", () => {
		resetOAuthProviders();
		expect(getOAuthProviders()).toEqual([]);

		registerOAuthProvider(testProvider);
		expect(getOAuthProvider(testProvider.id)).toBe(testProvider);

		unregisterOAuthProvider(testProvider.id);
		expect(getOAuthProvider(testProvider.id)).toBeUndefined();
		expect(getOAuthProviders()).toEqual([]);
	});
});
