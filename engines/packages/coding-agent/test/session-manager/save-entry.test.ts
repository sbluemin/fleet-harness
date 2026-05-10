import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.js";

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});

	it("does not duplicate the header or pre-assistant custom entry after flush", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "session-manager-save-entry-"));

		try {
			const session = SessionManager.create(process.cwd(), sessionDir);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			session.appendCustomEntry("checkpoint", { value: 1 });
			session.flush();
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});

			const lines = readFileSync(sessionFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));

			expect(lines.filter((line) => line.type === "session")).toHaveLength(1);
			expect(lines.filter((line) => line.type === "custom" && line.customType === "checkpoint")).toHaveLength(1);
			expect(lines.filter((line) => line.type === "message" && line.message.role === "assistant")).toHaveLength(1);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("persists new pre-assistant custom entries after flush", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "session-manager-save-entry-"));

		try {
			const session = SessionManager.create(process.cwd(), sessionDir);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			session.appendCustomEntry("checkpoint", { value: 1 });
			session.flush();
			session.appendCustomEntry("after_flush", { value: 2 });

			const lines = readFileSync(sessionFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));

			expect(lines.filter((line) => line.type === "session")).toHaveLength(1);
			expect(lines.filter((line) => line.type === "custom" && line.customType === "checkpoint")).toHaveLength(1);
			expect(lines.filter((line) => line.type === "custom" && line.customType === "after_flush")).toHaveLength(1);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
