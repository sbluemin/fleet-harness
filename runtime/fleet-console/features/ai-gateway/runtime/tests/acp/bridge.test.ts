import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createAgyAcpBridge, createAgyAcpSessionPort, type AcpSession, type AcpSessionPort, type AgyAcpBridge } from "../../src/acp/index.js";
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

// A count whose targets the test awaits: it settles on what happened, never on elapsed time.
function counter() {
  let value = 0;
  const waiters: { target: number; resolve: () => void }[] = [];
  return {
    get value() { return value; },
    bump() {
      value += 1;
      for (const waiter of waiters.filter((entry) => value >= entry.target)) waiter.resolve();
    },
    reach(target: number): Promise<void> {
      return value >= target ? Promise.resolve() : new Promise((resolve) => waiters.push({ target, resolve }));
    },
  };
}

// Wraps the real session port so a test can await what the bridge did to its agy sessions:
// `closed` counts sessions whose close() finished (their agy child has exited by then), `turnsOver` counts agy prompts whose event stream ended.
// `sessions` gives the raw sessions, through which a test sends what a real agy would react to over time (session/cancel).
function watch(port: AcpSessionPort) {
  const closed = counter();
  const turnsOver = counter();
  const sessions: AcpSession[] = [];
  const watched: AcpSessionPort = {
    async open(options) {
      const session = await port.open(options);
      sessions.push(session);
      let counted = false;
      return {
        get sessionId() { return session.sessionId; },
        get wireModel() { return session.wireModel; },
        prompt(blocks) {
          const events = session.prompt(blocks);
          return (async function* () {
            try { yield* events; } finally { turnsOver.bump(); }
          })();
        },
        steer: (blocks) => session.steer(blocks),
        cancel: () => session.cancel(),
        async close() {
          await session.close();
          if (!counted) { counted = true; closed.bump(); }
        },
      };
    },
  };
  return { port: watched, closed, turnsOver, sessions };
}

async function setup(bridgeOptions: { replayBudgetChars?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-bridge-test-"));
  roots.push(root);
  const logPath = path.join(root, "fake.log");
  const { port, closed, turnsOver, sessions } = watch(createAgyAcpSessionPort({
    sessionsDir: path.join(root, "sessions"),
    command: process.execPath,
    commandArgs: [fakeAgy],
    env: { ...process.env, FAKE_LOG: logPath, FAKE_BRIDGE: "1" },
  }));
  const bridge = createAgyAcpBridge({ port, coalesceMs: 10, silenceMs: 5_000, ...bridgeOptions });
  bridges.push(bridge);
  const log = async () => (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { bridge, log, closed, turnsOver, sessions };
}

// The command schema carries what Claude Code / Fleet tools carry in real life: an ECMAScript `\uXXXX` pattern nested in oneOf/items, and a lookahead.
const BASH = {
  type: "function" as const,
  name: "Bash",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", pattern: String.raw`^(?!rm )\S.*$` },
      // JSON Schema allows an array with no `items`; Gemini rejects the whole turn for it.
      batch: { type: "array" },
      flags: { type: "array", items: true },
      add: { type: "object", properties: { evidence: { type: "array", items: { oneOf: [{ type: "object", properties: { note: { type: "string", pattern: String.raw`^[^\u0000-\u001f\u007f]+$` } } }] } } } },
    },
  },
};
const user = (text: string): CanonicalInputItem => ({ type: "message", role: "user", content: text });
const assistant = (text: string): CanonicalInputItem => ({ type: "message", role: "assistant", content: text });
const call = (id: string, args: object): CanonicalInputItem => ({ type: "function_call", call_id: id, name: "Bash", arguments: JSON.stringify(args) });
const result = (id: string, output: string): CanonicalInputItem => ({ type: "function_call_output", call_id: id, output });

// A tool name too long for agy gets an alias; the alias must be the same on every request or each request would open a new session.
const LONG_TOOL = { type: "function" as const, name: "mcp__plugin_context7_context7__resolve-library-id", parameters: { type: "object", properties: {} } };

async function turn(bridge: AgyAcpBridge, input: CanonicalInputItem[], instructions = "be brief", toolChoice?: CanonicalResponseRequest["tool_choice"]) {
  const request: CanonicalResponseRequest = { model: MODEL, input, instructions, tools: [BASH, LONG_TOOL], ...(toolChoice ? { tool_choice: toolChoice } : {}), stream: true };
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
    // agy's toolbox (Go RE2) refuses `\uXXXX` and lookahead patterns and would fail the whole session: the former is respelled, the latter dropped.
    const schema = (entries.find((entry) => entry.mcpSchemas)!.mcpSchemas as {
      properties: { command: unknown; batch: unknown; flags: unknown; add: { properties: { evidence: { items: { oneOf: { properties: { note: { pattern: string } } }[] } } } } };
    }[])[0]!;
    expect(schema.properties.command).toEqual({ type: "string" });
    expect(schema.properties.batch).toEqual({ type: "array", items: {} });
    expect(schema.properties.flags).toEqual({ type: "array", items: {} });
    expect(schema.properties.add.properties.evidence.items.oneOf[0]!.properties.note.pattern).toBe(String.raw`^[^\x{0000}-\x{001f}\x{007f}]+$`);
    expect(entries.find((entry) => entry.mcpTools)).toMatchObject({
      mcpTools: ["Bash", expect.stringMatching(/^mcp__plugin_context7_context7__resolve_[0-9a-f]{8}$/)],
      eager: ["Bash", expect.stringMatching(/^mcp__plugin_context7_context7__resolve_[0-9a-f]{8}$/)],
      timeoutSeconds: 3600,
    });

    // The session was opened with the instructions and tool definitions it was given: the same names with different instructions or
    // a different tool description must not reuse it (it would never see the change), and the same request keeps reusing it.
    const history4: CanonicalInputItem[] = [...history, assistant("got:a.txt"), user("hello"), assistant(textOf(third.message)), user("again")];
    const fourth = await turn(bridge, history4, "be terse");
    expect(count(await log(), "session/new")).toBe(2);
    const history5: CanonicalInputItem[] = [...history4, assistant(textOf(fourth.message)), user("more")];
    await turn(bridge, history5, "be terse");
    expect(count(await log(), "session/new")).toBe(2);

    // `tool_choice: "none"`: no tool catalog is exposed and the session that has tools is not reused; the turn runs in a tool-less session.
    const noTools = await turn(bridge, [...history5, assistant("ok"), user("no tools now")], "be terse", "none");
    expect(textOf(noTools.message)).toContain("history:yes");
    const afterNone = await log();
    expect(count(afterNone, "session/new")).toBe(3);
    expect(afterNone.filter((entry) => entry.mcpTools).at(-1)).toMatchObject({ mcpTools: [], eager: [] });
  });

  it("steers the same agy turn with user text that arrives beside a tool result: one session, no rebuild, nothing added to the result", async () => {
    const wire = wireLogFixture("fleet-bridge-wire-");
    try {
      const { bridge, log, closed, turnsOver, sessions } = await setup();
      const first = await turn(bridge, [user('TOOL:Bash:{"command":"ls"}')]);
      const use = toolUse(first.message);
      // The history matches the held session and a system-reminder rides next to the tool result.
      const second = await turn(bridge, [
        user('TOOL:Bash:{"command":"ls"}'), call(use.id, { command: "ls" }), result(use.id, "a.txt"),
        user("<system-reminder>SECRET-REMINDER</system-reminder>"),
      ]);
      expect(second.message.stop_reason).toBe("end_turn");
      // One agy turn: the tool result as the tool result (no note added), then the user text, answered once.
      expect(textOf(second.message)).toBe("got:a.txt steered:<system-reminder>SECRET-REMINDER</system-reminder>");
      const entries = await log();
      expect(count(entries, "session/new")).toBe(1);
      expect(closed.value).toBe(0);
      expect(entries.find((entry) => entry.steering)).toMatchObject({ steering: "<system-reminder>SECRET-REMINDER</system-reminder>" });
      // The wire log counts what rides next to the tool results; it never records their content.
      const requests = wire.read().filter((entry) => entry.event === "bridge.request").map((entry) => entry.payload);
      expect(requests[0]).toMatchObject({ route: "fresh", tailToolResults: 0, tailUserTexts: 0, tailReminderTexts: 0, promptChars: expect.any(Number), replayChars: 0 });
      expect(requests[1]).toMatchObject({ route: "continue", steered: 1, tailToolResults: 1, tailUserTexts: 1, tailReminderTexts: 1 });
      expect(requests[1]).not.toHaveProperty("replayChars");
      expect(JSON.stringify(requests)).not.toContain("SECRET-REMINDER");
      expect(requests[0]).toMatchObject({ instructionsHash: expect.stringMatching(/^[0-9a-f]{8}$/), toolsHash: expect.stringMatching(/^[0-9a-f]{8}$/) });
      expect(requests[1]).toMatchObject({ instructionsHash: (requests[0] as { instructionsHash: string }).instructionsHash, toolsHash: (requests[0] as { toolsHash: string }).toolsHash });

      // Steering that cannot be sent falls back to a rebuild: here the agy turn is already over while its tool call is still held,
      // so there is no running turn to steer. The old session is replaced and the history is replayed.
      const ended = await turn(bridge, [user("ENDEARLY:Bash")]);
      const endedUse = toolUse(ended.message);
      // The call is held (the response ended with its tool_use); now end that agy prompt and wait until the bridge has seen it end.
      const turnsBefore = turnsOver.value;
      await sessions.at(-1)!.cancel();
      await turnsOver.reach(turnsBefore + 1);
      const sessionsBefore = count(await log(), "session/new");
      const fallback = await turn(bridge, [
        user("ENDEARLY:Bash"), call(endedUse.id, {}), result(endedUse.id, "a.txt"),
        user("<system-reminder>SECRET-REMINDER</system-reminder>"),
      ]);
      expect(textOf(fallback.message)).toContain("history:yes");
      expect(count(await log(), "session/new")).toBe(sessionsBefore + 1);
      const all = wire.read();
      expect(all.some((entry) => entry.event === "bridge.steer_failed")).toBe(true);
      const last = all.filter((entry) => entry.event === "bridge.request").at(-1)!.payload;
      expect(last).toMatchObject({ route: "rebuild", reason: "steering failed" });
      expect(last).not.toHaveProperty("steered");
      expect(JSON.stringify(all)).not.toContain("SECRET-REMINDER");
    } finally {
      wire.cleanup();
    }
  });

  it("steers an image from a tool result instead of returning it in the MCP result, alone or beside user text", async () => {
    const { bridge, log } = await setup();
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const image = (id: string, output = "a.txt"): CanonicalInputItem => ({
      type: "function_call_output", call_id: id,
      output: [{ type: "input_text", text: output }, { type: "input_image", image_url: png }] as never,
    });
    const first = await turn(bridge, [user('TOOL:Bash:{"command":"ls"}')]);
    const use = toolUse(first.message);
    const second = await turn(bridge, [user('TOOL:Bash:{"command":"ls"}'), call(use.id, { command: "ls" }), image(use.id), user("see")]);
    expect(second.message.stop_reason).toBe("end_turn");
    const entries = await log();
    expect(count(entries, "session/new")).toBe(1);
    expect(entries.find((entry) => entry.resultBlocks)).toMatchObject({ resultBlocks: ["text"] });
    expect(entries.find((entry) => entry.steering)).toMatchObject({ steerImages: 1 });
  });

  it("registers only non-deferred tools when ToolSearch is present, and reopens the session once a deferred tool loads", async () => {
    const { bridge, log } = await setup();
    const plain = { type: "object", properties: {} };
    const tools = (deferred: boolean | undefined) => [
      { type: "function" as const, name: "ToolSearch", parameters: plain },
      { type: "function" as const, name: "Bash", parameters: plain },
      { type: "function" as const, name: "Later", parameters: plain, ...(deferred ? { defer_loading: true } : {}) },
    ];
    const ask = async (input: CanonicalInputItem[], toolList: ReturnType<typeof tools>, toolChoice?: CanonicalResponseRequest["tool_choice"]) => {
      const response = await bridge.stream({ model: MODEL, input, instructions: "be brief", tools: toolList, ...(toolChoice ? { tool_choice: toolChoice } : {}), stream: true }, { apiKey: "" });
      if (!response.ok) throw new Error(`bridge refused with ${response.status}`);
      const events: CanonicalResponseEvent[] = [];
      for await (const event of response.events) events.push(event);
      const collected = await collectAnthropicMessage((async function* () { yield* events; })(), MODEL, { model: MODEL });
      return textOf(collected as unknown as { content: { type: string; text?: string }[] });
    };
    const listed = async () => (await log()).filter((entry) => entry.mcpTools).map((entry) => entry.mcpTools);
    const a1 = await ask([user("one")], tools(true));
    expect((await listed()).at(-1)).toEqual(["ToolSearch", "Bash"]);
    const a2 = await ask([user("one"), assistant(a1), user("two")], tools(true));
    expect(count(await log(), "session/new")).toBe(1);
    // The deferred tool loads: the catalog changes, so the held session is replaced and the new tool is visible.
    await ask([user("one"), assistant(a1), user("two"), assistant(a2), user("three")], tools(false));
    expect((await listed()).at(-1)).toEqual(["ToolSearch", "Bash", "Later"]);
    expect(count(await log(), "session/new")).toBe(2);
    // A tool the request names stays, and without ToolSearch nothing is filtered.
    await ask([user("x")], tools(true), { type: "tool", name: "Later" } as never);
    expect((await listed()).at(-1)).toEqual(["ToolSearch", "Bash", "Later"]);
    await ask([user("y")], tools(true).filter((tool) => tool.name !== "ToolSearch"));
    expect((await listed()).at(-1)).toEqual(["Bash", "Later"]);
  });

  it("slims tool schemas for agy without touching the request and without changing meaning", async () => {
    const { bridge, log } = await setup();
    const parameters = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["format", "requestSource"],
      properties: {
        format: { type: "string", format: "uri", minLength: 1, maxLength: 9, description: "a field named format" },
        example: { type: "number", minimum: 0, maximum: 5, default: 2 },
        maybe: { anyOf: [{ type: "string", description: "inner" }, { type: "null" }] },
        merged: { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "boolean" } } }] },
        requestSource: {
          description: "source",
          oneOf: [
            { type: "object", properties: { kind: { const: "user" }, id: { type: "string" } }, required: ["kind", "id"] },
            { type: "object", properties: { kind: { const: "agent" } }, required: ["kind"] },
          ],
        },
        mode: { oneOf: [{ const: "fast" }, { const: "slow" }] },
        evidence: { oneOf: [{ type: "object", properties: { note: { type: "string" } } }, { type: "string" }] },
      },
    };
    const snapshot = JSON.stringify(parameters);
    const response = await bridge.stream({ model: MODEL, input: [user("hi")], instructions: "i", tools: [{ type: "function", name: "Slim", parameters }], stream: true }, { apiKey: "" });
    if (!response.ok) throw new Error("refused");
    for await (const _ of response.events) void _;
    expect(JSON.stringify(parameters)).toBe(snapshot);
    const schema = (await log()).find((entry) => entry.mcpSchemas)!.mcpSchemas as Record<string, unknown>[];
    expect(schema[0]).toEqual({
      type: "object",
      required: ["format", "requestSource"],
      properties: {
        format: { type: "string", description: "a field named format" },
        example: { type: "number", default: 2 },
        maybe: { type: "string", description: "inner" },
        merged: { type: "object", properties: { a: { type: "string" }, b: { type: "boolean" } }, required: ["a"] },
        requestSource: {
          description: "source",
          type: "object",
          properties: { kind: { type: "string", enum: ["user", "agent"] }, id: { type: "string" } },
          required: ["kind"],
        },
        mode: { type: "string", enum: ["fast", "slow"] },
        evidence: { oneOf: [{ type: "object", properties: { note: { type: "string" } } }, { type: "string" }] },
      },
    });
  });

  it("keeps call/result pairs, roles and the latest user instruction when the replayed history exceeds its budget", async () => {
    const wire = wireLogFixture("fleet-bridge-wire-");
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
    // The size of the replayed first prompt is logged as counts (the cost of a rebuild), never as content.
    const logged = wire.read().find((entry) => entry.event === "bridge.request")!.payload as Record<string, unknown>;
    expect(logged).toMatchObject({ route: "rebuild", promptChars: expect.any(Number), replayChars: expect.any(Number), omittedTurns: 2 });
    expect(logged.replayChars as number).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain("LATEST");
    wire.cleanup();
  });

  it("recovers by replay after agy gives up on a held tool call, and never lets the abandoned session's output out", async () => {
    const { bridge, log, closed, sessions } = await setup();
    const first = await turn(bridge, [user("TIMEOUT:Bash")]);
    const use = toolUse(first.message);
    // agy's call deadline passes: the fake drops the held call, and the bridge closes that session.
    await sessions.at(-1)!.cancel();
    await closed.reach(1);
    const second = await turn(bridge, [user("TIMEOUT:Bash"), call(use.id, {}), result(use.id, "late result")]);
    expect(textOf(second.message)).toContain("history:yes");
    expect(textOf(first.message) + textOf(second.message)).not.toContain("timed out after 3 minutes");
    expect(count(await log(), "session/new")).toBe(2);
  });

  it("ends the turn as an Anthropic error, not an answer, when agy reports an upstream problem as message text", async () => {
    const { bridge, closed } = await setup();
    const open = (prompt: string) => bridge.stream({ model: MODEL, input: [user(prompt)], instructions: "be brief", tools: [BASH], stream: true }, { apiKey: "" });
    // A retried 429: rate_limit_error before the stream starts, and agy's own retries are not waited for (the fake's turn stays open until cancelled).
    const limited = await open("UPSTREAM429");
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.status).toBe(429);
    const body = JSON.parse(new TextDecoder().decode(limited.body)) as { type: string; error: { type: string; message: string } };
    expect(body).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(body.error.message).toContain("RESOURCE_EXHAUSTED");
    expect(JSON.stringify(body)).not.toContain("NOT-A-REAL-ANSWER");
    expect(closed.value).toBe(1);
    // A code-less "⚠ network issue" message that is the whole turn: overloaded_error (529, which Claude Code retries), session dropped.
    const network = await open("UPSTREAMNET");
    expect(network.ok).toBe(false);
    if (network.ok) return;
    expect(network.status).toBe(529);
    expect(JSON.parse(new TextDecoder().decode(network.body))).toMatchObject({ error: { type: "overloaded_error", message: expect.stringContaining("network issue") } });
    expect(closed.value).toBe(2);
  });

  it("denies built-in tools and fails the turn if one runs anyway", async () => {
    const { bridge, log, closed } = await setup();
    const { events } = await turn(bridge, [user("BUILTIN")]);
    expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { error: { type: "api_error" } } });
    const entries = await log();
    expect(entries.find((entry) => entry.permission === "Run run_command")).toMatchObject({ outcome: { optionId: "deny" } });
    await closed.reach(1);
  });
});
