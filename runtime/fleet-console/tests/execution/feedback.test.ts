import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedbackStore } from "../../features/feedback/store.js";
import { feedbackToolSpec } from "../../features/feedback/tool.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const temporaryRoot = async () => { const root = await mkdtemp(join(tmpdir(), "fleet-feedback-test-")); roots.push(root); return root; };
const context = { sessionKey: "private-session-token", objectiveId: "objective-a", actor: "participant-a", fleetVersion: "1.315.0", helperVersion: 1, os: "macOS 26.5" };

it("stores a private ticket with safe frontmatter, recent result codes, and session-local sliding deduplication", async () => {
  const root = await temporaryRoot();
  let time = new Date("2026-11-22T07:40:12.345Z");
  const store = createFeedbackStore({ root, toolset: "computer-use", prefix: "CU", now: () => time });
  const fields = { tool: "computer_action", kind: "failure" as const, summary: "Paste # failed\n---", details: `first ${String.fromCharCode(27)}detail`, errorCode: "no_editable_focus" };
  const recentCalls = [{ tool: "older", code: "ok" }, { tool: "computer_apps", code: "ok" }, { tool: "computer_state", code: "ok" }, { tool: "computer_action", action: "paste", code: "not_sent:no_editable_focus" }, { tool: "computer_verify", code: "private body text" }, { tool: "computer_session", code: "ok" }];
  const first = await store.submit(fields, { ...context, recentCalls });
  expect(first).toEqual({ id: "CU-20261122-0001", occurrences: 1 });
  time = new Date("2026-11-22T07:48:12.345Z");
  const updates = await Promise.all([store.submit({ ...fields, details: "second" }, context), store.submit({ ...fields, details: "third" }, context)]);
  expect(updates).toEqual([{ ...first, occurrences: 2 }, { ...first, occurrences: 3 }]);
  const toolDir = join(root, "feedback", "computer-use");
  const file = join(toolDir, `${first.id}.md`);
  const ticket = await readFile(file, "utf8");
  expect(ticket).toContain("createdAt: 2026-11-22T07:40:12.345Z\nupdatedAt: 2026-11-22T07:48:12.345Z");
  expect(ticket).toContain("status: open\noccurrences: 3");
  expect(ticket).toContain('  - "computer_action paste not_sent:no_editable_focus"');
  expect(ticket).toContain("# Paste \\# failed \\-\\-\\-\n\nfirst detail\n\n---\n\nsecond\n\n---\n\nthird\n");
  for (const denied of ["private-session-token", "private body text", "older", String.fromCharCode(27)]) expect(ticket).not.toContain(denied);
  if (process.platform !== "win32") {
    expect((await stat(join(root, "feedback"))).mode & 0o777).toBe(0o700);
    expect((await stat(toolDir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  expect(await store.submit(fields, { ...context, sessionKey: "separate-session" })).toMatchObject({ id: "CU-20261122-0002", occurrences: 1 });
  time = new Date("2026-11-22T07:58:12.345Z");
  expect(await store.submit(fields, context)).toMatchObject({ id: "CU-20261122-0003", occurrences: 1 });
});

it("reuses the feedback contract for browser tools and does not overwrite a concurrent ticket", async () => {
  const root = await temporaryRoot();
  const now = () => new Date("2026-11-22T12:00:00Z");
  const browser = createFeedbackStore({ root, toolset: "browser-use", prefix: "BU", now });
  const secondBrowser = createFeedbackStore({ root, toolset: "browser-use", prefix: "BU", now });
  const computer = createFeedbackStore({ root, toolset: "computer-use", prefix: "CU", now });
  const spec = feedbackToolSpec({ toolset: "browser-use", tools: ["act", "report_feedback"], description: "Fixture description" });
  expect(spec.inputSchema.properties.tool.enum).toEqual(["act", "general"]);
  const input = { tool: "general", kind: "missing" as const, summary: "Fixture" };
  await Promise.all([browser.submit(input, context), secondBrowser.submit({ ...input, details: "another ticket" }, context), computer.submit(input, context)]);
  expect((await readdir(join(root, "feedback", "browser-use"))).sort()).toEqual(["BU-20261122-0001.md", "BU-20261122-0002.md"]);
  expect(await readdir(join(root, "feedback", "computer-use"))).toEqual(["CU-20261122-0001.md"]);
});
