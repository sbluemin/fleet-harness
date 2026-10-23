import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOwnedProcessRegistry, proveExitedLeaderGroup, readConsoleExitRecord, readConsoleLockFile, REAPER_DRAIN_MAX_MS, selectSameGroupDescendants } from "@fleet-console/lifecycle";
import { ConsoleSessionHostOwner } from "../core/host/bootstrap/session-host-owner.js";
import type { SessionHostPlatform } from "@fleet-console/lifecycle/session-host";
import { createWindowsJobContainment, loadWindowsJobBindings, type WindowsJobBindings } from "../core/host/bootstrap/windows-job-containment.js";
import { describeReplacedLockAuthor, HEALTH_PROBE_TIMEOUT_MS, PROCESS_START_MARGIN_MS } from "@fleet-console/protocol/lifecycle";

import { createConsoleDaemonLifecycle, type ConsoleDaemonProcess } from "../core/host/bootstrap/console-lifecycle.js";
import { createConsoleLock } from "../core/host/bootstrap/lock.js";
import { createConsolePaths } from "../core/host/bootstrap/paths.js";
import { SessionHostClient, stopSlotSessionHost } from "../features/execution/host/session-host/client.js";
import { authenticateSessionPeer, SessionRpcPeer, sessionNonce, connectSessionUpdateKeeper, connectSessionRpc } from "@fleet-console/lifecycle/session-host";
import { SESSION_HOST_WIRE } from "@fleet-console/protocol/session-host";
import { createWindowsSessionPlatform } from "../core/host/bootstrap/windows-session-platform.js";
import { HostedExecution } from "../features/execution/host/session-host/adapters.js";
import { createHostedSdk } from "../features/execution/host/session-host/sdk-proxy.js";
import { AgentChatRegistry, type AgentChatSessionSeed } from "../features/execution/host/agent/chat-session.js";
import { createLaunchConfiguration } from "../features/execution/host/agent/launch-fingerprint.js";
import { createConsoleObservabilityStore } from "../features/execution/host/agent/observability-store.js";
import { claudeGatewayModelPolicy } from "@fleet-console/ai-gateway";
import { createConsoleUpdateApplyService } from "../features/updates/host/update-apply.js";
import { readConsoleUpdateProgress, writeConsoleUpdateProgress } from "../features/updates/host/update-progress.js";
import { clearSessionUpdateNotice, recordSessionUpdateIncompatibility } from "../features/updates/host/session-update-notice.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/controlled-console-child.mjs", import.meta.url));
const CLAIMANT_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/lock-reclaim-claimant.ts", import.meta.url));
const REAPER_SOURCE = fileURLToPath(new URL("../foundation/lifecycle/reaper-main.ts", import.meta.url));
const TSX_LOADER_URL = pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;
const TEMP_DIRS: string[] = [];
const CHILD_PIDS = new Set<number>();

afterEach(async () => {
  for (const pid of CHILD_PIDS) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 이미 종료된 fixture다.
    }
  }
  CHILD_PIDS.clear();
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Console session-host lifecycle integration", () => {
  // A restricted Windows job must disable preservation, not session execution or owned-tree cleanup.
  it("runs Console-owned sessions when independence is unavailable and ends them on update", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-session-bound-")); TEMP_DIRS.push(root);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, ".claude"), FAKE_CLAUDE_DIR: path.join(root, "fake") };
    const held = await createConsoleLock().acquireLock({ dir: root, lockFile: path.join(root, "console.lock"), pid: process.pid, port: 1, endpoint: "http://127.0.0.1:1/", version: "fixture" });
    const containment = process.platform === "win32" ? createWindowsJobContainment(loadWindowsJobBindings(), () => {}) : undefined;
    const registry = createOwnedProcessRegistry({ containment });
    const native = createWindowsSessionPlatform(registry);
    const platform: SessionHostPlatform = {
      ...(native ?? { assertIndependent() {}, protectDirectory() {}, owns: () => true, spawnConsoleOwned(command, args, childEnv) {
        const child = registry.spawn({ command, args, env: childEnv, owner: "session-host" }); child.stdout?.resume(); child.stderr?.resume(); return child;
      } }),
      spawnIndependent() { throw Object.assign(new Error("fixture_restricted_job"), { code: "SESSION_INDEPENDENCE_UNAVAILABLE" }); },
    };
    const owner = new ConsoleSessionHostOwner(root, fileURLToPath(new URL("../", import.meta.url)), platform, env);
    try {
      const client = await owner.start(held.payload);
      expect(client.preservesUpdates).toBe(false);
      await client.bindBusiness(() => null);
      const terminal = await client.open({ kind: "pty", sessionKey: "bound", generation: client.generation, launch: { bin: process.execPath, args: ["-e", "process.stdin.on('data',b=>process.stdout.write(b));process.stdout.write('fixture-ready\\n');setInterval(()=>{},1<<30)"], cwd: root, env }, size: { cols: 80, rows: 24 } });
      const output = async () => (await client.readEvents("bound", 0)).events.filter((event) => event.kind === "pty-data").map((event) => String(event.data)).join("");
      await vi.waitFor(async () => expect(await output()).toContain("fixture-ready"), { timeout: 10_000 });
      await client.command({ sessionKey: "bound", commandId: "write", sequence: 1, kind: "write", body: { data: `bound-still-runs${process.platform === "win32" ? "\r" : "\n"}` } });
      await vi.waitFor(async () => expect(await output()).toContain("bound-still-runs"), { timeout: 10_000 });
      await expect(client.prepareUpdate("forged-keeper")).rejects.toThrow("session_update_preservation_unavailable");
      const execution = await HostedExecution.attach(client, (_kind, error) => { throw error; }, env);
      execution.bind("fixture-tools", () => null); await execution.ready();
      const proxy = createHostedSdk(execution, { baseUrl: "http://127.0.0.1:1", models: ["opus"], executablePath: fileURLToPath(new URL("../../../.claude/skills/console-e2e/scripts/fake-claude.mjs", import.meta.url)), env, home: { kind: "isolated" }, modelPolicy: claudeGatewayModelPolicy }, { key: "bound-sdk", tools: [{ name: "fixture", port: "fixture-tools", tools: [{ name: "effect", description: "Fixture effect", inputSchema: { type: "object", properties: {} } }] }] });
      await proxy.openSession({ model: "opus", cwd: root });
      const [mcp] = execution.get("bound-sdk")!.runtime.mcpServers as { url: string; headers: { value: string }[] }[];
      let finishBusiness!: (value: unknown) => void;
      await client.bindBusiness(() => new Promise((resolve) => { finishBusiness = resolve; }));
      const business = fetch(mcp!.url, { method: "POST", headers: { "content-type": "application/json", Authorization: mcp!.headers[0]!.value }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "effect", arguments: {} } }) }).then((response) => response.json());
      await vi.waitFor(() => expect(finishBusiness).toBeTypeOf("function"));
      const update = createConsoleUpdateApplyService({
        fleetDataDir: root, tmpDir: root, workerRuntimePath: fileURLToPath(new URL("../dist/lifecycle-worker-runtime.mjs", import.meta.url)),
        preflightInstall: () => ({ bin: process.execPath, command: "npm", globalRoot: root, prefixArgs: [] }),
        downloadTarball: async () => ({ ok: true, tarballPath: path.join(root, "candidate.tgz") }),
        sessionHost: owner,
        spawnWorker: () => { throw new Error("A pending permission must not launch an installer."); },
      });
      await expect(update.start({ currentEndpoint: held.payload.endpoint, currentLockToken: held.payload.token, currentLockStartedAt: held.payload.startedAt, currentPackageRoot: root, currentPid: process.pid, dataDir: root, fromVersion: "1.0.0", lockFile: path.join(root, "console.lock"), release: { schema: 1, package: "@dotobokuri/fleet-console", version: "1.0.1", tag: "v1.0.1", tarball: { name: "fleet-console-1.0.1.tgz", size: 1, sha256: "0".repeat(64) } } })).rejects.toMatchObject({ progress: { reason: "session-business-pending" } });
      expect(readConsoleUpdateProgress(root)).toMatchObject({ reason: "session-business-pending" });
      expect(isRunning(terminal.runtime.pid as number)).toBe(true);
      finishBusiness({ $sessionHostDeferred: true, turnId: "bound-turn", permissionEpoch: 1, lifetime: "turn", expiresAt: null, presentation: { kind: "approval" } });
      let requestId = "";
      await vi.waitFor(async () => {
        const pending = (await client.listSessions()).sessions.find((session) => session.sessionKey === execution.get("bound-sdk")!.sessionKey)!.runtime.pendingBusiness as { requestId: string; deferred?: unknown }[];
        expect(pending[0]?.deferred).toBeTruthy(); requestId = pending[0]!.requestId;
      });
      await expect(owner.prepareUpdate("pending-permission")).rejects.toThrow("session_business_not_drained");
      await client.answerBusiness(requestId, 1, { content: [] }); await business;
      expect(await owner.prepareUpdate("cancelled-update")).toBe(null);
      await expect(client.command({ sessionKey: "bound", commandId: "blocked", sequence: 2, kind: "write", body: { data: "blocked" } })).rejects.toThrow("session_command_unavailable");
      await owner.cancelUpdate("cancelled-update");
      expect(fs.existsSync(path.join(root, "session-update-notice.json"))).toBe(false);
      await client.command({ sessionKey: "bound", commandId: "resumed", sequence: 2, kind: "write", body: { data: "resumed\r" } });
      expect(await owner.prepareUpdate("bound-update")).toBe(null);
      await owner.commitUpdate("bound-update"); expect(owner.preservingUpdate).toBe(false);
      owner.requestStop("update"); await owner.settleStop();
      writeConsoleUpdateProgress(root, { phase: "completed", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), fromVersion: "1.0.0", targetVersion: "1.0.1" });
      expect(readConsoleUpdateProgress(root)).toMatchObject({ state: "completed", phase: "completed", reason: "session-preservation-unavailable", fromVersion: "1.0.0", targetVersion: "1.0.1", description: expect.stringContaining("update ended them") });
      execution.detach();
      for (const pid of [terminal.runtime.pid, terminal.runtime.runnerPid, client.manifest.pid]) {
        expect(pid).toBeTypeOf("number"); await vi.waitFor(() => expect(isRunning(pid as number)).toBe(false), { timeout: 15_000 });
      }
      if (process.platform === "win32") expect(registry.groups()).toHaveLength(0);
      expect(fs.readFileSync(path.join(root, "session-host/failures.jsonl"), "utf8")).toContain('"kind":"session_update_preservation_unavailable"');
      clearSessionUpdateNotice(root);
      const infrastructureOwner = new ConsoleSessionHostOwner(root, fileURLToPath(new URL("../", import.meta.url)), platform, env);
      try {
        const infrastructure = await infrastructureOwner.start(held.payload);
        await infrastructure.bindBusiness(() => null);
        await infrastructure.open({ kind: "gateway", sessionKey: "infrastructure-only", generation: infrastructure.generation, options: {}, ports: {} });
        expect((await infrastructure.listSessions()).sessions).toMatchObject([{ kind: "gateway", state: "live" }]);
        await infrastructureOwner.prepareUpdate("without-execution");
        await infrastructureOwner.commitUpdate("without-execution");
        infrastructureOwner.requestStop("update"); await infrastructureOwner.settleStop();
        expect(fs.existsSync(path.join(root, "session-update-notice.json"))).toBe(false);
        expect(readConsoleUpdateProgress(root)).toMatchObject({ state: "completed" });
        expect(readConsoleUpdateProgress(root).reason).toBeUndefined();
      } finally { infrastructureOwner.requestStop("api"); await infrastructureOwner.settleStop().catch(() => {}); }
    } finally { owner.requestStop("api"); await owner.settleStop().catch(() => {}); held.release(); }
  }, 60_000);

  // The old representative suite only proved child death. This boundary must also prove same-child update continuity.
  it("keeps SDK and PTY execution through an authenticated update, rejects duplicate input, then stops the whole host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-session-handoff-")); TEMP_DIRS.push(root);
    const home = path.join(root, "home"); fs.mkdirSync(home); const fake = path.join(root, "fake"); fs.mkdirSync(fake);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_DIR: fake };
    const lockFile = path.join(root, "console.lock");
    const lock = createConsoleLock();
    let held = await lock.acquireLock({ dir: root, lockFile, pid: process.pid, port: 1, endpoint: "http://127.0.0.1:1/", version: "fixture" });
    let client: SessionHostClient | null = null;
    let keeper: { close(): void } | null = null;
    try {
      client = await SessionHostClient.attach(root, fileURLToPath(new URL("../", import.meta.url)), held.payload, env, createWindowsSessionPlatform());
      const first = client;
      const unauthenticated = await connectSessionRpc(client.manifest.socket);
      try {
        await expect(authenticateSessionPeer(unauthenticated, { wire: SESSION_HOST_WIRE, role: "control", hostId: client.manifest.hostId }, "not-a-capability")).rejects.toThrow("session_auth_server_unverified");
        await expect(unauthenticated.call("terminate-all")).rejects.toThrow("session_host_auth_required");
      } finally { unauthenticated.close(); }
      // 위조 endpoint에는 서버 검증 이전의 challenge만 전송하며 원문 secret/proof는 누출하지 않는다.
      const impostorPath = process.platform === "win32" ? `\\\\.\\pipe\\fleet-impostor-${sessionNonce()}` : path.join(root, "impostor.sock");
      const observed: string[] = []; const impostorPeers = new Set<SessionRpcPeer>();
      const impostor = createServer((socket) => {
        socket.on("data", (data) => observed.push(data.toString()));
        const peer = new SessionRpcPeer(socket); impostorPeers.add(peer);
        peer.bind(() => ({ serverNonce: sessionNonce(), proof: "0".repeat(64) }));
      });
      await new Promise<void>((resolve, reject) => { impostor.once("error", reject); impostor.listen(impostorPath, resolve); });
      const fakePeer = await connectSessionRpc(impostorPath);
      try {
        await expect(authenticateSessionPeer(fakePeer, { wire: SESSION_HOST_WIRE, role: "console", hostId: client.manifest.hostId }, client.manifest.capability, held.payload.token)).rejects.toThrow("session_auth_server_unverified");
        expect(observed.join("")).not.toContain(client.manifest.capability);
        expect(observed.join("")).not.toContain(held.payload.token);
        expect(observed.join("")).not.toContain("auth-finish");
      } finally { fakePeer.close(); for (const peer of impostorPeers) peer.close(); await new Promise<void>((resolve) => impostor.close(() => resolve())); }
      const tampered = await connectSessionRpc(client.manifest.socket);
      try {
        await authenticateSessionPeer(tampered, { wire: SESSION_HOST_WIRE, role: "control", hostId: client.manifest.hostId }, client.manifest.capability);
        const closed = new Promise<void>((resolve) => tampered.onClose(resolve));
        tampered.socket.write(JSON.stringify({ secure: true, sequence: 1, tag: "0".repeat(32), data: "" }) + "\n");
        await closed;
        expect(tampered.isClosed).toBe(true);
      } finally { tampered.close(); }
      let toolCalls = 0;
      let execution = await HostedExecution.attach(client, (_kind, error) => { throw error; });
      execution.bind("fixture-tools", () => ({ content: [{ type: "text", text: `call-${++toolCalls}` }] }));
      await execution.ready();
      const executablePath = fileURLToPath(new URL("../../../.claude/skills/console-e2e/scripts/fake-claude.mjs", import.meta.url));
      const sdkOptions = { baseUrl: "http://127.0.0.1:1", models: ["opus"], executablePath, env, home: { kind: "isolated" as const }, modelPolicy: claudeGatewayModelPolicy };
      const binding = { key: "chat", launchFingerprint: { schema: 1, digest: "fixture" }, tools: [{ name: "fleet-fixture", port: "fixture-tools", tools: [{ name: "effect", description: "Fixture effect", inputSchema: { type: "object", properties: {} } }] }] };
      const proxy = createHostedSdk(execution, sdkOptions, binding);
      await proxy.openSession({ model: "opus", cwd: root, permissionMode: "dontAsk" });
      const sdk = execution.get("chat")!;
      const [mcp] = sdk.runtime.mcpServers as { name: string; url: string; headers: { name: string; value: string }[] }[];
      const callTool = async () => {
        const response = await fetch(mcp!.url, { method: "POST", headers: { "content-type": "application/json", Authorization: mcp!.headers[0]!.value }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "effect", arguments: {} } }) });
        expect(response.status).toBe(200); return await response.json();
      };
      expect(await callTool()).toMatchObject({ result: { content: [{ text: "call-1" }] } });
      const retiredId = "b".repeat(64);
      const retiredRoot = path.join(path.dirname(client.generation.root), retiredId);
      fs.cpSync(client.generation.root, retiredRoot, { recursive: true });
      fs.writeFileSync(path.join(retiredRoot, ".complete"), retiredId, { mode: 0o600 });
      const oldGeneration = { ...client.generation, id: retiredId, root: retiredRoot, node: path.join(retiredRoot, path.basename(client.generation.node)), broker: path.join(retiredRoot, "dist/session-host.mjs"), runner: path.join(retiredRoot, "dist/session-runner.mjs"), hook: path.join(retiredRoot, "dist/session-hook.mjs"), reaper: path.join(retiredRoot, "dist/console-reaper.mjs") };
      await client.open({ kind: "pty", sessionKey: "retiring", generation: oldGeneration, launch: { bin: process.execPath, args: ["-e", "setInterval(()=>{},1<<30)"], cwd: root, env }, size: { cols: 80, rows: 24 } });
      const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "untouched");
      const escape = path.join(retiredRoot, "outside-link"); fs.symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
      const terminal = await client.open({ kind: "pty", sessionKey: "terminal", generation: client.generation, launch: { bin: process.execPath, args: ["-e", "process.stdin.on('data', b => process.stdout.write(b)); setInterval(()=>{},1<<30)"], cwd: root, env }, size: { cols: 80, rows: 24 } });
      const send = { sessionKey: sdk.sessionKey, commandId: "send-one", sequence: 1, kind: "send", body: { input: "SLOW" } };
      await execution.command("chat", "send", send.body, send.commandId);
      await vi.waitFor(() => expect(fs.readFileSync(path.join(fake, "log.jsonl"), "utf8")).toContain('"event":"turn-start"'), { timeout: 10_000 });
      let finishMutation!: (value: unknown) => void;
      client.bindBusiness(() => new Promise((resolve) => { finishMutation = resolve; }));
      const mutation = callTool();
      await vi.waitFor(() => expect(finishMutation).toBeTypeOf("function"));
      const filesBeforeRefusal = fs.readdirSync(root);
      const update = createConsoleUpdateApplyService({
        fleetDataDir: root, tmpDir: root, workerRuntimePath: fileURLToPath(new URL("../dist/lifecycle-worker-runtime.mjs", import.meta.url)),
        preflightInstall: () => ({ bin: process.execPath, command: "npm", globalRoot: root, prefixArgs: [] }),
        downloadTarball: async () => ({ ok: true, tarballPath: path.join(root, "candidate.tgz") }),
        sessionHost: { prepareUpdate: (id) => client!.prepareUpdate(id), cancelUpdate: async () => {}, commitUpdate: async () => {} },
        spawnWorker: () => { throw new Error("A pending permission must not launch an installer."); },
      });
      await expect(update.start({ currentEndpoint: held.payload.endpoint, currentLockToken: held.payload.token, currentLockStartedAt: held.payload.startedAt, currentPackageRoot: root, currentPid: process.pid, dataDir: root, fromVersion: "1.0.0", lockFile, release: { schema: 1, package: "@dotobokuri/fleet-console", version: "1.0.1", tag: "v1.0.1", tarball: { name: "fleet-console-1.0.1.tgz", size: 1, sha256: "0".repeat(64) } } })).rejects.toMatchObject({ progress: { state: "failed", reason: "session-business-pending" } });
      expect(readConsoleUpdateProgress(root)).toMatchObject({ reason: "session-business-pending", description: expect.stringContaining("still running") });
      expect(fs.readdirSync(root).filter((name) => !filesBeforeRefusal.includes(name))).toEqual(["update-progress.json"]);
      expect((await client.listSessions()).sessions.find((item) => item.sessionKey === sdk.sessionKey)?.runtime.pid).toBe(sdk.runtime.pid);
      finishMutation({ content: [{ type: "text", text: "drained" }] });
      expect(await mutation).toMatchObject({ result: { content: [{ text: "drained" }] } });
      client.bindBusiness(() => ({ $sessionHostDeferred: true, turnId: "turn-one", permissionEpoch: 7, lifetime: "turn", expiresAt: null, presentation: { kind: "approval" } }));
      const pendingTool = callTool();
      let pendingRequestId = "";
      await vi.waitFor(async () => {
        const snap = await client!.listSessions();
        const pending = snap.sessions.find((s) => s.sessionKey === sdk.sessionKey)!.runtime.pendingBusiness as { requestId: string; deferred?: unknown }[];
        expect(pending[0]?.deferred).toBeTruthy(); pendingRequestId = pending[0]!.requestId;
      });
      const before = await client.listSessions();
      const ref = await client.prepareUpdate("update-one");
      expect(JSON.stringify(ref)).not.toContain(client.manifest.capability);
      keeper = await connectSessionUpdateKeeper(ref); await client.commitUpdate("update-one");
      execution.detach(); client.closeObserver(); held.release();
      const duringGap = callTool();
      held = await lock.acquireLock({ dir: root, lockFile, pid: process.pid, port: 2, endpoint: "http://127.0.0.1:2/", version: "successor" });
      client = await SessionHostClient.attach(root, fileURLToPath(new URL("../", import.meta.url)), held.payload, env, createWindowsSessionPlatform());
      execution = await HostedExecution.attach(client, (_kind, error) => { throw error; });
      execution.bind("fixture-tools", () => ({ content: [{ type: "text", text: `successor-${++toolCalls}` }] }));
      const successorSdk = createHostedSdk(execution, sdkOptions, binding);
      const adopted = await successorSdk.openSession({ model: "opus", cwd: root, permissionMode: "dontAsk" });
      await execution.ready();
      const continued = (async () => { for await (const message of adopted) if (message.type === "result") return message; throw new Error("proxy result missing"); })();
      const after = await client.listSessions();
      expect((await client.describe(sdk.sessionKey)).kind).toBe("sdk");
      const frozen = await client.describe(sdk.sessionKey);
      expect(frozen.kind === "sdk" && frozen.embeddedTools?.[0]?.port).toBe("fixture-tools");
      expect(frozen.kind === "sdk" && frozen.request.model).toBe("opus");
      expect((after.sessions.find((s) => s.sessionKey === sdk.sessionKey)!.runtime.pendingBusiness as { deferred: { lifetime: string; expiresAt: null } }[])[0]?.deferred).toMatchObject({ lifetime: "turn", expiresAt: null });
      await expect(client.answerBusiness(pendingRequestId, 8, {})).rejects.toThrow("session_permission_stale");
      await client.answerBusiness(pendingRequestId, 7, { content: [{ type: "text", text: "approved-after-update" }] });
      expect(await pendingTool).toMatchObject({ result: { content: [{ text: "approved-after-update" }] } });
      expect(await duringGap).toMatchObject({ result: { content: [{ text: "successor-2" }] } });
      expect(await callTool()).toMatchObject({ result: { content: [{ text: "successor-3" }] } });
      expect(after.hostId).toBe(before.hostId); expect(after.epoch).toBeGreaterThan(before.epoch);
      expect(after.sessions.find((s) => s.sessionKey === sdk.sessionKey)?.runtime.pid).toBe(sdk.runtime.pid);
      expect(sdk.runtime.runnerPid).toBeTypeOf("number");
      expect(after.sessions.find((s) => s.sessionKey === sdk.sessionKey)?.runtime.runnerPid).toBe(sdk.runtime.runnerPid);
      expect(after.sessions.find((s) => s.sessionKey === "terminal")?.runtime.pid).toBe(terminal.runtime.pid);
      expect(after.sessions.find((s) => s.sessionKey === sdk.sessionKey)?.launchFingerprint).toEqual({ schema: 1, digest: "fixture" });
      expect(after.sessions.find((s) => s.sessionKey === sdk.sessionKey)?.lastCommandSequence).toBe(1);
      expect(fs.existsSync(retiredRoot)).toBe(true); // 살아 있는 old runner는 업데이트 뒤에도 보호한다.
      await client.command({ sessionKey: "retiring", commandId: "close-old", sequence: 1, kind: "close" });
      await vi.waitFor(() => expect(fs.existsSync(path.join(retiredRoot, ".retired"))).toBe(true), { timeout: 15_000 });
      expect(fs.existsSync(retiredRoot)).toBe(true); // symlink가 있는 tree는 종료 증명이 있어도 회수하지 않는다.
      expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
      await vi.waitFor(() => expect(fs.readFileSync(path.join(root, "session-host/failures.jsonl"), "utf8")).toContain("untrusted_generation_tree"));
      fs.unlinkSync(escape);
      await client.command(send);
      await expect(client.command({ ...send, body: { input: "different" } })).rejects.toThrow("session_command_id_conflict");
      await expect(first.command({ ...send, commandId: "stale", sequence: 2 })).rejects.toThrow();
      fs.writeFileSync(path.join(fake, "release"), "go");
      await expect(continued).resolves.toMatchObject({ type: "result" });
      await vi.waitFor(async () => expect((await client!.readEvents(sdk.sessionKey, 0)).events.some((e) => e.kind === "sdk-message" && (e.data as { type?: string }).type === "result")).toBe(true), { timeout: 10_000 });
      const launches = fs.readFileSync(path.join(fake, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string });
      expect(launches.filter((e) => e.event === "launch")).toHaveLength(1);
      expect(launches.filter((e) => e.event === "turn-start")).toHaveLength(1);
      await client.command({ sessionKey: "terminal", commandId: "write-one", sequence: 1, kind: "write", body: { data: `continued${process.platform === "win32" ? "\r" : "\n"}` } });
      await vi.waitFor(async () => expect((await client!.readEvents("terminal", 0)).events.filter((e) => e.kind === "pty-data").map((e) => String(e.data)).join("")).toContain("continued"), { timeout: 10_000 });
      const incompatibleExecution = await HostedExecution.attach(client, () => {}, env);
      const incompatible = createHostedSdk(incompatibleExecution, sdkOptions, { ...binding, tools: [{ ...binding.tools[0]!, tools: [{ ...binding.tools[0]!.tools[0]!, inputSchema: { type: "object", properties: { changed: { type: "string" } } } }] }] });
      await expect(incompatible.openSession({ model: "opus", cwd: root })).rejects.toThrow("session_tool_schema_incompatible");
      keeper.close();
      const stoppingGap = await client.prepareUpdate("update-stop-gap"); keeper = await connectSessionUpdateKeeper(stoppingGap); await client.commitUpdate("update-stop-gap");
      client.closeObserver(); held.release();
      expect(fs.existsSync(lockFile)).toBe(false);
      await stopSlotSessionHost(root);
      for (const pid of [before.sessions[0]?.runtime.pid, sdk.runtime.runnerPid, terminal.runtime.pid, before.hostId === after.hostId ? client.manifest.pid : 0]) if (typeof pid === "number" && pid > 1) await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 15_000 });
      if (process.platform === "win32") {
        const journal = fs.readFileSync(path.join(root, "session-host/failures.jsonl"), "utf8");
        expect(journal).toContain('"kind":"session_host_jobs_drained","generation":null,"reason":"remainingJobs=0"');
        expect(journal).not.toContain('"kind":"session_host_stop_deadline"');
        expect(journal).not.toContain('"kind":"session_runner_stop_deadline"');
        const drained = journal.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; reason?: string }).find((row) => row.kind === "session_host_jobs_drained")!;
        console.info("session-host-windows-proof", JSON.stringify({ runnerBefore: sdk.runtime.runnerPid, runnerAfter: after.sessions.find((s) => s.sessionKey === sdk.sessionKey)!.runtime.runnerPid, remainingJobs: Number(drained.reason!.split("=")[1]) }));
      }
      recordSessionUpdateIncompatibility(root, "1.0.0", "1.0.1");
      writeConsoleUpdateProgress(root, { phase: "completed", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), fromVersion: "1.0.0", targetVersion: "1.0.1" });
      expect(readConsoleUpdateProgress(root)).toMatchObject({ reason: "session-bridge-incompatible", description: expect.stringContaining("ready for new sessions") });
      held = await lock.acquireLock({ dir: root, lockFile, pid: process.pid, port: 3, endpoint: "http://127.0.0.1:3/", version: "gc-successor" });
      client = await SessionHostClient.attach(root, fileURLToPath(new URL("../", import.meta.url)), held.payload, env, createWindowsSessionPlatform());
      await vi.waitFor(() => {
        const deferred = fs.readFileSync(path.join(root, "session-host/failures.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; reason?: string }).filter((row) => row.kind === "session_generation_gc_deferred").map((row) => row.reason);
        expect(fs.existsSync(retiredRoot), `generation collection diagnostics: ${JSON.stringify(deferred)}`).toBe(false);
      }, { timeout: 15_000 });
      expect(fs.existsSync(client.generation.root)).toBe(true);
      expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
      if (process.platform === "win32") console.info("session-host-windows-gc-proof", JSON.stringify({ retiredCollected: !fs.existsSync(retiredRoot), currentRetained: fs.existsSync(client.generation.root), outsideSentinelPreserved: fs.readFileSync(path.join(outside, "keep"), "utf8") === "untouched" }));
      execution = await HostedExecution.attach(client, () => {}, env);
      const cleanSdk = createHostedSdk(execution, sdkOptions, { key: "chat" });
      const freshSession = await cleanSdk.openSession({ model: "opus", cwd: root });
      await execution.ready(); freshSession.send("after incompatible update");
      const freshResult = (async () => { for await (const message of freshSession) if (message.type === "result") return message; throw new Error("fresh result missing"); })();
      await expect(freshResult).resolves.toMatchObject({ type: "result" });
      expect(execution.get("chat")!.runtime.pid).not.toBe(sdk.runtime.pid);
      await cleanSdk.dispose(); execution.detach();
      await stopSlotSessionHost(root);
    } finally { keeper?.close(); client?.closeObserver(); await stopSlotSessionHost(root).catch(() => {}); held.release(); }
  }, 60_000);

  // Raw host transport coverage cannot prove a replacement Chat controller can answer a still-running SDK ask.
  it("reattaches Chat state and a turn-bound person request without a new CLI or an automatic answer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-chat-controller-")); TEMP_DIRS.push(root);
    const home = path.join(root, "home"); fs.mkdirSync(home); const fake = path.join(root, "fake"); fs.mkdirSync(fake);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_DIR: fake };
    const lockFile = path.join(root, "console.lock"); const lock = createConsoleLock();
    let held = await lock.acquireLock({ dir: root, lockFile, pid: process.pid, port: 1, endpoint: "http://127.0.0.1:1/", version: "fixture" });
    let client: SessionHostClient | null = null; let keeper: { close(): void } | null = null;
    let execution: HostedExecution | null = null; let registry = new AgentChatRegistry();
    const id = "11111111-2222-4333-8444-555555555555";
    const executablePath = fileURLToPath(new URL("../../../.claude/skills/console-e2e/scripts/fake-claude.mjs", import.meta.url));
    const configurationFor = (consoleVersion: string) => createLaunchConfiguration({ consoleVersion, executionBuildId: () => `build-${consoleVersion}`, readTheaterPrompt: () => ({ mode: "append", body: "private fixture prompt" }), listTools: () => [], hookEntry: { entryPath: path.join(root, "hook.mjs"), execPath: process.execPath }, disabledTools: [] });
    let configuration = configurationFor("1.0.0");
    const intent = { surface: "chat" as const, theaterId: "fixture", subagentsBlocked: false, autoMemoryDisabled: false };
    const seed = (sessionId = id): AgentChatSessionSeed => ({
      launchFingerprint: configuration.capture(intent),
      hostedExecution: execution!, baseUrl: "http://127.0.0.1:1", model: "opus", cwd: root, claudeConfigDir: env.CLAUDE_CONFIG_DIR, origin: { kind: "fresh" },
      resolveExecutablePath: async () => executablePath,
      resolveClaudeSession: async () => ({ sessionId, coordinate: { kind: "new", sessionId }, pluginUrl: "", claudeCodeSystemPrompt: "off", sdk: { options: { pluginUrl: "", settingSources: [], allowAmbientMcpServers: false }, request: { sessionId, permissionMode: "bypassPermissions" } } }),
      onProviderSessionUpdate: () => {}, reportActivity: () => true, canReportActivity: () => true, reportAwaiting: () => {}, reportBackgroundPending: () => {},
    });
    try {
      client = await SessionHostClient.attach(root, fileURLToPath(new URL("../", import.meta.url)), held.payload, env, createWindowsSessionPlatform());
      execution = await HostedExecution.attach(client, () => {}, env); await execution.ready();
      const firstChat = await registry.ensure(id, seed); await firstChat.attachHosted();
      firstChat.send("fixture warmup");
      await vi.waitFor(() => expect(fs.readFileSync(path.join(fake, "log.jsonl"), "utf8")).toContain('"event":"turn-end"'), { timeout: 10_000 });
      await vi.waitFor(() => expect(registry.isBusy(id)).toBe(false));
      fs.writeFileSync(path.join(fake, `ask-${id}`), "");
      await vi.waitFor(() => {
        const rows = fs.existsSync(path.join(fake, "log.jsonl")) ? fs.readFileSync(path.join(fake, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; sessionIdArg?: string }) : [];
        expect(firstChat.listPendingAsks(), JSON.stringify(rows.map(({ event, sessionIdArg }) => ({ event, sessionIdArg })))).toHaveLength(1);
      }, { timeout: 10_000 });
      execution.setUpdating(true); await execution.flush();
      const before = execution.get(`chat:${id}`)!;
      const ref = await client.prepareUpdate("chat-controller-update"); keeper = await connectSessionUpdateKeeper(ref); await client.commitUpdate("chat-controller-update");
      execution.detach(); registry.detachAll(); client.closeObserver(); held.release();
      held = await lock.acquireLock({ dir: root, lockFile, pid: process.pid, port: 2, endpoint: "http://127.0.0.1:2/", version: "successor" });
      client = await SessionHostClient.attach(root, fileURLToPath(new URL("../", import.meta.url)), held.payload, env, createWindowsSessionPlatform());
      execution = await HostedExecution.attach(client, () => {}, env); registry = new AgentChatRegistry();
      configuration = configurationFor("1.0.1");
      const adopted = await registry.ensure(id, seed); await execution.ready();
      expect(execution.get(`chat:${id}`)!.runtime.pid).toBe(before.runtime.pid);
      expect(adopted.launchFingerprint).toEqual(before.launchFingerprint);
      const observed = createConsoleObservabilityStore({ canonicalizeTheaterPath: (value) => value, workspaceHash: () => "fixture", describeLaunchConfiguration: (fingerprint) => configuration.describe(fingerprint) });
      observed.createPendingTerminalSession({ sessionId: id, cwd: root, cliId: "claude" });
      observed.setTerminalSessionChatActive(id, true);
      const previous = observed.setTerminalSessionLaunchFingerprint(id, adopted.launchFingerprint);
      expect(previous).toMatchObject({ configurationState: "previous", configurationRelease: "1.0.0" });
      expect(JSON.stringify(previous)).not.toContain(before.launchFingerprint!.digest);
      expect(JSON.stringify(previous)).not.toContain("private fixture prompt");
      await vi.waitFor(() => expect(adopted.listPendingAsks()).toHaveLength(1));
      const events = () => fs.readFileSync(path.join(fake, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string });
      expect(events().filter((event) => event.event === "launch")).toHaveLength(1);
      expect(events().some((event) => event.event === "ask-answered")).toBe(false);
      expect(adopted.answer(adopted.listPendingAsks()[0]!.id, { approve: true })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(events().some((event) => event.event === "ask-answered")).toBe(true));
      await vi.waitFor(() => expect(registry.isBusy(id)).toBe(false));
      expect(events().filter((event) => event.event === "launch")).toHaveLength(1);
      const freshId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const fresh = await registry.ensure(freshId, () => seed(freshId)); await fresh.attachHosted();
      expect(execution.get(`chat:${freshId}`)!.runtime.pid).not.toBe(before.runtime.pid);
      expect(fresh.launchFingerprint?.consoleVersion).toBe("1.0.1");
      observed.createPendingTerminalSession({ sessionId: freshId, cwd: root, cliId: "claude" });
      observed.setTerminalSessionChatActive(freshId, true);
      expect(observed.setTerminalSessionLaunchFingerprint(freshId, fresh.launchFingerprint)).toMatchObject({ configurationState: "current" });
    } finally { execution?.detach(); registry.detachAll(); keeper?.close(); client?.closeObserver(); await stopSlotSessionHost(root).catch(() => {}); held.release(); }
  }, 60_000);

  it("ends an unapproved observer loss instead of leaving a headless session orphan", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-session-crash-")); TEMP_DIRS.push(root);
    const held = await createConsoleLock().acquireLock({ dir: root, lockFile: path.join(root, "console.lock"), pid: process.pid, port: 1, endpoint: "http://127.0.0.1:1/", version: "fixture" });
    const ownedTmp = path.join(root, "long-owned-temporary-namespace-".repeat(3)); fs.mkdirSync(ownedTmp);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, ".claude"), TMPDIR: ownedTmp, TMP: ownedTmp, TEMP: ownedTmp };
    let client: SessionHostClient | null = null;
    try {
      client = await SessionHostClient.attach(root, fileURLToPath(new URL("../", import.meta.url)), held.payload, env, createWindowsSessionPlatform());
      if (process.platform !== "win32") {
        expect(client.manifest.socket).not.toContain(ownedTmp);
        expect(fs.lstatSync(client.manifest.socket).isSocket()).toBe(true);
        expect(fs.lstatSync(client.manifest.socket).mode & 0o777).toBe(0o600);
        expect(fs.lstatSync(path.dirname(client.manifest.socket)).mode & 0o777).toBe(0o700);
        const diagnostic = fs.readFileSync(path.join(root, "session-host/failures.jsonl"), "utf8");
        expect(diagnostic).toContain("session_socket_namespace_relocated");
        expect(diagnostic).not.toContain(client.manifest.capability);
      }
      const session = await client.open({ kind: "pty", sessionKey: "terminal", generation: client.generation, launch: { bin: process.execPath, args: ["-e", "setInterval(()=>{},1<<30)"], cwd: root, env }, size: { cols: 80, rows: 24 } });
      const pid = Number(session.runtime.pid); const hostPid = client.manifest.pid;
      client.closeObserver();
      await vi.waitFor(() => { expect(isRunning(pid)).toBe(false); expect(isRunning(hostPid)).toBe(false); }, { timeout: 15_000 });
    } finally { client?.closeObserver(); await stopSlotSessionHost(root).catch(() => {}); held.release(); }
  }, 45_000);
});

describe("Console daemon lifecycle integration", () => {
  it("keeps a real child through delayed readiness and later stops it, killing a stalled shutdown", async () => {
    const fixture = createFixturePaths("ready");
    const lifecycle = createConsoleDaemonLifecycle({
      env: { ...fixture.env, FLEET_TEST_CONSOLE_BIND_BEFORE_READY: "1" },
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 8_000,
      escalationMs: 400,
      pollIntervalMs: 20,
      report: () => {},
    });

    const startedAt = Date.now();
    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const pid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(pid);
    await vi.waitFor(async () => expect((await lifecycle.probe()).starting).toBe(true));
    const lockBefore = fs.readFileSync(fixture.lockFile, "utf8");
    // 이미 lock을 잡고 초기화 중인 Console은 다른 start의 짧은 대기 한도로 죽거나 교체되지 않는다.
    const impatient = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH, startupTimeoutMs: 100, pollIntervalMs: 10 });
    await expect(impatient.ensureDaemon()).rejects.toThrow("was not signalled");
    expect(fs.readFileSync(fixture.lockFile, "utf8")).toBe(lockBefore);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const concurrentEnsure = lifecycle.ensureDaemon();
    void concurrentEnsure.catch(() => {});
    // 시작 시각 재증명은 프로세스가 PROCESS_START_MARGIN_MS보다 오래 살아야 한다. 3초 경계는 가짜 시계 케이스가 증명하고,
    // 강제 종료 사다리만 테스트 예산으로 줄인다.
    await delay(PROCESS_START_MARGIN_MS + 500);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");

    const endpoint = await ensure;
    expect(await concurrentEnsure).toBe(endpoint);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PROCESS_START_MARGIN_MS);
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(pid);

    // SIGTERM을 받은 Console이 listener만 닫고 lock을 쥔 채 멈춘다. 테스트 예산(escalationMs)이 지나도록 lock을 놓지 않으면, SIGTERM
    // 전에 증명한 그 프로세스임을 다시 증명한 뒤 강제 종료한다. 생산 사다리는 EXTERNAL_ESCALATION_MS다. Windows의 SIGTERM은 TerminateProcess라 정리가 아예 돌지 않는다 —
    // 멈출 정리가 없으니 강제 종료도 아니며, 남은 lock은 끝난 pid의 것이라 stop이 치운다. 정체를 SIGKILL로 끝내는 계약은 POSIX에서만 성립한다.
    fs.writeFileSync(fixture.stallFile, "stall\n", "utf8");
    const stoppedAt = Date.now();
    expect(await lifecycle.stop()).toEqual(process.platform === "win32" ? { outcome: "unrecorded", killed: 0 } : { outcome: "forced-external", killed: 0 });
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    await expectProcessGone(pid);
    CHILD_PIDS.delete(pid);
    expect(readConsoleLockFile(fixture.lockFile)).toBeNull();
    expectFileCanBeRenamed(fixture.pidFile);
  });

  it("terminates the real pre-lock child when readiness reaches its deadline", async () => {
    const fixture = createFixturePaths("timeout");
    const lifecycle = createConsoleDaemonLifecycle({
      env: fixture.env,
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 20,
    });

    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const pid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(pid);

    await expect(ensure).rejects.toThrow("did not become healthy within 2 seconds");
    await expectProcessGone(pid);
    CHILD_PIDS.delete(pid);
    expect(readConsoleLockFile(fixture.lockFile)).toBeNull();
    expectFileCanBeRenamed(fixture.pidFile);
  });
  it("never signals a live process that a stale lock's pid now names", async () => {
    // Console이 lock을 남기고 죽은 뒤 OS가 그 pid를 다른 프로세스에 재할당한 상황이다.
    const fixture = createFixturePaths("reused-pid");
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
    const bystanderPid = bystander.pid!;
    CHILD_PIDS.add(bystanderPid);
    let bystanderSignal: NodeJS.Signals | null = null;
    bystander.once("exit", (_code, signal) => { bystanderSignal = signal ?? "SIGHUP"; });
    // lock 주소에서 무언가 듣고 있지만 lock token을 증명하지 못한다 — 멈춘 Console일 수도 있으므로 lock도 지우지 않는다.
    const impostor = http.createServer((_request, response) => response.writeHead(401).end());
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const port = (impostor.address() as AddressInfo).port;
    const lockInput = { dir: fixture.dir, lockFile: fixture.lockFile, pid: bystanderPid, port, endpoint: `http://127.0.0.1:${port}/`, version: "crashed" };
    const consoleLock = createConsoleLock();
    await consoleLock.acquireLock(lockInput);
    const lifecycle = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH, pollIntervalMs: 20, escalationMs: 400 });

    await expect(lifecycle.stop()).rejects.toThrow(`lock pid ${bystanderPid} is alive but did not prove it owns`);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);

    // 아무도 lock 주소를 듣지 않는데 lock을 쓰기 전에 시작한 pid가 살아 있으면, listener를 닫고 정리 중인 Console과 구별되지
    // 않는다(계약의 stopping). 정지 예산만큼 기다릴 뿐 신호도 lock 삭제도 하지 않는다 — 지우면 다음 start가 살아 있는 Console
    // 옆에 두 번째 Console을 띄운다.
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
    const stoppingAt = Date.now();
    await expect(lifecycle.stop()).rejects.toThrow(`lock pid ${bystanderPid} no longer answers at the lock's address`);
    // 닫힌 포트가 바로 거절되지 않으면 probe가 HEALTH_PROBE_TIMEOUT_MS를 다 쓰고, Windows에서는 그 중단이
    // 예산보다 늦게 돌아온다. 관측된 초과는 2초 안이고, 생산 사다리 EXTERNAL_ESCALATION_MS와는 여전히 구분된다.
    expect(Date.now() - stoppingAt).toBeLessThan(HEALTH_PROBE_TIMEOUT_MS + 3_000);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);

    // A pid that started after the lock was written cannot be its author, but while that pid lives the lock stays: only
    // ESRCH right before the unlink grants deletion. start refuses instead of booting a Console beside it.
    fs.rmSync(fixture.lockFile);
    await createConsoleLock({ now: () => Date.now() - 60_000 }).acquireLock(lockInput);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");
    await expect(lifecycle.ensureDaemon()).rejects.toThrow(describeReplacedLockAuthor(fixture.lockFile, bystanderPid));
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);
    expect(fs.existsSync(fixture.pidFile)).toBe(false);
    expect(bystanderSignal).toBeNull();
    expect(() => process.kill(bystanderPid, 0)).not.toThrow();
  });

  it("lets one live reclaimer at a time act on a dead lock and hands over only after it exits", async () => {
    const fixture = createFixturePaths("reclaim-chain");
    const bystanderPid = spawnIdleProcess();
    const lockInput = { dir: fixture.dir, lockFile: fixture.lockFile, pid: bystanderPid, port: await closedPort(), version: "crashed" };
    const consoleLock = createConsoleLock();
    await consoleLock.acquireLock({ ...lockInput, endpoint: `http://127.0.0.1:${lockInput.port}/` });

    // A separate reclaimer reaches its final check while the lock's pid still runs: it removes nothing, and its reclaim
    // marker stays complete for as long as that reclaimer lives.
    const claimant = spawn(process.execPath, ["--import", TSX_LOADER_URL, CLAIMANT_FIXTURE_PATH, fixture.lockFile], { stdio: ["ignore", "pipe", "inherit"] });
    const claimantPid = claimant.pid!;
    CHILD_PIDS.add(claimantPid);
    expect(await readFirstLine(claimant)).toBe("alive");
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);

    // The lock is dead now, yet no other reclaimer may take over while that claimant is alive: start fails and keeps it.
    process.kill(bystanderPid, "SIGKILL");
    await expectProcessGone(bystanderPid);
    CHILD_PIDS.delete(bystanderPid);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");
    const lifecycle = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH, startupTimeoutMs: 8_000, pollIntervalMs: 20, report: () => {} });
    await expect(lifecycle.ensureDaemon()).rejects.toThrow();
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);
    expect(fs.existsSync(fixture.pidFile)).toBe(false);

    // Once the claimant has exited, the next reclaimer takes over, removes the dead lock, and the new Console owns the slot.
    claimant.kill("SIGKILL");
    await expectProcessGone(claimantPid);
    CHILD_PIDS.delete(claimantPid);
    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const consolePid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(consolePid);
    await expect(ensure).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(consolePid);

    await lifecycle.stop();
    await expectProcessGone(consolePid);
    CHILD_PIDS.delete(consolePid);
  });

  it("keeps the lock a reused pid published when cleaning up an exited child", async () => {
    // The spawned Console exits and its pid now names another live process that published a lock of its own. The exit
    // event is no evidence about that lock, so cleanup keeps it and reports why.
    const fixture = createFixturePaths("child-pid-reused");
    const bystanderPid = spawnIdleProcess();
    const port = await closedPort();
    const reusedLock = { pid: bystanderPid, host: "127.0.0.1", port, endpoint: `http://127.0.0.1:${port}/`, startedAt: Date.now(), token: "reused-pid-token", version: "other" };
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const lifecycle = createConsoleDaemonLifecycle({
      env: fixture.env,
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 8_000,
      pollIntervalMs: 20,
      report: () => {},
      spawnDaemon: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: bystanderPid,
          kill: (signal?: NodeJS.Signals | number) => { signals.push(signal); return true; },
          unref: () => {},
        }) as EventEmitter & ConsoleDaemonProcess;
        fs.mkdirSync(fixture.dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(fixture.lockFile, `${JSON.stringify(reusedLock, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        setImmediate(() => child.emit("exit", 1, null));
        return child;
      },
    });

    await expect(lifecycle.ensureDaemon()).rejects.toThrow();
    expect(readConsoleLockFile(fixture.lockFile)).toEqual(reusedLock);
    expect(signals).toEqual([]);
    expect(() => process.kill(bystanderPid, 0)).not.toThrow();
  });

  // L13 (I1, I2). Once its Console is gone (the pipe ends), the reaper ends every registered group it can prove is still that
  // group — one whose leader still runs, and one whose leader exited and whose first process-table read fails — never a
  // registration a reused number would make it signal, records that the Console vanished, and exits within its drain cap.
  it.skipIf(process.platform === "win32")("lets the reaper end only the groups it proves, then exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-reaper-"));
    TEMP_DIRS.push(dir);
    const lockFile = path.join(dir, "console.lock");
    const consolePid = await deadProcessPid();
    const lockStartedAt = Date.now();
    const leading = (spawnedAt: number, args: readonly string[]) => {
      const child = spawn(args[0]!, args.slice(1), { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      CHILD_PIDS.add(child.pid!);
      return { child, group: { pgid: child.pid!, spawnedAt, leaderExitedAt: null } };
    };
    const owned = leading(Date.now(), ["/bin/sleep", "300"]);
    // The number a registration names may belong to another process by now: its start time does not match.
    const reused = leading(Date.now() - 600_000, ["/bin/sleep", "300"]);
    const orphaned = leading(Date.now(), ["/bin/sh", "-c", "/bin/sleep 300 & echo $!"]);
    const member = Number((await readFirstLine(orphaned.child as ChildProcessByStdio<null, Readable, null>)).trim());
    CHILD_PIDS.add(member);
    await new Promise((resolve) => orphaned.child.once("exit", resolve));
    // The first process-table read fails; the reaper must ask again.
    const shim = path.join(dir, "bin");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "ps"), `#!/bin/sh\nif [ ! -f ${JSON.stringify(path.join(dir, "failed-once"))} ]; then : > ${JSON.stringify(path.join(dir, "failed-once"))}; exit 1; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });

    const reaper = spawn(process.execPath, ["--import", TSX_LOADER_URL, REAPER_SOURCE], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, PATH: [shim, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") },
    });
    CHILD_PIDS.add(reaper.pid!);
    const reaperExit = new Promise<void>((resolve) => reaper.once("exit", () => resolve()));
    const line = (message: unknown) => reaper.stdin!.write(`${JSON.stringify(message)}\n`);
    line({ hello: { consolePid, lockFile, lockStartedAt } });
    for (const entry of [owned, reused, orphaned]) line({ add: entry.group });
    line({ leaderExited: { pgid: orphaned.group.pgid, at: Date.now() } });
    reaper.stdin!.end();

    const ended = await Promise.race([reaperExit.then(() => true), delay(REAPER_DRAIN_MAX_MS + 5_000).then(() => false)]);
    expect(ended, "the reaper exits within its drain cap").toBe(true);
    expect(isRunning(owned.group.pgid), "a proven group whose leader runs is ended").toBe(false);
    expect(isRunning(member), "a proven group whose leader exited is ended after a failed table read").toBe(false);
    expect(isRunning(reused.group.pgid), "a registration its process does not match is never signalled").toBe(true);
    expect(fs.existsSync(path.join(dir, "failed-once"))).toBe(true);
    expect(readConsoleExitRecord(lockFile, { pid: consolePid, lockStartedAt })?.outcome).toBe("external");
  }, 30_000);

  // After the owned groups, the deadline SIGKILLs what no one registered. Only this Console's own descendants that stay in its
  // process group qualify: never the group as a whole (a Desktop sidecar shares Desktop's group), never a child that leads a
  // group of its own (an owned group, the update worker and the Console it starts, a PTY session), never the ps that
  // produced the table.
  it("limits the deadline's fallback SIGKILL to unregistered descendants that stay in the Console's process group", () => {
    const rows = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 500, ppid: 1, pgid: 500 }, // Desktop
      { pid: 600, ppid: 500, pgid: 500 }, // the Console sidecar, in Desktop's group
      { pid: 601, ppid: 500, pgid: 500 }, // another child of Desktop
      { pid: 610, ppid: 600, pgid: 500 }, // an unregistered tool call
      { pid: 611, ppid: 610, pgid: 500 }, // its child
      { pid: 615, ppid: 600, pgid: 615 }, // an owned agent CLI group
      { pid: 616, ppid: 615, pgid: 615 }, // its MCP child
      { pid: 620, ppid: 600, pgid: 620 }, // detached update worker
      { pid: 621, ppid: 620, pgid: 620 }, // the Console the worker starts
      { pid: 630, ppid: 600, pgid: 630 }, // PTY session leader
      { pid: 631, ppid: 630, pgid: 630 }, // a process in that terminal
      { pid: 640, ppid: 600, pgid: 500 }, // the ps that listed this table
    ];
    expect(selectSameGroupDescendants(rows, 600, [640]).sort((left, right) => left - right)).toEqual([610, 611]);
    expect(selectSameGroupDescendants(rows.filter((row) => row.pid !== 600), 600)).toEqual([]);
  });

  // The deadline signals a registered group whose leader already exited only when the process table proves the members are
  // that group's: a number now held by a live process (the leader's pid reused) or members that started before the group
  // was spawned mean the number names someone else's group, which is never signalled (I1).
  it("signals an exited-leader group only when its members prove to be that group's", async () => {
    const spawnedAt = Date.UTC(2026, 9, 5, 12, 0, 0);
    const group = { pgid: 700, spawnedAt };
    const member = { pid: 701, pgid: 700, startedAt: spawnedAt + 1_000 };
    expect(proveExitedLeaderGroup([member], group, spawnedAt + 60_000)).toBe(true);
    expect(proveExitedLeaderGroup([{ pid: 700, pgid: 700, startedAt: spawnedAt + 30_000 }, member], group, spawnedAt + 60_000)).toBe(false);
    expect(proveExitedLeaderGroup([member, { pid: 702, pgid: 700, startedAt: spawnedAt - 600_000 }], group, spawnedAt + 60_000)).toBe(false);
    expect(proveExitedLeaderGroup([], group, spawnedAt + 60_000)).toBe(false);
    expect(proveExitedLeaderGroup([{ pid: 2, pgid: 1, startedAt: spawnedAt }], { pgid: 1, spawnedAt }, spawnedAt + 60_000)).toBe(false);

    // 기존 exited-leader 증명 사례를 실제 등록부 정지 경계로 확장한다. stop 전 종료된 세션의 잔여는
    // 평상시에는 그대로 두지만, beginStop의 최초 훑기에서는 놓치지 않아야 한다. Windows는 built W1이 검증한다.
    if (process.platform !== "win32") {
      const registry = createOwnedProcessRegistry();
      const child = registry.spawn({
        command: process.execPath,
        args: ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1<<30)'],{stdio:'inherit'});console.log(c.pid);setTimeout(()=>process.exit(0),100);"],
        env: process.env,
      });
      CHILD_PIDS.add(child.pid!);
      const memberPid = Number(await readFirstLine(child as ChildProcessByStdio<null, Readable, null>));
      CHILD_PIDS.add(memberPid);
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      await delay(200);
      expect(isRunning(memberPid), "평상시에는 종료된 리더의 잔여를 정지시키지 않는다").toBe(true);
      registry.beginStop(() => false, 200);
      await delay(50);
      expect(isRunning(memberPid), "기존 잔여에도 정지 grace를 준다").toBe(true);
      await vi.waitFor(() => expect(isRunning(memberPid), "활성화 때 이미 종료된 리더의 잔여도 정리한다").toBe(false), { timeout: 3_000 });
    }
  });
});

// The representative Windows containment failure, at the port rather than a second Console boot. A failed create or
// assign is reported and returns null, a throw does not escape, and a job that still has members is not closed.
describe("Windows job containment failure", () => {
  it("reports a failed job and never throws or closes a job that still has members", () => {
    const closed: string[] = [];
    const bindings = (overrides: Partial<WindowsJobBindings>): WindowsJobBindings => ({
      createJob: () => "job",
      setKillOnJobClose: () => true,
      openProcess: () => "proc",
      assign: () => true,
      activeProcesses: () => 1,
      terminate: () => true,
      close: (handle) => { closed.push(String(handle)); },
      lastError: () => 5,
      ...overrides,
    });

    const created: string[] = [];
    expect(createWindowsJobContainment(bindings({ setKillOnJobClose: () => false }), (detail) => created.push(detail.stage)).contain(41)).toBeNull();
    expect(created).toEqual(["create"]);
    expect(closed.splice(0)).toEqual(["job"]);

    const assigned: string[] = [];
    expect(createWindowsJobContainment(bindings({ assign: () => false }), (detail) => assigned.push(detail.stage)).contain(42)).toBeNull();
    expect(assigned).toEqual(["assign"]);
    expect(closed.splice(0)).toEqual(["proc", "job"]);

    const thrown: string[] = [];
    expect(createWindowsJobContainment(bindings({ createJob: () => { throw new Error("injected"); } }), (detail) => thrown.push(detail.stage)).contain(43)).toBeNull();
    expect(thrown).toEqual(["create"]);

    const port = createWindowsJobContainment(bindings({}), () => { throw new Error("a live job must not be reported degraded"); });
    const held = port.contain(44);
    expect(held?.hasMembers()).toBe(true);
    held?.close();
    expect(closed).toEqual([]);
  });
});

function createFixturePaths(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-console-lifecycle-${name}-`));
  TEMP_DIRS.push(dir);
  const pidFile = path.join(dir, "child.pid");
  const releaseFile = path.join(dir, "release");
  const stallFile = path.join(dir, "stall");
  const env = {
    ...process.env,
    FLEET_CONSOLE_DATA_DIR: dir,
    FLEET_TEST_CONSOLE_PID_FILE: pidFile,
    FLEET_TEST_CONSOLE_RELEASE_FILE: releaseFile,
    FLEET_TEST_CONSOLE_STALL_FILE: stallFile,
  };
  const lockFile = createConsolePaths({ env }).lockFile;
  return { dir, env, pidFile, releaseFile, stallFile, lockFile };
}

function spawnIdleProcess(): number {
  const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  CHILD_PIDS.add(idle.pid!);
  return idle.pid!;
}

/** A loopback port nothing listens on, so the lock's endpoint refuses connections. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function readFirstLine(child: ChildProcessByStdio<null, Readable, null>): Promise<string> {
  let output = "";
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`reclaimer printed no outcome: ${output}`)), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(output.slice(0, newline));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`reclaimer exited with ${code}: ${output}`));
    });
  });
}

/** A pid that just exited: the Console a reaper outlives. */
async function deadProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

/** Alive and not a zombie this test still has to reap. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state.length > 0 && !state.startsWith("Z");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPidWhenReady(pidFile: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // fixture가 Node에서 부팅되는 동안 기다린다.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("controlled Console child did not publish its pid");
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`controlled Console child ${pid} is still alive`);
}

function expectFileCanBeRenamed(filePath: string): void {
  const renamed = `${filePath}.renamed`;
  fs.renameSync(filePath, renamed);
  fs.renameSync(renamed, filePath);
}
