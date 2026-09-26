import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliPlugin } from "../../foundation/agent-runtime/src/fleet/agent-cli/plugin/index.js";
import { reclaimLegacyTrees } from "../../foundation/agent-runtime/src/fleet/agent-cli/plugin/legacy-trees.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI plugin archive delivery", () => {
  it("serves the packed plugin only to a plain loopback fetch of its exact address", async () => {
    // zip에는 이 설치의 절대 경로(훅 실행 파일)가 실린다. 주소를 아는 자식만 받아야 하고,
    // 브라우저 요청이나 다른 이름으로 들어온 요청(DNS rebinding)은 루프백에 닿아도 받지 않는다.
    const plugin = createAgentCliPlugin({});
    try {
      const url = new URL(await plugin.url());
      expect(url.hostname).toBe("127.0.0.1");

      const served = await request(url, {});
      expect(served.status).toBe(200);
      const entries = unzipSync(served.body);
      expect(Object.keys(entries)).toEqual(expect.arrayContaining([
        ".claude-plugin/plugin.json",
        "hooks/hooks.json",
        "hooks/fleet-compact-event.mjs",
      ]));

      expect((await request(url, { origin: "http://127.0.0.1:1" })).status).toBe(404);
      expect((await request(url, { host: `fleet.example:${url.port}` })).status).toBe(404);
      expect((await request(new URL(`${url.origin}/fleet.zip`), {})).status).toBe(404);
    } finally {
      await plugin.close();
    }
  });

  it("reclaims the slot's shared tree without touching files Fleet did not render", () => {
    const slotRoot = createTempRoot("fleet-plugin-slot-reclaim-");
    const harnessRoot = path.join(slotRoot, "harness");
    mkdirSync(path.join(harnessRoot, "claude", "hooks"), { recursive: true });
    writeFileSync(path.join(harnessRoot, "claude", "hooks", "hooks.json"), "{}\n");
    mkdirSync(path.join(harnessRoot, "claude.lock"));
    mkdirSync(path.join(harnessRoot, ".fleet-plugin-stage-123-abc"));
    writeFileSync(path.join(harnessRoot, "user-note.txt"), "keep\n");

    reclaimLegacyTrees(createTempRoot("fleet-plugin-legacy-root-"), slotRoot);

    expect(existsSync(path.join(harnessRoot, "claude"))).toBe(false);
    expect(existsSync(path.join(harnessRoot, "claude.lock"))).toBe(false);
    expect(existsSync(path.join(harnessRoot, ".fleet-plugin-stage-123-abc"))).toBe(false);
    expect(existsSync(path.join(harnessRoot, "user-note.txt"))).toBe(true);
  });
});

function request(url: URL, headers: { readonly origin?: string; readonly host?: string }): Promise<{ status: number; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        ...(headers.origin ? { origin: headers.origin } : {}),
        ...(headers.host ? { host: headers.host } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}
