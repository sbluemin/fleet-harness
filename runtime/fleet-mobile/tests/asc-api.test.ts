import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASC_GROUPS_ENV,
  createAscClient,
  describeApiError,
  encodeToken,
  parseGroupNames,
  pickBuild,
  tokenClaims,
  WHATS_NEW_LOCALE,
} from "../scripts/lib/asc-api.mjs";

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

function keyFile(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dir = mkdtempSync(path.join(tmpdir(), "asc-key-"));
  const file = path.join(dir, "AuthKey_TESTKEY123.p8");
  writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  return file;
}

type FetchCall = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const impl = async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 500, body: { errors: [{ title: "no stub" }] } };
    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => text,
    } as unknown as Response;
  };
  return { impl, calls };
}

const CREDENTIALS = { keyId: "TESTKEY123", issuerId: "1234-issuer" };

describe("App Store Connect API client", () => {
  it("keeps group names distinct and drops blanks", () => {
    expect(parseGroupNames(" Internal , , Internal ,QA ")).toEqual(["Internal", "QA"]);
    expect(parseGroupNames(undefined)).toEqual([]);
  });

  it("signs a team token Apple will accept", () => {
    const claims = tokenClaims("KEY", "ISSUER", 1_000);
    expect(claims.header).toEqual({ alg: "ES256", kid: "KEY", typ: "JWT" });
    expect(claims.payload.aud).toBe("appstoreconnect-v1");
    // 20분을 넘는 만료는 Apple이 거부한다.
    expect(claims.payload.exp - claims.payload.iat).toBeLessThanOrEqual(1200);

    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const token = encodeToken({
      ...CREDENTIALS,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      nowSeconds: 1_000,
    });
    const [header, payload, signature] = token.split(".");
    expect(decodeSegment(header)).toMatchObject({ alg: "ES256", kid: "TESTKEY123" });
    expect(decodeSegment(payload)).toMatchObject({ iss: "1234-issuer", aud: "appstoreconnect-v1" });
    // JOSE는 r||s 64바이트를 요구한다. DER로 서명하면 길이가 달라지고 Apple이 401을 준다.
    expect(Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64").length).toBe(64);
  });

  it("keeps Apple's own error text in the failure message", () => {
    const message = describeApiError("POST", "/v1/betaGroups/x/relationships/builds", 409, JSON.stringify({
      errors: [{ title: "Conflict", detail: "The build is still processing" }],
    }));
    expect(message).toContain("409");
    expect(message).toContain("Conflict: The build is still processing");
  });

  it("matches a build by its CFBundleVersion", () => {
    const builds = [{ id: "a", attributes: { version: "7" } }, { id: "b", attributes: { version: "8" } }];
    expect(pickBuild(builds, "8")?.id).toBe("b");
    expect(pickBuild(builds, "9")).toBeNull();
  });

  it("says which app record is missing instead of failing later", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = createAscClient({ ...CREDENTIALS, keyPath: keyFile(), fetchImpl: impl });
    await expect(client.appId("com.dotobokuri.fleet.mobile")).rejects.toThrow(/no app record for com\.dotobokuri\.fleet\.mobile/);
  });

  it("names the groups that do exist when one is missing", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { data: [{ id: "1", attributes: { name: "Internal" } }] } }]);
    const client = createAscClient({ ...CREDENTIALS, keyPath: keyFile(), fetchImpl: impl });
    await expect(client.resolveGroupIds("app", ["Nope"])).rejects.toThrow(/no beta group named "Nope".*Internal/s);
  });

  // 재실행에서 노트가 조용히 예전 값으로 남으면 테스터는 이번 빌드가 무엇인지 알 수 없다.
  it("overwrites the What to Test note when Apple already has that locale", async () => {
    const { impl, calls } = fakeFetch([
      { status: 409, body: { errors: [{ title: "Conflict", detail: "already exists" }] } },
      { status: 200, body: { data: [{ id: "loc-1", attributes: { locale: WHATS_NEW_LOCALE } }] } },
      { status: 200, body: { data: { id: "loc-1" } } },
    ]);
    const client = createAscClient({ ...CREDENTIALS, keyPath: keyFile(), fetchImpl: impl });
    expect(await client.setWhatsNew("build-1", "second round")).toBe("updated");
    expect(calls[2].init.method).toBe("PATCH");
    expect(calls[2].url).toContain("/v1/betaBuildLocalizations/loc-1");
    expect(JSON.parse(calls[2].init.body!).data.attributes.whatsNew).toBe("second round");
  });

  // 그룹이 "자동 배포"면 Apple이 먼저 붙여 두고 우리 POST를 거절한다. 그건 실패가 아니다.
  it("treats a build Apple already distributed as assigned", async () => {
    const { impl } = fakeFetch([
      { status: 409, body: { errors: [{ title: "Conflict", detail: "already related" }] } },
      { status: 200, body: { data: [{ id: "build-1" }] } },
    ]);
    const client = createAscClient({ ...CREDENTIALS, keyPath: keyFile(), fetchImpl: impl });
    expect(await client.assignToGroup("group-9", "build-1")).toBe("already assigned");
  });

  it("still fails when the group rejects a build it does not carry", async () => {
    const { impl } = fakeFetch([
      { status: 409, body: { errors: [{ title: "Conflict", detail: "still processing" }] } },
      { status: 200, body: { data: [{ id: "another-build" }] } },
    ]);
    const client = createAscClient({ ...CREDENTIALS, keyPath: keyFile(), fetchImpl: impl });
    await expect(client.assignToGroup("group-9", "build-1")).rejects.toThrow(/still processing/);
  });

  it("assigns a build to a group with the relationship Apple expects", async () => {
    const { impl, calls } = fakeFetch([{ status: 204 }]);
    const client = createAscClient({ ...CREDENTIALS, keyPath: keyFile(), fetchImpl: impl });
    expect(await client.assignToGroup("group-9", "build-1")).toBe("assigned");
    expect(calls[0].url).toContain("/v1/betaGroups/group-9/relationships/builds");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body!)).toEqual({ data: [{ type: "builds", id: "build-1" }] });
    expect(calls[0].init.headers.authorization).toMatch(/^Bearer \S+\.\S+\.\S+$/);
  });

  it("keeps the group env name the workflow and the docs use", () => {
    expect(ASC_GROUPS_ENV).toBe("FLEET_ASC_BETA_GROUPS");
  });
});
