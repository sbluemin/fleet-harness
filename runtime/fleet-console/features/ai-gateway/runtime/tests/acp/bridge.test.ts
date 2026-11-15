import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createAgyAcpBridge, createAgyAcpSessionPort, type AgyAcpBridge } from "../../src/acp/index.js";
import type { CanonicalInputItem, CanonicalResponseEvent, CanonicalResponseRequest } from "../../src/canonical/index.js";
import { collectAnthropicMessage } from "../../src/downstream/wire/anthropic-messages/protocol.js";
import { wireLogFixture } from "../helpers/wire-log.js";

const fakeAgy = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agy.mjs");
const MODEL = "antigravity--gemini-4-argon";
const roots: string[] = [];
const bridges: AgyAcpBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(bridgeOptions: { replayBudgetChars?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-bridge-test-"));
  roots.push(root);
  const logPath = path.join(root, "fake.log");
  const port = createAgyAcpSessionPort({
    sessionsDir: path.join(root, "sessions"),
    command: process.execPath,
    commandArgs: [fakeAgy],
    env: { ...process.env, FAKE_LOG: logPath, FAKE_BRIDGE: "1" },
  });
  const bridge = createAgyAcpBridge({ port, coalesceMs: 10, silenceMs: 5_000, ...bridgeOptions });
  bridges.push(bridge);
  const log = async () => (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { bridge, log };
}

const BASH = { type: "function" as const, name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } } } };
const user = (text: string): CanonicalInputItem => ({ type: "message", role: "user", content: text });
const assistant = (text: string): CanonicalInputItem => ({ type: "message", role: "assistant", content: text });
const call = (id: string, args: object): CanonicalInputItem => ({ type: "function_call", call_id: id, name: "Bash", arguments: JSON.stringify(args) });
const result = (id: string, output: string): CanonicalInputItem => ({ type: "function_call_output", call_id: id, output });

async function turn(bridge: AgyAcpBridge, input: CanonicalInputItem[], instructions = "be brief") {
  const request: CanonicalResponseRequest = { model: MODEL, input, instructions, tools: [BASH], stream: true };
  const response = await bridge.stream(request, { apiKey: "" });
  if (!response.ok) throw new Error(`bridge refused with ${response.status}`);
  const events: CanonicalResponseEvent[] = [];
  for await (const event of response.events) events.push(event);
  const collected = await collectAnthropicMessage((async function* () { yield* events; })(), MODEL, { model: MODEL }).catch(() => undefined);
  const message = (collected ?? { content: [], stop_reason: "failed" }) as { content: { type: string; text?: string }[]; stop_reason: string };
  return { events, message };
}

const toolUse = (message: { content: readonly { type: string }[] }) => message.content.find((block) => block.type === "tool_use") as unknown as { id: string; name: string; input: unknown };
const textOf = (message: { content: readonly { type: string; text?: string }[] }) => message.content.map((block) => block.text ?? "").join("");
const count = (entries: readonly Record<string, unknown>[], method: string) => entries.filter((entry) => entry.method === method).length;

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached");
}

describe("agy ACP bridge", () => {
  it("drops the header and identity Claude Code puts first in system and keeps the Fleet instruction", async () => {
    const { bridge, log } = await setup();
    const header = "x-anthropic-billing-header: cc_version=2.1.325.ff3; cc_entrypoint=sdk-cli;";
    const identity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
    await turn(bridge, [user("hi")], [header, identity, "FLEET: you are a member"].join("\n\n"));
    const opened = (await log()).find((entry) => entry.method === "session/new") as { params: { _meta: { antigravity: { systemPrompt: { append: string } } } } };
    const append = opened.params._meta.antigravity.systemPrompt.append;
    expect(append).toContain("FLEET: you are a member");
    expect(append).not.toContain("x-anthropic-billing-header");
    expect(append).not.toContain("You are a Claude agent");
  });

  it("ends a response with tool_use, resumes the same agy prompt on the tool_result, then takes a new turn on the same session", async () => {
    const { bridge, log } = await setup();
    const first = await turn(bridge, [user('TOOL:Bash:{"command":"ls"}')]);
    expect(first.message.stop_reason).toBe("tool_use");
    const use = toolUse(first.message);
    expect(use).toMatchObject({ name: "Bash", input: { command: "ls" } });

    const history: CanonicalInputItem[] = [user('TOOL:Bash:{"command":"ls"}'), call(use.id, { command: "ls" }), result(use.id, "a.txt")];
    const second = await turn(bridge, history);
    expect(second.message.stop_reason).toBe("end_turn");
    expect(textOf(second.message)).toBe("got:a.txt");

    const third = await turn(bridge, [...history, assistant("got:a.txt"), user("hello")]);
    expect(textOf(third.message)).toContain("echo:hello history:no");

    const entries = await log();
    // One agy child, one prompt for the tool turn (the tool_result resolved the held MCP call, it was not a second prompt), one for the new turn.
    expect(entries.filter((entry) => Array.isArray(entry.argv))).toHaveLength(1);
    expect(count(entries, "session/new")).toBe(1);
    expect(entries.filter((entry) => typeof entry.prompt === "string")).toHaveLength(2);
    // agy sees built-in tools removed: a custom agent, no skip-permissions flag, and the bridge's tools as eager MCP tools with a long call deadline.
    const argv = entries[0]!.argv as string[];
    expect(argv).toContain("--agent");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(entries.find((entry) => entry.mcpTools)).toMatchObject({ mcpTools: ["Bash"], eager: ["Bash"], timeoutSeconds: 3600 });
  });

  it("opens a new session and replays the history when the history no longer matches the session, and logs only counts of the tail", async () => {
    const wire = wireLogFixture("fleet-bridge-wire-");
    try {
      const { bridge, log } = await setup();
      const first = await turn(bridge, [user('TOOL:Bash:{"command":"ls"}')]);
      const use = toolUse(first.message);
      // Claude Code rewrote an earlier message (compaction, rewind): the chain no longer matches the held session.
      const second = await turn(bridge, [
        user("compacted summary"), call(use.id, { command: "ls" }), result(use.id, "a.txt"),
        user("<system-reminder>SECRET-REMINDER</system-reminder>"),
      ]);
      expect(second.message.stop_reason).toBe("end_turn");
      expect(textOf(second.message)).toContain("history:yes");
      const entries = await log();
      expect(count(entries, "session/new")).toBe(2);
      const replay = entries.filter((entry) => typeof entry.prompt === "string").at(-1)!.prompt as string;
      expect(replay).toContain('<turn role="user">compacted summary</turn>');
      expect(replay).toContain('<tool_result tool_use_id="' + use.id + '">a.txt</tool_result>');
      // The wire log counts what rides next to the tool results; it never records their content.
      const requests = wire.read().filter((entry) => entry.event === "bridge.request").map((entry) => entry.payload);
      expect(requests[0]).toMatchObject({ route: "fresh", tailToolResults: 0, tailUserTexts: 0, tailReminderTexts: 0 });
      expect(requests[1]).toMatchObject({ route: "rebuild", tailToolResults: 1, tailUserTexts: 1, tailReminderTexts: 1 });
      expect(JSON.stringify(requests)).not.toContain("SECRET-REMINDER");
    } finally {
      wire.cleanup();
    }
  });

  it("keeps call/result pairs, roles and the latest user instruction when the replayed history exceeds its budget", async () => {
    const { bridge, log } = await setup({ replayBudgetChars: 600 });
    const long = "x".repeat(3_000);
    // A tool loop is in progress: the newest user instruction is inside the history, followed by one call/result pair.
    await turn(bridge, [
      user("first goal"),
      call("c1", { command: "old" }), result("c1", long), assistant("ok1"),
      user("LATEST: finish the migration"),
      call("c2", { command: "new" }), result("c2", long),
    ]);
    const replay = (await log()).filter((entry) => typeof entry.prompt === "string").at(-1)!.prompt as string;
    // The oldest exchange left as a pair (call and result together), and the omission is marked outside any turn.
    expect(replay).toContain("[2 earlier turns omitted]");
    expect(replay).not.toContain('id="c1"');
    expect(replay).not.toContain('tool_use_id="c1"');
    // The in-progress pair stays together with its (clipped, marked) result, and nothing is spoken as another role.
    expect(replay).toContain('<tool_use id="c2" name="Bash">');
    expect(replay).toMatch(/<tool_result tool_use_id="c2" truncated="true">/);
    expect(replay).toContain('<turn role="user">LATEST: finish the migration</turn>');
    expect(replay.match(/<turn role="user">/g)).toHaveLength(3);
    expect(replay.match(/<turn role="assistant">/g)).toHaveLength(2);
    expect(replay.trimEnd().endsWith("Continue from the latest turn above.")).toBe(true);
  });

  it("recovers by replay after agy gives up on a held tool call, and never lets the abandoned session's output out", async () => {
    const { bridge, log } = await setup();
    const first = await turn(bridge, [user("TIMEOUT:Bash")]);
    const use = toolUse(first.message);
    await until(async () => (await log()).some((entry) => entry.terminated === true));
    const second = await turn(bridge, [user("TIMEOUT:Bash"), call(use.id, {}), result(use.id, "late result")]);
    expect(textOf(second.message)).toContain("history:yes");
    expect(textOf(first.message) + textOf(second.message)).not.toContain("timed out after 3 minutes");
    expect(count(await log(), "session/new")).toBe(2);
  });

  it("ends the turn as a rate_limit_error instead of forwarding agy's upstream retry notices as model output", async () => {
    const { bridge, log } = await setup();
    const response = await bridge.stream({ model: MODEL, input: [user("UPSTREAM429")], instructions: "be brief", tools: [BASH], stream: true }, { apiKey: "" });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.status).toBe(429);
    const body = JSON.parse(new TextDecoder().decode(response.body)) as { type: string; error: { type: string; message: string } };
    expect(body).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(body.error.message).toContain("RESOURCE_EXHAUSTED");
    expect(JSON.stringify(body)).not.toContain("NOT-A-REAL-ANSWER");
    // agy's own retries are not waited for: the prompt is cancelled and the child ended.
    await until(async () => (await log()).some((entry) => entry.terminated === true));
  });

  it("denies built-in tools and fails the turn if one runs anyway", async () => {
    const { bridge, log } = await setup();
    const { events } = await turn(bridge, [user("BUILTIN")]);
    expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { error: { type: "api_error" } } });
    const entries = await log();
    expect(entries.find((entry) => entry.permission === "Run run_command")).toMatchObject({ outcome: { optionId: "deny" } });
    await until(async () => (await log()).some((entry) => entry.terminated === true));
  });
});
