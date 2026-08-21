import type { AiGatewayRouter } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_DEDICATED_GATEWAYS,
  PANEL_GATEWAY_HEADER,
  createDedicatedGatewayPool,
  withPanelGatewayHeader,
} from "../server/ai-gateway-pool.js";

function headers(panelId?: string): Record<string, unknown> {
  return panelId === undefined ? {} : { [PANEL_GATEWAY_HEADER]: panelId };
}

function fakeRouter(): AiGatewayRouter & { readonly dispose: ReturnType<typeof vi.fn> } {
  return {
    handle: vi.fn(),
    upstreamStats: () => [],
    dispose: vi.fn(),
  } as unknown as AiGatewayRouter & { readonly dispose: ReturnType<typeof vi.fn> };
}

function harness(options: { enabled?: () => boolean } = {}) {
  const built: Array<ReturnType<typeof fakeRouter>> = [];
  const pool = createDedicatedGatewayPool({
    enabled: options.enabled ?? (() => true),
    createRouter: () => {
      const router = fakeRouter();
      built.push(router);
      return router;
    },
  });
  return { built, pool };
}

describe("dedicated gateway pool", () => {
  it("keeps the launch on the shared gateway while the setting is off", () => {
    const { built, pool } = harness({ enabled: () => false });

    expect(pool.claim("op-1")).toBe("");
    expect(built).toHaveLength(0);
    expect(pool.size()).toBe(0);
  });

  it("issues one router per panel and answers that panel's header", () => {
    const { built, pool } = harness();

    expect(pool.claim("op-1")).toBe("op-1");
    expect(pool.claim("op-2")).toBe("op-2");
    expect(built).toHaveLength(2);
    expect(pool.resolve(headers("op-1"))).toBe(built[0]);
    expect(pool.resolve(headers("op-2"))).toBe(built[1]);
  });

  it("re-claims the same panel onto the router it already has", () => {
    const { built, pool } = harness();

    expect(pool.claim("op-1")).toBe("op-1");
    expect(pool.claim("op-1")).toBe("op-1");
    expect(built).toHaveLength(1);
  });

  it("re-claims a live panel even after the setting is turned off", () => {
    let enabled = true;
    const { built, pool } = harness({ enabled: () => enabled });
    pool.claim("op-1");
    enabled = false;

    // 이미 떠 있는 자식은 런치 때 구운 헤더를 계속 보낸다. 여기서 공용으로 되돌리면 그 패널의
    // 신원이 갈라져, 자기 라우터를 두고 공용 라우터로 흘러간다.
    expect(pool.claim("op-1")).toBe("op-1");
    expect(built).toHaveLength(1);
  });

  it("leaves a launch on the shared gateway when the setting cannot be read", () => {
    const { built, pool } = harness({
      enabled: () => { throw new Error("settings unreadable"); },
    });

    expect(pool.claim("op-1")).toBe("");
    expect(built).toHaveLength(0);
  });

  it("leaves a launch on the shared gateway once the pool is full", () => {
    const { built, pool } = harness();
    for (let index = 0; index < MAX_DEDICATED_GATEWAYS; index += 1) {
      expect(pool.claim(`op-${index}`)).not.toBe("");
    }

    expect(pool.claim("op-overflow")).toBe("");
    expect(built).toHaveLength(MAX_DEDICATED_GATEWAYS);
  });

  it("resolves nothing for a request that carries no panel header", () => {
    const { pool } = harness();
    pool.claim("op-1");

    expect(pool.resolve(headers())).toBeUndefined();
  });

  it("never mints a router for a panel id it has not issued", () => {
    const { built, pool } = harness();

    expect(pool.resolve(headers("never-claimed"))).toBeUndefined();
    expect(built).toHaveLength(0);
    expect(pool.size()).toBe(0);
  });

  it("refuses a panel id that could not survive a header line intact", () => {
    const { built, pool } = harness();

    expect(pool.claim("op:1")).toBe("");
    expect(pool.claim("op\n1")).toBe("");
    expect(pool.claim("op 1")).toBe("");
    expect(pool.claim("")).toBe("");
    expect(pool.claim(undefined)).toBe("");
    expect(built).toHaveLength(0);
  });

  it("ignores a malformed panel header instead of matching on it", () => {
    const { pool } = harness();
    pool.claim("op-1");

    expect(pool.resolve({ [PANEL_GATEWAY_HEADER]: ["op-1"] })).toBeUndefined();
    expect(pool.resolve(headers("op-1 op-2"))).toBeUndefined();
  });

  it("disposes and forgets a panel's router when the panel is released", () => {
    const { built, pool } = harness();
    pool.claim("op-1");

    pool.release("op-1");

    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(pool.resolve(headers("op-1"))).toBeUndefined();
    expect(pool.size()).toBe(0);
  });

  it("frees the pool ceiling when a panel is released", () => {
    const { pool } = harness();
    for (let index = 0; index < MAX_DEDICATED_GATEWAYS; index += 1) pool.claim(`op-${index}`);
    expect(pool.claim("op-overflow")).toBe("");

    pool.release("op-0");

    expect(pool.claim("op-overflow")).toBe("op-overflow");
  });

  it("ignores a release for a panel it never issued", () => {
    const { pool } = harness();

    expect(() => pool.release("op-unknown")).not.toThrow();
  });

  it("disposes every panel router when the host tears down", () => {
    const { built, pool } = harness();
    pool.claim("op-1");
    pool.claim("op-2");

    pool.dispose();

    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(built[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(0);
  });

  it("keeps disposing the rest when one provider throws on teardown", () => {
    const built: Array<ReturnType<typeof fakeRouter>> = [];
    const pool = createDedicatedGatewayPool({
      enabled: () => true,
      createRouter: () => {
        const router = fakeRouter();
        if (built.length === 0) router.dispose.mockImplementation(() => { throw new Error("nope"); });
        built.push(router);
        return router;
      },
    });
    pool.claim("op-1");
    pool.claim("op-2");

    expect(() => pool.dispose()).not.toThrow();
    expect(built[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(0);
  });
});

describe("panel gateway header env", () => {
  it("carries the panel id in the env Claude Code reads custom headers from", () => {
    const env = withPanelGatewayHeader({ PATH: "/bin" }, "op-1");

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`${PANEL_GATEWAY_HEADER}: op-1`);
    expect(env.PATH).toBe("/bin");
  });

  it("leaves the env untouched when the launch has no panel of its own", () => {
    const env = withPanelGatewayHeader({ PATH: "/bin" }, "");

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("keeps the headers the user already configured", () => {
    const env = withPanelGatewayHeader(
      { ANTHROPIC_CUSTOM_HEADERS: "X-Org: acme\nX-Tenant: blue" },
      "op-1",
    );

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      `X-Org: acme\nX-Tenant: blue\n${PANEL_GATEWAY_HEADER}: op-1`,
    );
  });

  it("replaces an inherited panel id rather than stacking a second one", () => {
    // Claude Code는 이름이 겹치면 마지막 쌍만 남긴다. 그래도 앞 값을 지우지 않으면 상속된
    // 다른 패널의 id가 그대로 자식 env에 남아, 순서 한 번만 뒤집혀도 남의 라우터로 간다.
    const env = withPanelGatewayHeader(
      { ANTHROPIC_CUSTOM_HEADERS: `${PANEL_GATEWAY_HEADER}: op-stale\nX-Org: acme` },
      "op-1",
    );

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Org: acme\n${PANEL_GATEWAY_HEADER}: op-1`);
  });
});
