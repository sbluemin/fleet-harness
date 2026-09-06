import { describe, expect, it } from "vitest";

import { encodeAccessLink, parseAccessLink, type ValidatedAccessLink } from "../core/host/access-link.js";
import { createRemoteHostStore, type RemoteHostStoreDeps } from "../core/host/remote-hosts.js";

const FINGERPRINT_A = "8D3FBB2A855053305C32280A2ABB566FFF9C5B14C353AE0527092ED476CBB70F";
const FINGERPRINT_B = "11223344556677889900AABBCCDDEEFF11223344556677889900AABBCCDDEEFF";
const TOKEN_A = "sEPaty9_Yzq-N46FjCUfme4_DrCZeYlTitGcbWd8kLA";
const TOKEN_B = "Xy1_pQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQr";

function link(overrides: { endpoint?: string; token?: string; fingerprint?: string; label?: string } = {}): ValidatedAccessLink {
  return parseAccessLink(encodeAccessLink({
    endpoint: overrides.endpoint ?? "https://100.84.12.7:6768",
    token: overrides.token ?? TOKEN_A,
    fingerprint: overrides.fingerprint ?? FINGERPRINT_A,
    label: overrides.label ?? "devbox",
  }));
}

/** 디스크 대신 맵에 쓴다 — 저장된 바이트를 그대로 들여다보기 위해서다. */
function createHarness(start = 10_000) {
  const files = new Map<string, string>();
  let current = start;
  let counter = 0;
  const deps: RemoteHostStoreDeps = {
    ensureDirectory: () => undefined,
    readFile: (file: string) => {
      const found = files.get(file);
      if (found === undefined) throw new Error("ENOENT");
      return found;
    },
    fileSystem: {
      writeFileSync: ((file: string, content: string) => { files.set(file, content); }) as never,
      renameSync: ((from: string, to: string) => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      }) as never,
    },
    now: () => current,
    randomId: () => `host-${++counter}`,
  };
  return {
    deps,
    files,
    advance: (ms: number) => { current += ms; },
    stored: () => files.get("/console/remote/known-hosts.json") ?? "",
    open: () => createRemoteHostStore("/console", deps),
  };
}

describe("remote host store", () => {
  it("remembers where to go and what to trust, and never the credential", () => {
    const harness = createHarness();
    const store = harness.open();

    const host = store.remember(link());

    expect(host).toMatchObject({ label: "devbox", origin: "https://100.84.12.7:6768", hostname: "100.84.12.7", port: 6768, fingerprint: FINGERPRINT_A, lastOpenedAt: null });
    expect(harness.stored()).not.toContain(TOKEN_A);
    expect(harness.stored()).toContain(FINGERPRINT_A);
  });

  it("hands the pending grant over exactly once", () => {
    const harness = createHarness();
    const store = harness.open();
    store.remember(link());

    const first = store.takeHandoff("https://100.84.12.7:6768");
    const second = store.takeHandoff("https://100.84.12.7:6768");

    expect(first?.token).toBe(TOKEN_A);
    expect(second?.token).toBeNull();
    // 두 번째도 호스트 자체는 여전히 열 수 있다 — 그때는 세션 쿠키가 통행증이다.
    expect(second?.host.origin).toBe("https://100.84.12.7:6768");
  });

  it("drops entries that lost their shape instead of trusting them", () => {
    const harness = createHarness();
    harness.files.set("/console/remote/known-hosts.json", JSON.stringify({
      version: 1,
      hosts: [
        { id: "keep", label: "ok", origin: "https://a.test:4310", hostname: "a.test", port: 4310, fingerprint: FINGERPRINT_A, addedAt: 1, lastOpenedAt: null },
        { id: "plaintext", label: "no", origin: "http://a.test:4310", hostname: "a.test", port: 4310, fingerprint: FINGERPRINT_A, addedAt: 1, lastOpenedAt: null },
        { id: "no-pin", label: "no", origin: "https://b.test:4310", hostname: "b.test", port: 4310, fingerprint: "short", addedAt: 1, lastOpenedAt: null },
      ],
    }));

    expect(harness.open().list().map((entry) => entry.id)).toEqual(["keep"]);
  });
});
