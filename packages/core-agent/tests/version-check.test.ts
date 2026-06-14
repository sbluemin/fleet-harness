import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLatestVersion, isVersionGreater } from "../src/index.js";

describe("version-check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("major, minor, patch 순서로 버전 증가를 판정한다", () => {
    expect(isVersionGreater("2.0.0", "1.9.9")).toBe(true);
    expect(isVersionGreater("1.2.0", "1.1.9")).toBe(true);
    expect(isVersionGreater("1.2.3", "1.2.2")).toBe(true);
    expect(isVersionGreater("1.2.3", "1.2.3")).toBe(false);
    expect(isVersionGreater("1.2.2", "1.2.3")).toBe(false);
  });

  it("prerelease 경계를 semver 규칙에 맞춰 비교한다", () => {
    expect(isVersionGreater("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isVersionGreater("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(isVersionGreater("1.0.0-beta.1", "1.0.0-alpha.9")).toBe(true);
    expect(isVersionGreater("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(false);
  });

  it("v prefix와 공백을 허용하고 파싱 실패는 false를 반환한다", () => {
    expect(isVersionGreater(" v1.2.4 ", "1.2.3")).toBe(true);
    expect(isVersionGreater("not-a-version", "1.2.3")).toBe(false);
    expect(isVersionGreater("1.2.3", "bad")).toBe(false);
  });

  it("스코프 패키지 URL과 Accept 헤더를 사용해 latest dist-tag를 읽는다", async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ "dist-tags": { latest: "1.2.3" } }), { status: 200 }));

    await expect(fetchLatestVersion("@dotobokuri/fleet-cli")).resolves.toBe("1.2.3");
    expect(fetchMock).toHaveBeenCalledWith("https://registry.npmjs.org/@dotobokuri%2ffleet-cli", expect.objectContaining({
      headers: {
        Accept: "application/vnd.npm.install-v1+json",
      },
      signal: expect.any(AbortSignal),
    }));
  });

  it("비스코프 패키지 URL과 요청 채널의 dist-tag를 읽는다", async () => {
    mockFetch(new Response(JSON.stringify({ "dist-tags": { beta: "2.0.0-beta.1", latest: "1.9.0" } }), { status: 200 }));

    await expect(fetchLatestVersion("left-pad", "beta")).resolves.toBe("2.0.0-beta.1");
  });

  it("응답 실패, 네트워크 실패, JSON 파싱 실패, 1MB 초과 응답은 undefined를 반환한다", async () => {
    mockFetch(new Response("nope", { status: 503 }));
    await expect(fetchLatestVersion("left-pad")).resolves.toBeUndefined();

    mockRejectedFetch(new Error("network"));
    await expect(fetchLatestVersion("left-pad")).resolves.toBeUndefined();

    mockFetch(new Response("{", { status: 200 }));
    await expect(fetchLatestVersion("left-pad")).resolves.toBeUndefined();

    mockFetch(new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));
    await expect(fetchLatestVersion("left-pad")).resolves.toBeUndefined();
  });
});

function mockFetch(response: Response) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}

function mockRejectedFetch(error: Error) {
  return vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
}
