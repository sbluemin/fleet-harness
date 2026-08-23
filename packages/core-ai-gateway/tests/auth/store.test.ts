import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getFleetDataDir } from "@dotobokuri/core-infra";

import { createProviderAuthService, resolveProviderAuthPath } from "../../src/auth/index.js";

const tempRoots: string[] = [];
const PRIMARY_PROVIDER_ID = "Test Anthropic Provider";
const SECONDARY_PROVIDER_ID = "Backup Anthropic Provider";

describe("provider auth storage", () => {
  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("places auth.json on the Fleet data root", () => {
    // 경로는 호출 시각에 해석된다 — 모듈 로드 시각이 아니라. 격리 실행이 자기 루트를 정한
    // 뒤에 물어봐도 그 루트를 따라야 한다.
    expect(resolveProviderAuthPath()).toBe(path.join(getFleetDataDir(), "auth.json"));
  });

  it("follows an explicit data root over the ambient one", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-auth-root-"));
    tempRoots.push(tempRoot);

    expect(resolveProviderAuthPath(tempRoot)).toBe(path.join(tempRoot, "auth.json"));
  });

  it("stores and reads provider keys from the configured auth path", async () => {
    const authPath = createTempAuthPath();
    const auth = createProviderAuthService({ authPath });

    await auth.setApiKey(PRIMARY_PROVIDER_ID, "primary-token");

    expect(await auth.getApiKey(PRIMARY_PROVIDER_ID)).toBe("primary-token");
    expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))).toMatchObject({
      [PRIMARY_PROVIDER_ID]: {
        key: "primary-token",
      },
    });
  });

  it("writes auth file with 0o600 permissions", async () => {
    const authPath = createTempAuthPath();
    const auth = createProviderAuthService({ authPath });

    await auth.setApiKey(PRIMARY_PROVIDER_ID, "primary-token");

    if (process.platform !== "win32") {
      const stat = fs.statSync(authPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("preserves existing provider metadata when updating a key", async () => {
    const authPath = createTempAuthPath();
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({
      [SECONDARY_PROVIDER_ID]: {
        key: "old-token",
        baseUrl: "https://example.invalid",
      },
    }));

    const auth = createProviderAuthService({ authPath });
    await auth.setApiKey(SECONDARY_PROVIDER_ID, "new-token");

    expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))).toMatchObject({
      [SECONDARY_PROVIDER_ID]: {
        key: "new-token",
        baseUrl: "https://example.invalid",
      },
    });
  });

  it("returns undefined when a provider key is missing", async () => {
    const authPath = createTempAuthPath();
    const auth = createProviderAuthService({ authPath });

    await expect(auth.getApiKey("missing-provider")).resolves.toBeUndefined();
  });

  it("lists configured providers without key material", async () => {
    const authPath = createTempAuthPath();
    const auth = createProviderAuthService({ authPath });

    await auth.setApiKey(SECONDARY_PROVIDER_ID, "secondary-token");
    await auth.setApiKey(PRIMARY_PROVIDER_ID, "primary-token");

    await expect(auth.listProviderIds()).resolves.toEqual([
      SECONDARY_PROVIDER_ID,
      PRIMARY_PROVIDER_ID,
    ]);
  });

  it("deletes provider keys and reports whether an entry existed", async () => {
    const authPath = createTempAuthPath();
    const auth = createProviderAuthService({ authPath });

    await auth.setApiKey(PRIMARY_PROVIDER_ID, "primary-token");

    await expect(auth.deleteApiKey(PRIMARY_PROVIDER_ID)).resolves.toBe(true);
    await expect(auth.getApiKey(PRIMARY_PROVIDER_ID)).resolves.toBeUndefined();
    await expect(auth.deleteApiKey(PRIMARY_PROVIDER_ID)).resolves.toBe(false);
  });

  it("does not create the auth file when there is nothing to delete", async () => {
    const authPath = createTempAuthPath();
    const auth = createProviderAuthService({ authPath });

    await expect(auth.deleteApiKey(PRIMARY_PROVIDER_ID)).resolves.toBe(false);

    // 지울 것이 없다는 판정이 빈 문서를 남기면, 로그인한 적 없는 사용자에게 자격증명 파일이
    // 생긴다. 판정 자체는 락 안에서 일어나야 하므로 이 계약은 저장소가 지켜야 한다.
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it("keeps entries it does not recognize when another provider is written", async () => {
    const authPath = createTempAuthPath();
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({
      [SECONDARY_PROVIDER_ID]: { refresh: "refresh-token", exp: 42 },
    }));

    const auth = createProviderAuthService({ authPath });
    await auth.setApiKey(PRIMARY_PROVIDER_ID, "primary-token");

    // 한 공급자에 로그인하는 것이 다른 공급자의 저장 항목을 지워서는 안 된다 — 쓰기는
    // 읽어 온 문서를 통째로 되쓰므로, 모르는 모양을 걸러 내면 그 자리에서 사라진다.
    expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))).toEqual({
      [SECONDARY_PROVIDER_ID]: { refresh: "refresh-token", exp: 42 },
      [PRIMARY_PROVIDER_ID]: { key: "primary-token" },
    });
  });
});

function createTempAuthPath(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-auth-storage-"));
  tempRoots.push(tempRoot);
  return path.join(tempRoot, ".fleet", "auth.json");
}

