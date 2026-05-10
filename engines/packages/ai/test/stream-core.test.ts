import { afterEach, describe, expect, it } from "vitest";
import { clearApiProviders, getApiProviders, hasApiProvider } from "../src/api-registry.js";
import { getSupportedThinkingLevels } from "../src/models.js";
import { adjustMaxTokensForThinking, clampReasoning } from "../src/providers/simple-options.js";
import { complete, completeSimple } from "../src/stream.js";
import { fauxAssistantMessage, registerFauxProvider } from "../src/index.js";
import type { Context, Model } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("stream core", () => {
	afterEach(() => {
		clearApiProviders();
	});

	it("starts with zero registered providers", () => {
		expect(getApiProviders()).toEqual([]);
		expect(hasApiProvider("test-api")).toBe(false);
	});

	it("throws when no provider is registered", async () => {
		const model: Model<"test-api"> = {
			id: "test-model",
			name: "Test Model",
			api: "test-api",
			provider: "test-provider",
			baseUrl: "http://localhost",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 128,
		};

		await expect(complete(model, context)).rejects.toThrow("No API provider registered for api: test-api");
		await expect(completeSimple(model, context)).rejects.toThrow("No API provider registered for api: test-api");
	});

	it("supports explicit provider registration without built-ins", async () => {
		const registration = registerFauxProvider({ api: "test-api", provider: "test-provider" });
		registration.setResponses([fauxAssistantMessage("ok")]);

		const response = await complete(registration.getModel(), context);
		expect(response.content).toEqual([{ type: "text", text: "ok" }]);
		expect(getApiProviders()).toHaveLength(1);
		expect(hasApiProvider("test-api")).toBe(true);
	});

	it("gates xhigh and max thinking levels behind explicit model metadata", () => {
		const model: Model<"test-api"> = {
			id: "test-model",
			name: "Test Model",
			api: "test-api",
			provider: "test-provider",
			baseUrl: "http://localhost",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 128,
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high"]);

		model.thinkingLevelMap = { xhigh: "xhigh", max: "max" };
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);

		model.thinkingLevelMap = { xhigh: null, max: null };
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high"]);
	});

	it("normalizes max provider effort while preserving the max thinking budget", () => {
		expect(clampReasoning("max")).toBe("high");
		expect(adjustMaxTokensForThinking(4096, 65536, "max")).toEqual({
			maxTokens: 36864,
			thinkingBudget: 32768,
		});
	});

	it("clearApiProviders removes explicit registrations", () => {
		registerFauxProvider({ api: "test-api", provider: "test-provider" });
		expect(getApiProviders()).toHaveLength(1);

		clearApiProviders();
		expect(getApiProviders()).toEqual([]);
	});
});
