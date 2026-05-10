import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { Message, Model } from "../src/types.js";

const nonVisionModel: Model<"test-api"> = {
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

describe("transformMessages", () => {
	it("downgrades unsupported images to placeholders", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "image", mimeType: "image/png", data: "abcd" },
					{ type: "text", text: "hello" },
				],
				timestamp: 1,
			},
		];

		expect(transformMessages(messages, nonVisionModel)).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "(image omitted: model does not support images)" },
					{ type: "text", text: "hello" },
				],
				timestamp: 1,
			},
		]);
	});

	it("inserts synthetic tool results for orphaned tool calls", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { text: "hello" } }],
				api: "other-api",
				provider: "other-provider",
				model: "other-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{ role: "user", content: "continue", timestamp: 2 },
		];

		expect(transformMessages(messages, nonVisionModel)).toEqual([
			messages[0],
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "echo",
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: expect.any(Number),
			},
			messages[1],
		]);
	});
});
