import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { MAX_PANEL_GATEWAYS, createPanelGatewayPool } from "../server/panel-gateway-pool.js";

const READY_PREFIX = "fleet-panel-gateway-ready ";

class FakeStream extends EventEmitter {
  setEncoding(): this { return this; }
  resume(): this { return this; }
  end = vi.fn();
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStream();
  readonly kill = vi.fn();
  ready(port: number): void { this.stdout.emit("data", `${READY_PREFIX}http://127.0.0.1:${port}/ai-gateway\n`); }
}

function harness(options: {
  enabled?: () => boolean;
  ports?: readonly number[];
  autoReady?: boolean;
  startTimeoutMs?: number;
  maxGateways?: number;
} = {}) {
  const children: FakeChild[] = [];
  const ports = options.ports ?? [4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900];
  const spawnChild = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    if (options.autoReady !== false) {
      const port = ports[children.length - 1] ?? 4000 + children.length;
      queueMicrotask(() => { child.ready(port); });
    }
    return child as never;
  });
  const exits: Array<{ readonly operationId: string; readonly code: number | null }> = [];
  const pool = createPanelGatewayPool({
    enabled: options.enabled ?? (() => true),
    command: () => ({ execPath: "/usr/bin/node", args: ["/console/panel-gateway.mjs"] }),
    spawnChild: spawnChild as never,
    onExit: (operationId, code) => { exits.push({ operationId, code }); },
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
    ...(options.maxGateways === undefined ? {} : { maxGateways: options.maxGateways }),
  });
  return { children, exits, pool, spawnChild };
}

/** spawnChild가 n번째 자식을 만들 때까지 기다린다. 마이크로태스크 수를 세지 않기 위한 것이다. */
async function spawned(children: readonly FakeChild[], count: number): Promise<void> {
  for (let tick = 0; tick < 50 && children.length < count; tick += 1) await Promise.resolve();
}

describe("panel gateway pool", () => {
  it("keeps the launch on the console gateway while the setting is off", async () => {
    const { pool, spawnChild } = harness({ enabled: () => false });

    await expect(pool.claim("op-1")).resolves.toBeNull();
    expect(spawnChild).not.toHaveBeenCalled();
    expect(pool.size()).toBe(0);
  });

  it("runs one gateway process per panel and hands back its own port", async () => {
    const { pool, spawnChild } = harness({ ports: [4100, 4200] });

    await expect(pool.claim("op-1")).resolves.toBe("http://127.0.0.1:4100/ai-gateway");
    await expect(pool.claim("op-2")).resolves.toBe("http://127.0.0.1:4200/ai-gateway");
    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(pool.size()).toBe(2);
  });

  it("spawns the command the host gave it, with pipes on every stream", async () => {
    const { pool, spawnChild } = harness();
    await pool.claim("op-1");

    expect(spawnChild).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/console/panel-gateway.mjs"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("gives both surfaces of one panel the same gateway", async () => {
    const { pool, spawnChild } = harness();

    const first = await pool.claim("op-1");
    // 터미널이 먼저 묻고 Chat Mode가 나중에 묻는다. 답이 갈리면 한 Operation의 두 얼굴이
    // 서로 다른 프로세스로 흩어진다.
    await expect(pool.claim("op-1")).resolves.toBe(first);
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });

  it("starts one process when both surfaces ask at once", async () => {
    const { pool, spawnChild } = harness();

    const [a, b] = await Promise.all([pool.claim("op-1"), pool.claim("op-1")]);

    expect(a).toBe(b);
    expect(spawnChild).toHaveBeenCalledTimes(1);
  });

  it("repeats the shared answer after the setting is turned on", async () => {
    let enabled = false;
    const { pool, spawnChild } = harness({ enabled: () => enabled });
    await expect(pool.claim("op-1")).resolves.toBeNull();
    enabled = true;

    await expect(pool.claim("op-1")).resolves.toBeNull();
    expect(spawnChild).not.toHaveBeenCalled();
    // 결정은 그 Operation의 것이지 전역이 아니다.
    await expect(pool.claim("op-2")).resolves.toBe("http://127.0.0.1:4100/ai-gateway");
  });

  it("shares the console gateway when a child never reports a port", async () => {
    const { pool } = harness({ autoReady: false, startTimeoutMs: 20 });

    await expect(pool.claim("op-1")).resolves.toBeNull();
    expect(pool.size()).toBe(0);
  });

  it("shares the console gateway when a child dies before reporting", async () => {
    const { children, pool } = harness({ autoReady: false });
    const claim = pool.claim("op-1");
    await Promise.resolve();
    children[0]?.emit("exit", 1, null);

    await expect(claim).resolves.toBeNull();
    expect(pool.size()).toBe(0);
  });

  it("shares the console gateway when spawning fails outright", async () => {
    const { children, pool } = harness({ autoReady: false });
    const claim = pool.claim("op-1");
    await Promise.resolve();
    children[0]?.emit("error", new Error("ENOENT"));

    await expect(claim).resolves.toBeNull();
  });

  it("leaves a launch on the console gateway once the pool is full", async () => {
    const { pool, spawnChild } = harness({ maxGateways: 2 });
    await pool.claim("op-1");
    await pool.claim("op-2");

    await expect(pool.claim("op-overflow")).resolves.toBeNull();
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("caps at MAX_PANEL_GATEWAYS by default", async () => {
    const { pool } = harness();
    for (let index = 0; index < MAX_PANEL_GATEWAYS; index += 1) {
      await expect(pool.claim(`op-${index}`)).resolves.not.toBeNull();
    }

    await expect(pool.claim("op-overflow")).resolves.toBeNull();
  });

  it("shuts a panel's process down when the panel is released", async () => {
    const { children, pool } = harness();
    await pool.claim("op-1");

    pool.release("op-1");

    expect(children[0]?.stdin.end).toHaveBeenCalled();
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pool.size()).toBe(0);
  });

  it("lets a released panel start a fresh process", async () => {
    const { pool, spawnChild } = harness({ ports: [4100, 4200] });
    await pool.claim("op-1");
    pool.release("op-1");

    await expect(pool.claim("op-1")).resolves.toBe("http://127.0.0.1:4200/ai-gateway");
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("reports a child that dies on its own and stops handing out its URL", async () => {
    const { children, exits, pool } = harness({ ports: [4100, 4200] });
    await pool.claim("op-1");

    children[0]?.emit("exit", 9, null);

    expect(exits).toEqual([{ operationId: "op-1", code: 9 }]);
    expect(pool.size()).toBe(0);
    // 죽었다고 그 Operation을 공용으로 굳히지 않는다 — 다음 표면은 새 프로세스를 받는다.
    await expect(pool.claim("op-1")).resolves.toBe("http://127.0.0.1:4200/ai-gateway");
  });

  it("shuts every panel process down when the host tears down", async () => {
    const { children, pool } = harness();
    await pool.claim("op-1");
    await pool.claim("op-2");

    pool.dispose();

    expect(children[0]?.kill).toHaveBeenCalled();
    expect(children[1]?.kill).toHaveBeenCalled();
    expect(pool.size()).toBe(0);
  });

  it("refuses to start anything after the host tore down", async () => {
    const { pool, spawnChild } = harness();
    pool.dispose();

    await expect(pool.claim("op-1")).resolves.toBeNull();
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("keeps a launch with no operation identity on the console gateway", async () => {
    const { pool, spawnChild } = harness();

    await expect(pool.claim(undefined)).resolves.toBeNull();
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("hands back the mounted URL the child reported, never a bare origin", async () => {
    const { pool } = harness({ ports: [4100] });

    // 마운트가 빠진 URL을 자식 env에 구우면 그 패널의 모든 모델 요청이 404가 된다.
    await expect(pool.claim("op-1")).resolves.toBe("http://127.0.0.1:4100/ai-gateway");
  });

  it("shares the console gateway when the child reports something that is not a loopback URL", async () => {
    const { children, pool } = harness({ autoReady: false });
    const claim = pool.claim("op-1");
    await Promise.resolve();
    children[0]?.stdout.emit("data", `${READY_PREFIX}http://example.com/ai-gateway\n`);

    await expect(claim).resolves.toBeNull();
  });

  it("shuts down a gateway whose panel was released while it was still starting", async () => {
    const { children, pool } = harness({ autoReady: false });
    const claim = pool.claim("op-1");
    await spawned(children, 1);

    pool.release("op-1");
    children[0]?.ready(4100);

    // 이미 사라진 패널의 프로세스가 살아남으면 Console이 끝날 때까지 자리를 차지한다.
    await expect(claim).resolves.toBeNull();
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pool.size()).toBe(0);
  });

  it("frees the ceiling after a mid-start release", async () => {
    const { children, pool } = harness({ autoReady: false, maxGateways: 1 });
    const claim = pool.claim("op-1");
    await spawned(children, 1);
    pool.release("op-1");
    children[0]?.ready(4100);
    await expect(claim).resolves.toBeNull();

    const second = pool.claim("op-2");
    await spawned(children, 2);
    children[1]?.ready(4200);

    // 회수된 기동은 자리를 돌려줘야 한다 — 아니면 상한 1짜리 풀이 영영 막힌다.
    await expect(second).resolves.toBe("http://127.0.0.1:4200/ai-gateway");
  });

  it("does not record a decision when the settings read failed", async () => {
    let failing = true;
    const { pool } = harness({
      enabled: () => {
        if (failing) throw new Error("settings unreadable");
        return true;
      },
    });
    await expect(pool.claim("op-1")).resolves.toBeNull();
    failing = false;

    // 판독 실패는 결정이 아니다 — 다음 표면은 진짜 답을 받는다.
    await expect(pool.claim("op-1")).resolves.toBe("http://127.0.0.1:4100/ai-gateway");
  });
});
