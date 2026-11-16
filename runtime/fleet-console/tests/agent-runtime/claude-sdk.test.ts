import { claudeGatewayModelPolicy } from "@fleet-console/ai-gateway";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLAUDE_GATEWAY_MODEL_CACHE_RELPATH } from "../../foundation/agent-runtime/src/claude/launch-env.js";

// 자식 프로세스를 띄우지 않는다. 검증 대상은 spawn 직전까지의 조립과 거부다.
const runVendorQuery = vi.fn();
const runVendorSession = vi.fn();
let vendorClose: () => void = () => {};
vi.mock("../../foundation/agent-runtime/src/claude/vendor-sdk.js", () => ({
  runVendorQuery: (input: unknown) => {
    runVendorQuery(input);
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", subtype: "success" };
      },
      close: () => vendorClose(),
    };
  },
  runVendorSession: (input: unknown) => {
    runVendorSession(input);
    return {
      // 세션 스트림은 스스로 끝나지 않는다 — close가 유일한 종점이다.
      [Symbol.asyncIterator]: async function* () {
        await new Promise<void>(() => undefined);
      },
      send: vi.fn(),
      interrupt: vi.fn(async () => {}),
      stopTask: vi.fn(async () => {}),
      backgroundTasks: vi.fn(async () => true),
      getContextUsage: vi.fn(async () => null),
      close: () => vendorClose(),
    };
  },
  defineVendorTool: vi.fn(),
  createVendorMcpServer: vi.fn(),
}));

const { createClaudeGatewaySdk } = await import("../../foundation/agent-runtime/src/claude/sdk.js");

const BASE_URL = "http://127.0.0.1:43210/plugins/terminal/ai-gateway";
const LUNA = "claude-gateway--codex--gpt-6-luna";
const SOL = "claude-gateway--codex--gpt-6.1-sol";
const FABLE_1M = "fable[1m]";

async function drain(run: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of run) { /* 스트림을 끝까지 읽어 실행 슬롯을 돌려준다 */ }
}

beforeEach(() => {
  runVendorQuery.mockClear();
  runVendorSession.mockClear();
  vendorClose = () => {};
});

describe("construction", () => {
  it("refuses a missing baseUrl rather than falling back to the public endpoint", async () => {
    await expect(createClaudeGatewaySdk({ modelPolicy: claudeGatewayModelPolicy, baseUrl: "", models: [LUNA] })).rejects.toThrow(/baseUrl is required/);
  });

  it("owns an isolated config directory", async () => {
    const sdk = await createClaudeGatewaySdk({ modelPolicy: claudeGatewayModelPolicy, baseUrl: BASE_URL, models: [LUNA] });
    expect(existsSync(sdk.configDir)).toBe(true);
    expect(sdk.configDir).not.toContain(".claude");
    await sdk.dispose();
    expect(existsSync(sdk.configDir)).toBe(false);
  });
});

describe("turn assembly", () => {

  it("folds a throwing permission callback into a denial so the tool is never left parked", async () => {
    const executablePath = path.resolve("host-selected-claude");
    const sdk = await createClaudeGatewaySdk({ modelPolicy: claudeGatewayModelPolicy, baseUrl: BASE_URL, models: [LUNA], executablePath });
    await drain(await sdk.startTurn({
      prompt: "hi",
      model: LUNA,
      additionalDirectories: [path.resolve("project-a"), path.resolve("project-b")],
      canUseTool: async () => { throw new Error("host blew up"); },
    }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.pathToClaudeCodeExecutable).toBe(executablePath);
    expect(options.additionalDirectories).toEqual([path.resolve("project-a"), path.resolve("project-b")]);
    const vendorCallback = options.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      extras: Record<string, unknown>,
    ) => Promise<unknown>;
    // 예외를 그대로 올리면 vendor가 응답을 쓰지 못해 도구가 무기한 막힌다(park deadline 없음).
    await expect(vendorCallback("Bash", {}, { toolUseID: "t", signal: new AbortController().signal }))
      .resolves.toEqual({ behavior: "deny", message: "host blew up" });
    await sdk.dispose();
  });
});

// 명시한 스킬·메모리 정책이 vendor 설정으로 전달되고, 메모리는 상속 환경과 충돌해도 일치해야 한다.
it("relays explicit skill and memory policy while aligning the child memory environment", async () => {
  for (const enabled of [false, true]) {
    const sdk = await createClaudeGatewaySdk({ modelPolicy: claudeGatewayModelPolicy, baseUrl: BASE_URL, models: [LUNA],
      autoMemoryEnabled: enabled, disableBundledSkills: true, skillOverrides: { "plugin-authoring": "off" }, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: enabled ? "1" : "0" } });
    try {
      const session = await sdk.openSession({ model: LUNA });
      expect(runVendorSession.mock.calls.at(-1)?.[0].options).toMatchObject({
        settings: { autoMemoryEnabled: enabled, disableBundledSkills: true, skillOverrides: { "plugin-authoring": "off" } },
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: enabled ? "0" : "1" },
        settingSources: [],
      });
      session.close();
    } finally { await sdk.dispose(); }
  }
});

describe("fail-closed refusals", () => {

  it("refuses a second concurrent turn on one instance", async () => {
    const sdk = await createClaudeGatewaySdk({ modelPolicy: claudeGatewayModelPolicy, baseUrl: BASE_URL, models: [LUNA] });
    const first = await sdk.startTurn({ prompt: "hi", model: LUNA });
    await expect(sdk.startTurn({ prompt: "hi", model: LUNA })).rejects.toThrow(/already running/);
    await drain(first);
    // 슬롯은 스트림 소진으로 돌아온다.
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));
    await sdk.dispose();
  });

  it("never spawns a session child once disposal lands during launch preparation", async () => {
    const sdk = await createClaudeGatewaySdk({ modelPolicy: claudeGatewayModelPolicy, baseUrl: BASE_URL, models: [LUNA] });
    // 거절 처리를 dispose보다 먼저 붙인다 — dispose를 기다리는 사이 거절이 도착하면 미처리로 잡힌다.
    const refused = expect(sdk.openSession({ model: LUNA })).rejects.toThrow(/disposed/);
    await sdk.dispose();
    await refused;
    expect(runVendorSession).not.toHaveBeenCalled();
  });
});

describe("system prompt channel", () => {

  it("still refuses every unauthored instruction channel", async () => {
    const sdk = await createClaudeGatewaySdk({ modelPolicy: claudeGatewayModelPolicy, baseUrl: BASE_URL, models: [LUNA] });
    for (const key of ["agents", "hooks", "settingSources", "plugins", "extraArgs"]) {
      await expect(sdk.startTurn({ prompt: "hi", model: LUNA, [key]: {} } as never))
        .rejects.toThrow(new RegExp(key));
    }
    expect(runVendorQuery).not.toHaveBeenCalled();
    await sdk.dispose();
  });
});

describe("resident loop resume", () => {
  /** 자식 스트림 하나 — 테스트가 메시지를 밀어 넣고 end로 자식의 종료를 흉내 낸다. */
  function fakeChild() {
    const pending: Record<string, unknown>[] = [];
    let exited = false;
    let closedByLoop = false;
    let notify: (() => void) | null = null;
    const release = () => { const wake = notify; notify = null; wake?.(); };
    return {
      send: () => undefined,
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (pending.length) { yield pending.shift()!; continue; }
          if (exited) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
            // 대기를 등록하는 사이에 이미 밀어 넣었거나 끝났으면 스스로 깨운다.
            if (pending.length || exited) { notify = null; resolve(); }
          });
        }
      },
      push(message: Record<string, unknown>) { pending.push(message); release(); },
      /** 자식 프로세스가 스스로 끝났다. */
      end() { exited = true; release(); },
      /** 루프가 자식을 닫았다 — 조금 뒤 루프의 read가 끝나 resume 판정이 선다. */
      close() { closedByLoop = true; exited = true; release(); },
      closed: () => closedByLoop,
      interrupt: async () => undefined,
      getContextUsage: async () => null,
    };
  }
  /** 파일 쓰기·스트림 정산처럼 실제 타이머가 필요한 단계를 기다린다. */
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("resident loop did not reach the expected state in time");
  };

  it("opens a fresh session when a resumed child ends after init without a successful turn", async () => {
    const { createClaudeResidentLoop } = await import("../../foundation/agent-runtime/src/claude/resident-loop.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-resident-resume-"));
    try {
      const configDir = path.join(dir, "config");
      // 남은 대화의 트랜스크립트 — 이게 있어야 루프가 resume으로 연다.
      const projects = path.join(configDir, "projects", "-work");
      mkdirSync(projects, { recursive: true });
      const original = "11111111-1111-1111-1111-111111111111";
      writeFileSync(path.join(projects, `${original}.jsonl`), "");
      const stateFile = path.join(dir, "session.json");
      writeFileSync(stateFile, JSON.stringify({ sessionId: original, model: FABLE_1M }));

      const requests: { resume?: string; sessionId?: string }[] = [];
      const children: ReturnType<typeof fakeChild>[] = [];
      const sdk = {
        configDir,
        openSession: async (request: { resume?: string; sessionId?: string }) => {
          requests.push(request);
          const child = fakeChild();
          children.push(child);
          return child;
        },
        dispose: async () => undefined,
      };
      const loop = createClaudeResidentLoop({
        createSdk: async () => sdk as never,
        buildSession: () => ({ model: FABLE_1M }) as never,
        stateFile,
        settlement: "result",
      });
      await loop.start();
      expect(loop.resumed).toBe(true);

      // resume으로 연 자식이 init만 내고 is_error로 끝나고, 이어서 자식이 종료된다.
      const first = loop.run("first");
      await until(() => children.length === 1);
      expect(requests[0]).toMatchObject({ resume: original });
      children[0]!.push({ type: "system", subtype: "init" });
      children[0]!.push({ type: "result", subtype: "error", is_error: true, result: "No conversation found with session ID" });
      await first;
      children[0]!.end();
      await until(() => children[0]!.closed());

      // 깨진 resume이다 — 다음 자식은 같은 대화가 아니라 새 --session-id로 연다.
      const second = loop.run("second");
      await until(() => children.length === 2);
      expect(requests[1]!.resume).toBeUndefined();
      expect(requests[1]!.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(requests[1]!.sessionId).not.toBe(original);
      const fresh = requests[1]!.sessionId!;
      children[1]!.push({ type: "system", subtype: "init" });
      children[1]!.push({ type: "result", subtype: "success", is_error: false });
      await second;
      children[1]!.end();
      await until(() => children[1]!.closed());

      // 첫 턴을 성공한 세션은 정상이다 — 다음 자식은 그 대화를 그대로 resume한다.
      const third = loop.run("third");
      await until(() => children.length === 3);
      expect(requests[2]).toMatchObject({ resume: fresh });
      children[2]!.push({ type: "system", subtype: "init" });
      children[2]!.push({ type: "result", subtype: "success", is_error: false });
      await third;
      children[2]!.end();
      await until(() => children[2]!.closed());

      // resume으로 열렸지만 첫 턴을 성공했으면 다시 새 세션을 열지 않는다.
      const fourth = loop.run("fourth");
      await until(() => children.length === 4);
      expect(requests[3]).toMatchObject({ resume: fresh });
      children[3]!.push({ type: "result", subtype: "success", is_error: false });
      await fourth;
      expect(requests).toHaveLength(4);
      await loop.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
