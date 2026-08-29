import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { OperationCreateInput, OperationNode, OperationPatchInput } from "@fleet-console/sdk/operations";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAgentRoutes } from "../server/agent.js";
import {
  composeLaunchPromptWithAttachments,
  createLaunchAttachmentStore,
  LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX,
  LaunchAttachmentError,
  MAX_LAUNCH_ATTACHMENTS_PER_LAUNCH,
  MAX_PENDING_LAUNCH_ATTACHMENTS,
  readLaunchAttachmentBody,
  resolveLaunchAttachmentNamespaceRoot,
  sniffLaunchAttachmentImage,
} from "../server/agent-api/launch-attachments.js";
import type { TerminalRuntime } from "../server/shared/index.js";
import { createPluginTerminalTicketRegistry } from "../server/shared/tickets.js";

type TestRequest = http.IncomingMessage & { __body?: Record<string, unknown> };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// 스토어마다 고유 데이터 루트를 주어 네임스페이스가 테스트 간에 겹치지 않게 한다.
function makeStoreDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-attachment-store-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 1x1 투명 PNG — 매직 바이트 판정을 실제 바이트로 통과한다.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("launch attachment sniffing", () => {
  it("accepts the four supported image formats by magic bytes", () => {
    expect(sniffLaunchAttachmentImage(PNG_BYTES)?.mime).toBe("image/png");
    expect(sniffLaunchAttachmentImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(sniffLaunchAttachmentImage(Buffer.from("GIF89a......"))?.mime).toBe("image/gif");
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
    expect(sniffLaunchAttachmentImage(webp)?.mime).toBe("image/webp");
  });

  it("rejects bytes that only claim to be an image", () => {
    // Content-Type 라벨이 아니라 바이트가 판정한다 — 텍스트·스크립트는 이미지 이름표를 달아도 거절된다.
    expect(sniffLaunchAttachmentImage(Buffer.from("plain text pretending"))).toBeNull();
    expect(sniffLaunchAttachmentImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("readLaunchAttachmentBody", () => {
  it("stops reading past the byte cap instead of buffering the whole stream", async () => {
    const req = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]) as unknown as http.IncomingMessage;
    await expect(readLaunchAttachmentBody(req, 10)).rejects.toMatchObject({ code: "attachment_too_large" });
  });

  it("concatenates chunks under the cap", async () => {
    const req = Readable.from([PNG_BYTES.subarray(0, 8), PNG_BYTES.subarray(8)]) as unknown as http.IncomingMessage;
    await expect(readLaunchAttachmentBody(req)).resolves.toEqual(PNG_BYTES);
  });
});

describe("composeLaunchPromptWithAttachments", () => {
  it("appends one instruction line per attachment after the user prompt", () => {
    expect(composeLaunchPromptWithAttachments("fix the bug", ["/tmp/a/image.png", "/tmp/b/image.jpg"])).toBe(
      `fix the bug\n\n${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}/tmp/a/image.png\n${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}/tmp/b/image.jpg`,
    );
  });

  it("leaves a prompt without attachments untouched", () => {
    expect(composeLaunchPromptWithAttachments("fix the bug", [])).toBe("fix the bug");
    expect(composeLaunchPromptWithAttachments(undefined, [])).toBeUndefined();
  });

  it("stands alone when there is no user prompt", () => {
    expect(composeLaunchPromptWithAttachments(undefined, ["/tmp/a/image.png"])).toBe(
      `${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}/tmp/a/image.png`,
    );
  });
});

describe("launch attachment store", () => {
  it("stores bytes as a 0600 file and resolves ids to absolute paths", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    const { id } = store.save(PNG_BYTES);
    const [filePath] = store.resolve([id]);
    expect(filePath).toBeDefined();
    expect(existsSync(filePath as string)).toBe(true);
    expect(filePath).toMatch(/fleet-attachments-.*image\.png$/);
  });

  it("rejects unknown ids and over-limit launches before any spawn", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    expect(() => store.resolve(["missing"])).toThrow(LaunchAttachmentError);
    const ids = Array.from({ length: MAX_LAUNCH_ATTACHMENTS_PER_LAUNCH + 1 }, () => store.save(PNG_BYTES).id);
    expect(() => store.resolve(ids)).toThrowError(expect.objectContaining({ code: "attachment_limit" }));
  });

  it("follows the session lifecycle once bound", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    const { id } = store.save(PNG_BYTES);
    const [filePath] = store.resolve([id]);
    store.bind("session-1", [id]);
    // 발사된 첨부는 다른 실행이 다시 실을 수 없고, 컴포저의 discard도 지우지 못한다.
    expect(() => store.resolve([id])).toThrowError(expect.objectContaining({ code: "attachment_not_found" }));
    store.discard(id);
    expect(existsSync(filePath as string)).toBe(true);
    store.releaseSession("session-1");
    expect(existsSync(filePath as string)).toBe(false);
  });

  it("reserves an id for the spawn window and releases it on failure", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    const { id } = store.save(PNG_BYTES);
    const [filePath] = store.resolve([id]);
    // 스폰 창 동안 같은 id는 두 번째 실행에 실리지 않는다(제거 의사는 별도 계약 — 아래 테스트).
    expect(() => store.resolve([id])).toThrowError(expect.objectContaining({ code: "attachment_not_found" }));
    expect(existsSync(filePath as string)).toBe(true);
    // 스폰 실패가 예약을 되돌리면 재시도가 같은 id를 다시 싣는다.
    store.unreserve([id]);
    expect(store.resolve([id])).toEqual([filePath]);
  });

  it("honors a removal requested during the reservation window", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    const { id } = store.save(PNG_BYTES);
    const [filePath] = store.resolve([id]);
    // 전달 대기 중의 × 클릭 — 그 자리에서는 못 지우지만 의사는 기억된다.
    store.discard(id);
    expect(existsSync(filePath as string)).toBe(true);
    // 전달 실패 → 예약이 풀리며 즉시 회수된다(칩 없는 파일이 TTL까지 남지 않는다).
    store.unreserve([id]);
    expect(existsSync(filePath as string)).toBe(false);
  });

  it("lets a completed delivery outrank a mid-flight removal", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    const { id } = store.save(PNG_BYTES);
    const [filePath] = store.resolve([id]);
    store.discard(id);
    // 전달 성공 — 파일 수명은 세션이 소유하고, 미뤄 둔 제거 의사는 소멸한다.
    store.bind("session-1", [id]);
    expect(existsSync(filePath as string)).toBe(true);
    store.releaseSession("session-1");
    expect(existsSync(filePath as string)).toBe(false);
  });

  it("rolls back sibling reservations when one id in the batch is rejected", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    const { id } = store.save(PNG_BYTES);
    expect(() => store.resolve([id, "missing"])).toThrowError(expect.objectContaining({ code: "attachment_not_found" }));
    // 함께 온 형제의 예약이 남으면 그 id는 어떤 재시도에도 실리지 못한다.
    expect(store.resolve([id])).toHaveLength(1);
  });

  it("reaps only its own namespace leftovers at startup", () => {
    const ownDataDir = makeStoreDataDir();
    const otherDataDir = makeStoreDataDir();
    // 크래시가 남긴 잔재를 흉내 낸다 — 같은 데이터 루트의 동시 실행은 runtime lock이 배제하므로
    // 자기 네임스페이스 안의 파일은 전부 죽은 프로세스의 것이다.
    const ownRoot = resolveLaunchAttachmentNamespaceRoot(ownDataDir);
    const otherRoot = resolveLaunchAttachmentNamespaceRoot(otherDataDir);
    mkdirSync(path.join(ownRoot, "attachment-stale"), { recursive: true });
    mkdirSync(path.join(otherRoot, "attachment-live"), { recursive: true });
    cleanups.push(() => { rmSync(ownRoot, { recursive: true, force: true }); rmSync(otherRoot, { recursive: true, force: true }); });

    const store = createLaunchAttachmentStore({ dataDir: ownDataDir });
    cleanups.push(() => store.cleanup());

    expect(existsSync(ownRoot)).toBe(false);
    // 다른 인스턴스(dev/published 채널)의 네임스페이스는 나이와 무관하게 밟지 않는다 —
    // 그 안의 파일이 살아 있는 Operation에 묶여 있는지는 그 프로세스만 안다.
    expect(existsSync(path.join(otherRoot, "attachment-live"))).toBe(true);
  });

  it("caps how many unsent uploads can pile up", () => {
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir() });
    cleanups.push(() => store.cleanup());
    for (let index = 0; index < MAX_PENDING_LAUNCH_ATTACHMENTS; index += 1) store.save(PNG_BYTES);
    // 회당 상한(4장)은 컴포저 계약이고 이것은 디스크 계약이다 — 발사에 묶이면 자리가 돌아온다.
    expect(() => store.save(PNG_BYTES)).toThrowError(expect.objectContaining({ code: "attachment_storage_exhausted" }));
  });

  it("resets the TTL clock when a launch resolves an attachment", () => {
    let nowValue = 0;
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir(), now: () => nowValue });
    cleanups.push(() => store.cleanup());
    const { id } = store.save(PNG_BYTES);
    // 해석은 발사가 임박했다는 뜻이다 — 그 직후의 게으른 청소가 방금 해석된 파일을 거두면
    // CLI가 사라진 경로를 읽는다.
    nowValue = 29 * 60 * 1000;
    const [filePath] = store.resolve([id]);
    nowValue = 31 * 60 * 1000;
    store.save(PNG_BYTES);
    expect(existsSync(filePath as string)).toBe(true);
  });

  it("discards an unsent attachment and sweeps expired ones", () => {
    let nowValue = 0;
    const store = createLaunchAttachmentStore({ dataDir: makeStoreDataDir(), now: () => nowValue });
    cleanups.push(() => store.cleanup());
    const first = store.save(PNG_BYTES);
    const [firstPath] = store.resolve([first.id]);
    store.unreserve([first.id]);
    store.discard(first.id);
    expect(existsSync(firstPath as string)).toBe(false);
    // 발사되지 않은 업로드는 TTL이 거둔다 — 저장·해석 경로에서 게으르게 청소한다.
    // (경로 확인용 해석은 예약을 되돌려 sweep 대상으로 되돌아가게 한다.)
    const stale = store.save(PNG_BYTES);
    const [stalePath] = store.resolve([stale.id]);
    store.unreserve([stale.id]);
    nowValue = 31 * 60 * 1000;
    store.save(PNG_BYTES);
    expect(existsSync(stalePath as string)).toBe(false);
    expect(() => store.resolve([stale.id])).toThrowError(expect.objectContaining({ code: "attachment_not_found" }));
  });
});

describe("agent attachment routes", () => {
  it("uploads image bytes and returns only an opaque id", async () => {
    const harness = await createHarness();
    await harness.postAttachment(PNG_BYTES);

    const response = harness.responses.at(-1);
    expect(response?.status).toBe(200);
    // 응답에 저장 경로가 실리면 안 된다(브라우저 DTO 불변식) — id 한 필드가 전부다.
    expect(Object.keys(response?.body as Record<string, unknown>)).toEqual(["id"]);
  });

  it("rejects bytes that are not a supported image", async () => {
    const harness = await createHarness();
    await harness.postAttachment(Buffer.from("#!/bin/sh\necho pwned"));

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "attachment_unsupported" } });
  });

  it("rejects a launch carrying an unknown attachment id before creating a session", async () => {
    const harness = await createHarness();
    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", prompt: "fix it", attachmentIds: ["missing"] });

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "attachment_not_found" } });
    expect(harness.operations).toHaveLength(0);
  });

  it("composes the path instruction into the spawn prompt and binds the attachment", async () => {
    const harness = await createHarness();
    await harness.postAttachment(PNG_BYTES);
    const id = (harness.responses.at(-1)?.body as { id: string }).id;

    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", prompt: "fix it", attachmentIds: [id] });

    expect(harness.responses.at(-1)?.status).toBe(200);
    // 경로 합성은 서버의 일이다 — spawn 프롬프트에는 사용자 텍스트 뒤에 절대 경로 지시가 실린다.
    expect(harness.attach).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(
        new RegExp(`^fix it\\n\\n${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}.*fleet-attachments-.*image\\.png$`),
      ) as unknown as string,
    }));

    // 발사된 첨부는 세션에 묶인다 — 두 번째 실행이 같은 id를 실으면 스폰 전에 거절된다.
    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", prompt: "again", attachmentIds: [id] });
    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "attachment_not_found" } });
  });

  it("keeps attachments unsent when the spawn itself fails", async () => {
    const harness = await createHarness({ attachError: new Error("spawn failed") });
    await harness.postAttachment(PNG_BYTES);
    const id = (harness.responses.at(-1)?.body as { id: string }).id;

    // 실패한 스폰은 첨부를 묶지 않는다 — 재시도가 같은 id를 다시 실을 수 있다.
    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", prompt: "fix it", attachmentIds: [id] });
    expect(harness.responses.at(-1)).toEqual({ status: 503, body: { error: "terminal_unavailable" } });

    harness.clearAttachError();
    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", prompt: "fix it", attachmentIds: [id] });
    expect(harness.responses.at(-1)?.status).toBe(200);
  });

  it("delivers a mention message with the attachment path composed after the text", async () => {
    const harness = await createHarness();
    await harness.postSessions({ theaterId: "theater-1", cliId: "claude" });
    const sessionId = harness.operations[0]?.id as string;
    harness.setLive(sessionId);
    await harness.postAttachment(PNG_BYTES);
    const id = (harness.responses.at(-1)?.body as { id: string }).id;

    await harness.postMessage(sessionId, { text: "look at this", attachmentIds: [id] });

    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { delivered: true } });
    // 경로 지시는 서버가 본문 뒤에 합성해 PTY로 타이핑된다(런치 argv 합성과 같은 문법).
    const delivered = harness.writes.join("");
    expect(delivered).toContain("look at this");
    expect(delivered).toMatch(new RegExp(`${LAUNCH_ATTACHMENT_INSTRUCTION_PREFIX}.*fleet-attachments-.*image\.png`));

    // 전달된 첨부는 그 세션에 묶인다 — 두 번째 전달·발사가 같은 id를 실으면 거절된다.
    await harness.postMessage(sessionId, { text: "again", attachmentIds: [id] });
    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "attachment_not_found" } });
  });

  it("keeps attachments unsent when mention delivery is rejected", async () => {
    const harness = await createHarness();
    await harness.postSessions({ theaterId: "theater-1", cliId: "claude" });
    const sessionId = harness.operations[0]?.id as string;
    await harness.postAttachment(PNG_BYTES);
    const id = (harness.responses.at(-1)?.body as { id: string }).id;

    // dormant + providerSession 없음 → resume_unavailable. 예약이 되돌아와 발사가 같은 id를 싣는다.
    await harness.postMessage(sessionId, { text: "hello", attachmentIds: [id] });
    expect(harness.responses.at(-1)).toEqual({ status: 409, body: { error: "resume_unavailable" } });

    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", prompt: "use it", attachmentIds: [id] });
    expect(harness.responses.at(-1)?.status).toBe(200);
  });

  it("discards an uploaded attachment on request", async () => {
    const harness = await createHarness();
    await harness.postAttachment(PNG_BYTES);
    const id = (harness.responses.at(-1)?.body as { id: string }).id;

    await harness.deleteAttachment(id);
    expect(harness.responses.at(-1)).toEqual({ status: 200, body: { ok: true } });

    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", prompt: "fix it", attachmentIds: [id] });
    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "attachment_not_found" } });
  });

  it("stores launch geometry on the created Operation", async () => {
    const harness = await createHarness();
    const geometry = { x: 240, y: 160, width: 560, height: 360, zIndex: 4 };

    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", geometry });

    expect(harness.responses.at(-1)?.status).toBe(200);
    expect(harness.operations[0]?.geometry).toEqual(geometry);
  });

  it("rejects a launch whose geometry is not a complete rect", async () => {
    const harness = await createHarness();

    await harness.postSessions({ theaterId: "theater-1", cliId: "claude", geometry: { x: 10, y: 20 } });

    expect(harness.responses.at(-1)).toEqual({ status: 400, body: { error: "invalid_geometry" } });
    expect(harness.operations).toHaveLength(0);
  });
});

async function createHarness(options: { readonly attachError?: Error } = {}) {
  const operations: OperationNode[] = [];
  const responses: Array<{ readonly status: number; readonly body: unknown }> = [];
  const writes: string[] = [];
  const liveSessions = new Set<string>();
  const lifecycleCleanups: Array<() => void | Promise<void>> = [];
  let route: RouteHandler | undefined;
  let attachError = options.attachError;
  const tickets = createPluginTerminalTicketRegistry();
  const attach = vi.fn<TerminalRuntime["attach"]>(async () => {
    if (attachError) throw attachError;
  });
  const terminalRuntime: TerminalRuntime = {
    handleUpgrade: () => false,
    renegotiateSockets: () => {},
    issueTicket: (context) => tickets.issue(context),
    invalidateTicketsForSession: (sessionId) => tickets.invalidateForSession(sessionId),
    canAttach: () => true,
    attach,
    write: (_operationId, data) => {
      writes.push(data);
      return true;
    },
    terminate: () => true,
    getMessagePolicy: () => ({}),
    getRenameCommand: () => undefined,
    getSessionLastActivityAt: (operationId) => (liveSessions.has(operationId) ? 5 : null),
    resolveSessionIdentity: async () => null,
    onExit: () => () => {},
    onTitle: () => () => {},
    registerLaunchResolver: () => () => {},
    bindChatAttach: () => () => {},
    stop: async () => {},
  };
  const fleetDataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-terminal-attachments-"));
  cleanups.push(() => rmSync(fleetDataDir, { recursive: true, force: true }));
  const ctx = {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: "/plugins/terminal",
    wsBasePath: "/plugins/terminal/ws",
    registerRouter: (_path: string, handler: RouteHandler) => { route = handler; },
    registerWsHandler: () => {},
    host: {
      operations: {
        list: () => operations,
        get: (id: string) => operations.find((operation) => operation.id === id) ?? null,
        create: (input: OperationCreateInput) => {
          const createdAt = input.createdAt ?? Date.now();
          const operation: OperationNode = {
            id: input.id ?? `operation-${operations.length + 1}`,
            theaterId: input.theaterId,
            type: input.type,
            pluginId: input.pluginId,
            title: input.title,
            payload: { ...(input.payload ?? {}) },
            geometry: input.geometry ?? null,
            ts: { createdAt, updatedAt: createdAt },
          };
          operations.push(operation);
          return operation;
        },
        patch: (id: string, input: OperationPatchInput) => {
          const index = operations.findIndex((operation) => operation.id === id);
          const current = operations[index];
          if (!current) return null;
          const patched = { ...current, ...(input.title === undefined ? {} : { title: input.title }), ...(input.payload === undefined ? {} : { payload: { ...input.payload } }), ts: { ...current.ts, updatedAt: Date.now() } };
          operations[index] = patched;
          return patched;
        },
        delete: (id: string) => {
          const index = operations.findIndex((candidate) => candidate.id === id);
          if (index < 0) return false;
          operations.splice(index, 1);
          return true;
        },
        registerOperationType: () => () => {},
        registerPayloadSanitizer: () => () => {},
        registerLaunchCatalog: () => () => {},
      },
      events: { publish: () => {}, subscribe: () => () => {}, registerSseChannel: () => () => {} },
      server: { origin: () => null },
      paths: {
        fleetDataDir,
        pluginDataDir: () => fleetDataDir,
        resolveTheaterPath: (theaterId: string) => (theaterId === "theater-1" ? fleetDataDir : null),
        canonicalizeTheaterPath: (cwd: string) => cwd,
        workspaceHash: () => "theater-1",
        ensureWorkspaceDirectory: (cwd: string) => ({ path: `/tmp/ws/${cwd.replace(/\W+/g, "-")}`, id: "ws" }),
        withDirectoryLock: <T,>(_lockDir: string, operation: () => T): T => operation(),
      },
      storage: { readJson: async () => null, writeJson: async () => {} },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, responseBody: unknown) => { responses.push({ status, body: responseBody }); },
        readJsonBody: async <T,>(req: http.IncomingMessage) => ((req as TestRequest).__body ?? null) as T,
        securityHeaders: (extra?: Readonly<Record<string, string>>) => ({ ...(extra ?? {}) }),
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => true,
        isLockAuthorized: () => true,
        resolveTerminalSocketRole: () => "control" as const,
        isWriteAdmitted: () => true,
        expectedOrigin: () => "http://127.0.0.1:1",
      },
      theaterFlags: { register: () => () => undefined },
      lifecycle: {
        registerCleanup: (cleanup: () => void | Promise<void>) => {
          lifecycleCleanups.push(cleanup);
          return () => {};
        },
      },
    },
  } satisfies FleetPluginServerContext;

  const previousTerminalCommand = process.env.FLEET_TERMINAL_CMD;
  process.env.FLEET_TERMINAL_CMD = "test-terminal";
  await registerAgentRoutes(ctx, terminalRuntime, {
    globalOptionsService: {
      load: () => ({ version: 1, agentIdleDormantMinutes: null }),
      save: (data) => data,
      update: (mutate) => mutate({ version: 1 }),
    },
  });
  cleanups.push(async () => {
    if (previousTerminalCommand === undefined) delete process.env.FLEET_TERMINAL_CMD;
    else process.env.FLEET_TERMINAL_CMD = previousTerminalCommand;
    for (const cleanup of [...lifecycleCleanups].reverse()) await cleanup();
  });

  async function dispatch(req: http.IncomingMessage, pathname: string): Promise<void> {
    if (!route) throw new Error("Agent route was not registered");
    await route({ req, res: {} as http.ServerResponse, pathname });
  }

  return {
    attach,
    operations,
    responses,
    writes,
    setLive: (sessionId: string) => { liveSessions.add(sessionId); },
    postMessage: async (sessionId: string, body: Record<string, unknown>) => {
      const req = { method: "POST", url: `/plugins/terminal/agent/sessions/${sessionId}/message`, __body: body } as TestRequest;
      await dispatch(req, `/plugins/terminal/agent/sessions/${sessionId}/message`);
    },
    clearAttachError: () => { attachError = undefined; },
    postAttachment: async (bytes: Buffer) => {
      const req = Readable.from([bytes]) as unknown as http.IncomingMessage;
      Object.assign(req, { method: "POST", url: "/plugins/terminal/agent/attachments" });
      await dispatch(req, "/plugins/terminal/agent/attachments");
    },
    deleteAttachment: async (id: string) => {
      const req = { method: "DELETE", url: `/plugins/terminal/agent/attachments/${id}` } as http.IncomingMessage;
      await dispatch(req, `/plugins/terminal/agent/attachments/${id}`);
    },
    postSessions: async (body: Record<string, unknown>) => {
      const req = { method: "POST", url: "/plugins/terminal/agent/sessions", __body: body } as TestRequest;
      await dispatch(req, "/plugins/terminal/agent/sessions");
    },
  };
}
