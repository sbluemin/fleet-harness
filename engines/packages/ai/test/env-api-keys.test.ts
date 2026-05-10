import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getApiKeyEnvVars, getEnvApiKey, setProviderEnvKey } from "../src/env-api-keys.js";

const TEST_PROVIDER = "test-provider";
const TEST_ENV_KEY = "FLEET_AI_TEST_API_KEY";

describe("env api key registry", () => {
	afterEach(() => {
		delete process.env[TEST_ENV_KEY];
		setProviderEnvKey(TEST_PROVIDER, []);
	});

	it("returns no mapping by default", () => {
		expect(getApiKeyEnvVars(TEST_PROVIDER)).toBeUndefined();
		expect(findEnvKeys(TEST_PROVIDER)).toBeUndefined();
		expect(getEnvApiKey(TEST_PROVIDER)).toBeUndefined();
	});

	it("resolves explicitly registered env keys", () => {
		process.env[TEST_ENV_KEY] = "secret";
		setProviderEnvKey(TEST_PROVIDER, TEST_ENV_KEY);

		expect(getApiKeyEnvVars(TEST_PROVIDER)).toEqual([TEST_ENV_KEY]);
		expect(findEnvKeys(TEST_PROVIDER)).toEqual([TEST_ENV_KEY]);
		expect(getEnvApiKey(TEST_PROVIDER)).toBe("secret");
	});
});
