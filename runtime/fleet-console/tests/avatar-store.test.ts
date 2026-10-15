import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAvatarRouter, createAvatarStore } from "../features/workspace/host/avatars.js";

/**
 * 몽글 아바타 책의 저장 무결성 — 공개 라우트 하나에서 본다.
 * 처음 배정(claim)은 비어 있는 키만 받아 이미 고른 모습을 덮지 않고, 편집(set)은 처음 뽑힌 베이스(origin)를 지키며,
 * 손상된 파일·항목과 잘못된 쓰기·권한 없는 쓰기는 책을 바꾸지 않는다.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness(options: { readonly authorized?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-avatars-"));
  dirs.push(dir);
  const store = createAvatarStore(dir);
  let body: unknown = null;
  const writes: { status: number; body: unknown }[] = [];
  const router = createAvatarRouter({
    store,
    isAuthorized: () => options.authorized !== false,
    readJsonBody: async <T,>() => body as T,
    writeJson: (_res, status, payload) => { writes.push({ status, body: payload }); },
  });
  const call = async (method: "GET" | "PUT", next?: unknown) => {
    body = next ?? null;
    const req = { method, headers: { "content-type": "application/json" } } as unknown as http.IncomingMessage;
    await router({ req, res: {} as http.ServerResponse, pathname: "/api/v1/avatars" });
    return writes.at(-1)!;
  };
  return { dir, store, call };
}

describe("avatar store", () => {
  it("claims only empty keys and keeps the first draw when an avatar is edited", async () => {
    const { call } = harness();
    await call("PUT", { mode: "claim", entries: [{ key: "theater:t1", base: 3 }, { key: "operation:o1", base: 7 }] });
    // 늦게 닿은 다른 창의 배정은 이미 있는 키를 덮지 못한다.
    const late = await call("PUT", { mode: "claim", entries: [{ key: "operation:o1", base: 12 }, { key: "operation:o2", base: 12 }] });
    expect(late.body).toEqual({ avatars: {
      "theater:t1": { base: 3, tone: null, origin: 3 },
      "operation:o1": { base: 7, tone: null, origin: 7 },
      "operation:o2": { base: 12, tone: null, origin: 12 },
    } });
    const edited = await call("PUT", { mode: "set", key: "operation:o1", base: 9, tone: "rose" });
    expect((edited.body as { avatars: Record<string, unknown> }).avatars["operation:o1"]).toEqual({ base: 9, tone: "rose", origin: 7 });
  });

  it("refuses malformed and unauthorized writes and reads a damaged book as empty entries", async () => {
    const { dir, call } = harness();
    expect((await call("PUT", { mode: "set", key: "operation:o1", base: 16, tone: null })).status).toBe(400);
    expect((await call("PUT", { mode: "set", key: "../escape", base: 1, tone: null })).status).toBe(400);
    expect((await call("PUT", { mode: "claim", entries: [] })).status).toBe(400);
    fs.writeFileSync(path.join(dir, "avatars.json"), JSON.stringify({ version: 1, avatars: { "operation:ok": { base: 2, tone: "sepia", origin: 99 }, "bogus key": { base: 1 }, "operation:bad": { base: 0 } } }));
    expect((await call("GET")).body).toEqual({ avatars: { "operation:ok": { base: 2, tone: null, origin: 2 } } });

    const readonly = harness({ authorized: false });
    expect((await readonly.call("PUT", { mode: "claim", entries: [{ key: "operation:o1", base: 1 }] })).status).toBe(401);
    expect((await readonly.call("GET")).body).toEqual({ avatars: {} });
  });
});
