import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../core/client/src/api.js";
import { createRemoteAccessLink, fetchGlobalSettingsState, fetchRemoteAccessStatus, updateGlobalSettings } from "../core/client/src/global-settings-api.js";
import { generateRemoteAutoPort, isCommittableRemotePortDraft, REMOTE_AUTO_PORT_MAX, REMOTE_AUTO_PORT_MIN } from "../core/client/src/types.js";

const originalFetch = globalThis.fetch;
const SETTINGS = { consolePortMode: "dynamic", consoleStaticPort: null, remoteAccess: { enabled: false, publicEndpointEnabled: false, listenAddress: "", advertisedHost: "", listenPort: { mode: "auto", value: 49152 }, advertisedPort: { mode: "auto", value: 49153 }, acknowledgment: null }, seenFeatureTours: [], theme: "instrument", liquidGlass: true, uiFont: { source: "builtin", id: "manrope", size: 14 }, language: "auto" } as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("global settings client transport", () => {
  it("requires the exact publicEndpointEnabled browser DTO key", async () => {
    const remoteAccess = { ...SETTINGS.remoteAccess } as Record<string, unknown>;
    delete remoteAccess.publicEndpointEnabled;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...SETTINGS, remoteAccess }))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).rejects.toBeInstanceOf(ApiError);
  });

  it("requires and preserves the server language preference", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(SETTINGS))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).resolves.toEqual(SETTINGS);
  });

  it("sends language through the existing partial PUT transport", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: { ...SETTINGS, language: "ko" } })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(updateGlobalSettings({ language: "ko" })).resolves.toEqual({ state: { ...SETTINGS, language: "ko" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ language: "ko" }),
    }));
  });

  it("requires and sends the seen Feature Tour keys", async () => {
    const seenFeatureTours = ["example.spotlight"] as const;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: { ...SETTINGS, seenFeatureTours } })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(updateGlobalSettings({ seenFeatureTours })).resolves.toEqual({ state: { ...SETTINGS, seenFeatureTours } });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({
      body: JSON.stringify({ seenFeatureTours }),
    }));
  });

  it("accepts and sends each supported theme", async () => {
    for (const theme of ["instrument", "maritime", "carbon", "whites"] as const) {
      const state = { ...SETTINGS, theme };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state })));
      globalThis.fetch = fetchMock as typeof fetch;

      await expect(updateGlobalSettings({ theme })).resolves.toEqual({ state });
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({ body: JSON.stringify({ theme }) }));
    }
  });

  it("rejects an unsupported theme response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...SETTINGS, theme: "neon" }))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects missing or invalid language values", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...SETTINGS, language: "ja" }))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).rejects.toBeInstanceOf(ApiError);
  });

  it("normalizes malformed UI font responses to the atomic default", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...SETTINGS, uiFont: { source: "system", familyName: "\u0000", size: 99 } }))) as typeof fetch;

    await expect(fetchGlobalSettingsState()).resolves.toEqual(SETTINGS);
  });

  it("sends the complete UI font object in one settings update", async () => {
    const uiFont = { source: "system" as const, familyName: "Noto Sans", size: 18 };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: { ...SETTINGS, uiFont } })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(updateGlobalSettings({ uiFont })).resolves.toEqual({ state: { ...SETTINGS, uiFont } });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({ body: JSON.stringify({ uiFont }) }));
  });

  it("strictly validates remote status arrays and the split listener state", async () => {
    const status = { listener: { listening: true, origin: "https://console.example:5443", lastError: null }, publicReachability: "unverified", rejectedJoins: { count: 0, lastAt: null }, fingerprint: "AA:BB", links: [{ id: "link-1", access: "full", issuedAt: 1, expiresAt: 2 }], devices: [{ id: "device-1", device: null, access: "monitoring", pairedAt: 1, lastSeenAt: 2, sessionHandle: null }], interfaces: [{ kind: "local", label: "LAN", address: "192.168.1.20" }] };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(status))) as typeof fetch;
    await expect(fetchRemoteAccessStatus()).resolves.toEqual(status);

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...status, links: [{ ...status.links[0], access: "admin" }] }))) as typeof fetch;
    await expect(fetchRemoteAccessStatus()).rejects.toBeInstanceOf(ApiError);

    // 거절 계수는 화면이 읽는 값이라 모양이 어긋나면 응답 전체를 버린다.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ...status, rejectedJoins: { count: -1, lastAt: null } }))) as typeof fetch;
    await expect(fetchRemoteAccessStatus()).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects permissive access-link fallbacks", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: "", link: "fleet://join?code=x", access: "admin", expiresAt: 1, fingerprint: "AA:BB" }))) as typeof fetch;
    await expect(createRemoteAccessLink("full")).rejects.toBeInstanceOf(ApiError);
  });

  it("generates Auto ports with browser crypto and rejects incomplete Custom drafts", () => {
    expect(generateRemoteAutoPort((values) => { values[0] = 0; return values; })).toBe(REMOTE_AUTO_PORT_MIN);
    expect(generateRemoteAutoPort((values) => { values[0] = REMOTE_AUTO_PORT_MAX - REMOTE_AUTO_PORT_MIN; return values; })).toBe(REMOTE_AUTO_PORT_MAX);
    expect(isCommittableRemotePortDraft("")).toBe(false);
    expect(isCommittableRemotePortDraft("0")).toBe(false);
    expect(isCommittableRemotePortDraft("65536")).toBe(false);
    expect(isCommittableRemotePortDraft("5443")).toBe(true);
  });
});
