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

describe("readLaunchAttachmentBody", () => {
  it("stops reading past the byte cap instead of buffering the whole stream", async () => {
    const req = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]) as unknown as http.IncomingMessage;
    await expect(readLaunchAttachmentBody(req, 10)).rejects.toMatchObject({ code: "attachment_too_large" });
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
});

describe("agent attachment routes", () => {

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
