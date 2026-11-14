import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BROWSER_PASSWORD_MAX_ENTRIES, BROWSER_PASSWORD_MAX_NEVER_ORIGINS } from "@fleet-console/protocol/desktop/browser-passwords";
import { BrowserPasswordVaultError, createBrowserPasswordVault, type BrowserPasswordClipboard, type BrowserPasswordSafeStorage, type BrowserPasswordSystemPreferences } from "../src/browser-password-vault.js";

/** AES-256-GCM 기반 가짜 safeStorage — 포트越し 라운드트립을 실제 암호로 검증한다. */
function createFakeSafeStorage() {
  const key = crypto.randomBytes(32);
  const control = { available: true };
  const safeStorage: BrowserPasswordSafeStorage = {
    isEncryptionAvailable: () => control.available,
    encryptString: (plaintext: string) => {
      if (!control.available) throw new Error("encryption unavailable");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString: (encrypted: Buffer) => {
      const iv = encrypted.subarray(0, 12);
      const tag = encrypted.subarray(12, 28);
      const data = encrypted.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    },
  };
  return { safeStorage, control };
}

function createFakeSystemPreferences() {
  const control = { supported: true, nextFailure: null as Error | null, calls: [] as string[] };
  const systemPreferences: BrowserPasswordSystemPreferences = {
    canPromptTouchID: () => control.supported,
    promptTouchID: async (reason: string) => {
      control.calls.push(reason);
      if (control.nextFailure) throw control.nextFailure;
    },
  };
  return { systemPreferences, control };
}

function createFakeClipboard() {
  const texts: string[] = [];
  const clipboard: BrowserPasswordClipboard = {
    writeText: (text: string) => { texts.push(text); },
  };
  return { clipboard, texts };
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserPasswordVaultError);
    return (error as BrowserPasswordVaultError).code;
  }
  throw new Error("거부를 기대했지만 성공했다");
}

describe("browser password vault", () => {
  let dir: string;
  let fakes: ReturnType<typeof createFakeSafeStorage>;
  let auth: ReturnType<typeof createFakeSystemPreferences>;
  let clip: ReturnType<typeof createFakeClipboard>;

  const vaultFile = (): string => path.join(dir, "browser-password-vault.json");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-bpw-"));
    fakes = createFakeSafeStorage();
    auth = createFakeSystemPreferences();
    clip = createFakeClipboard();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const createVault = (overrides: { platform?: NodeJS.Platform } = {}) => createBrowserPasswordVault({
    root: dir,
    safeStorage: fakes.safeStorage,
    systemPreferences: auth.systemPreferences,
    clipboard: clip.clipboard,
    platform: overrides.platform ?? "darwin",
  });

  it("reports an empty available state and ignores the temporary-session profile marker", async () => {
    let availabilityCalls = 0;
    const vault = createBrowserPasswordVault({
      root: dir,
      safeStorage: {
        ...fakes.safeStorage,
        isEncryptionAvailable: () => { availabilityCalls += 1; return fakes.safeStorage.isEncryptionAvailable(); },
      },
      systemPreferences: auth.systemPreferences,
      clipboard: clip.clipboard,
      platform: "darwin",
    });
    expect(await vault.command({ action: "state", browserProfile: null })).toEqual({
      available: true,
      reason: null,
      offerToSave: true,
      osAuthSupported: true,
      entries: [],
      neverSaveOrigins: [],
    });
    expect(vault.forOrigin("https://empty.example/")).toEqual({ offerToSave: true, neverSaved: false, credentials: [] });
    expect(availabilityCalls).toBe(0);
  });

  it("saves and reveals through real encryption without ever writing plaintext to disk", async () => {
    const vault = createVault();
    const password = "s3cr3t-비밀번호-1234";
    const saved = await vault.command({ action: "save", origin: "https://example.com/login?next=/a", username: "ada", password }) as { entry: Record<string, unknown>; created: boolean };
    expect(saved.created).toBe(true);
    expect(saved.entry).not.toHaveProperty("password");
    expect(saved.entry).not.toHaveProperty("ciphertext");
    expect(saved.entry).toMatchObject({ origin: "https://example.com", username: "ada" });

    const raw = fs.readFileSync(vaultFile(), "utf8");
    expect(raw).not.toContain(password);
    expect(raw).toContain("ciphertext");
    expect(fs.statSync(vaultFile()).mode & 0o777).toBe(0o600);

    const state = await vault.command({ action: "state" }) as { entries: unknown[] };
    expect(state.entries).toHaveLength(1);
    expect(JSON.stringify(state.entries)).not.toContain(password);

    const revealed = await vault.command({ action: "reveal", id: saved.entry.id }) as { password: string };
    expect(revealed).toEqual({ password });
    expect(auth.control.calls).toHaveLength(1);
  });

  it("upserts the same origin and username instead of duplicating", async () => {
    const vault = createVault();
    const first = await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "first" }) as { entry: { id: string } };
    const second = await vault.command({ action: "save", origin: "https://example.com/other", username: "ada", password: "second" }) as { entry: { id: string }; created: boolean };
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    const revealed = await vault.command({ action: "reveal", id: first.entry.id }) as { password: string };
    expect(revealed.password).toBe("second");
    const state = await vault.command({ action: "state" }) as { entries: unknown[] };
    expect(state.entries).toHaveLength(1);
  });

  it("updates metadata without a password and rotates the ciphertext with one", async () => {
    const vault = createVault();
    const saved = await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "old" }) as { entry: { id: string } };
    const kept = await vault.command({ action: "update", id: saved.entry.id, username: "grace" }) as { entry: { origin: string; username: string } };
    expect(kept.entry.username).toBe("grace");
    expect(kept.entry.origin).toBe("https://example.com");
    expect(((await vault.command({ action: "reveal", id: saved.entry.id }) as { password: string }).password)).toBe("old");

    await vault.command({ action: "update", id: saved.entry.id, origin: "https://other.example/", username: "grace", password: "new" });
    expect(((await vault.command({ action: "reveal", id: saved.entry.id }) as { password: string }).password)).toBe("new");
  });

  it("rejects unknown ids and colliding renames, and deletes idempotently", async () => {
    const vault = createVault();
    expect(await errorCodeOf(vault.command({ action: "reveal", id: "missing" }))).toBe("password_not_found");
    expect(await errorCodeOf(vault.command({ action: "copy", id: "missing" }))).toBe("password_not_found");
    expect(await errorCodeOf(vault.command({ action: "update", id: "missing", username: "x" }))).toBe("password_not_found");
    expect(await vault.command({ action: "delete", id: "missing" })).toEqual({ deleted: false });

    const first = await vault.command({ action: "save", origin: "https://a.example/", username: "u", password: "p1" }) as { entry: { id: string } };
    await vault.command({ action: "save", origin: "https://b.example/", username: "u", password: "p2" });
    expect(await errorCodeOf(vault.command({ action: "update", id: first.entry.id, origin: "https://b.example/", username: "u" }))).toBe("invalid_password_entry");

    expect(await vault.command({ action: "delete", id: first.entry.id })).toEqual({ deleted: true });
    expect(await vault.command({ action: "delete", id: first.entry.id })).toEqual({ deleted: false });
  });

  it("copies through the clipboard only after OS auth and never returns the password", async () => {
    const vault = createVault();
    const saved = await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "copy-me" }) as { entry: { id: string } };
    const result = await vault.command({ action: "copy", id: saved.entry.id });
    expect(result).toEqual({ copied: true });
    expect(clip.texts).toEqual(["copy-me"]);
    expect(auth.control.calls).toHaveLength(1);
  });

  it("blocks reveal and copy without OS auth and leaves the clipboard untouched", async () => {
    const vault = createVault();
    const saved = await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "locked" }) as { entry: { id: string } };

    auth.control.supported = false;
    expect(await errorCodeOf(vault.command({ action: "reveal", id: saved.entry.id }))).toBe("os_auth_unavailable");
    expect(await errorCodeOf(vault.command({ action: "copy", id: saved.entry.id }))).toBe("os_auth_unavailable");
    expect(auth.control.calls).toHaveLength(0);
    expect(clip.texts).toHaveLength(0);

    const unsupported = await vault.command({ action: "state" }) as { osAuthSupported: boolean };
    expect(unsupported.osAuthSupported).toBe(false);

    auth.control.supported = true;
    auth.control.nextFailure = new Error("User cancelled the touch id prompt");
    expect(await errorCodeOf(vault.command({ action: "reveal", id: saved.entry.id }))).toBe("os_auth_cancelled");
    auth.control.nextFailure = new Error("LAErrorAuthenticationFailed");
    expect(await errorCodeOf(vault.command({ action: "copy", id: saved.entry.id }))).toBe("os_auth_failed");
    expect(clip.texts).toHaveLength(0);
  });

  it("falls back to OS password prompt on macOS when Touch ID is unavailable", async () => {
    const osPrompts: string[] = [];
    let osFailure: Error | null = null;
    auth.control.supported = false;
    const vault = createBrowserPasswordVault({
      root: dir,
      safeStorage: fakes.safeStorage,
      systemPreferences: auth.systemPreferences,
      clipboard: clip.clipboard,
      platform: "darwin",
      osAuth: {
        canPrompt: () => true,
        prompt: async (reason) => {
          osPrompts.push(reason);
          if (osFailure) throw osFailure;
        },
      },
    });
    const saved = await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "mac-mini-pw" }) as { entry: { id: string } };
    expect(await vault.command({ action: "state" })).toMatchObject({ osAuthSupported: true });
    expect(await vault.command({ action: "reveal", id: saved.entry.id })).toEqual({ password: "mac-mini-pw" });
    expect(osPrompts).toHaveLength(1);

    osFailure = new Error("User canceled. (-128)");
    expect(await errorCodeOf(vault.command({ action: "copy", id: saved.entry.id }))).toBe("os_auth_cancelled");
    osFailure = new Error("os_auth_cancelled");
    expect(await errorCodeOf(vault.command({ action: "reveal", id: saved.entry.id }))).toBe("os_auth_cancelled");
    osFailure = new Error("os_auth_unavailable");
    expect(await errorCodeOf(vault.command({ action: "reveal", id: saved.entry.id }))).toBe("os_auth_unavailable");
    osFailure = new Error("wrong password");
    expect(await errorCodeOf(vault.command({ action: "reveal", id: saved.entry.id }))).toBe("os_auth_failed");

    const failClosedVault = createBrowserPasswordVault({
      root: dir,
      safeStorage: fakes.safeStorage,
      systemPreferences: auth.systemPreferences,
      clipboard: clip.clipboard,
      platform: "darwin",
      osAuth: { canPrompt: () => false, prompt: async () => {} },
    });
    expect(await errorCodeOf(failClosedVault.command({ action: "reveal", id: saved.entry.id }))).toBe("os_auth_unavailable");
    expect(await errorCodeOf(failClosedVault.command({ action: "copy", id: saved.entry.id }))).toBe("os_auth_unavailable");
  });

  it("allows reveal/copy directly on Linux without a separate OS biometric dialog (Chrome parity)", async () => {
    const vault = createVault({ platform: "linux" });
    const saved = await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "pw" }) as { entry: { id: string } };
    const state = await vault.command({ action: "state" }) as { osAuthSupported: boolean };
    expect(state.osAuthSupported).toBe(false);
    expect(await vault.command({ action: "reveal", id: saved.entry.id })).toEqual({ password: "pw" });
    expect(auth.control.calls).toHaveLength(0);
  });

  it("prompts for OS auth before checking entry existence", async () => {
    const vault = createVault();
    expect(await errorCodeOf(vault.command({ action: "reveal", id: "no-such-entry" }))).toBe("password_not_found");
    expect(auth.control.calls).toHaveLength(1);
  });

  it("fails closed without encryption and never falls back to plaintext", async () => {
    const vault = createVault();
    await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "before" });
    fakes.control.available = false;

    const state = await vault.command({ action: "state" }) as { available: boolean; reason: string; entries: unknown[] };
    expect(state.available).toBe(false);
    expect(state.reason).toBe("encryption_unavailable");
    expect(state.entries).toEqual([]);

    const id = ((await createVault().command({ action: "state" })) as { entries: { id: string }[] }).entries[0]?.id ?? "unknown";
    expect(await errorCodeOf(vault.command({ action: "reveal", id }))).toBe("encryption_unavailable");
    expect(await errorCodeOf(vault.command({ action: "copy", id }))).toBe("encryption_unavailable");
    expect(await errorCodeOf(vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "after-marker-9z-not-stored" }))).toBe("encryption_unavailable");
    expect(await errorCodeOf(vault.command({ action: "update", id, username: "ada" }))).toBe("encryption_unavailable");
    expect(await errorCodeOf(vault.command({ action: "delete", id }))).toBe("encryption_unavailable");
    expect(auth.control.calls).toHaveLength(0);

    const raw = fs.existsSync(vaultFile()) ? fs.readFileSync(vaultFile(), "utf8") : "";
    expect(raw).not.toContain("after-marker-9z-not-stored");
  });

  it("treats a corrupted file as vault_corrupted without prompting for auth", async () => {
    const vault = createVault();
    await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "pw" });
    fs.writeFileSync(vaultFile(), "{ not json", "utf8");

    const state = await vault.command({ action: "state" }) as { available: boolean; reason: string };
    expect(state).toMatchObject({ available: false, reason: "vault_corrupted" });
    expect(await errorCodeOf(vault.command({ action: "reveal", id: "x" }))).toBe("vault_corrupted");
    expect(await errorCodeOf(vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "pw2" }))).toBe("vault_corrupted");
    expect(auth.control.calls).toHaveLength(0);
  });

  it("refuses to follow a symlinked vault file", async () => {
    const vault = createVault();
    const saved = await vault.command({ action: "save", origin: "https://example.com/", username: "ada", password: "real" }) as { entry: { id: string } };
    const outside = path.join(dir, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ version: 1, offerToSave: true, neverSaveOrigins: [], entries: [] }), "utf8");
    fs.unlinkSync(vaultFile());
    fs.symlinkSync(outside, vaultFile());

    const state = await vault.command({ action: "state" }) as { available: boolean; reason: string };
    expect(state).toMatchObject({ available: false, reason: "vault_corrupted" });
    expect(await errorCodeOf(vault.command({ action: "reveal", id: saved.entry.id }))).toBe("vault_corrupted");
    expect(auth.control.calls).toHaveLength(0);
  });

  it("validates origins, usernames, and passwords on every write path", async () => {
    const vault = createVault();
    for (const origin of ["javascript:alert(1)", "data:text/plain,hi", "not a url", "", "ftp://example.com/"]) {
      expect(await errorCodeOf(vault.command({ action: "save", origin, username: "u", password: "p" })), origin).toBe("invalid_password_entry");
    }
    expect(await errorCodeOf(vault.command({ action: "save", origin: "https://example.com/", username: "", password: "p" }))).toBe("invalid_password_entry");
    expect(await errorCodeOf(vault.command({ action: "save", origin: "https://example.com/", username: "u", password: "" }))).toBe("invalid_password_entry");
    expect(await errorCodeOf(vault.command({ action: "save", origin: "https://example.com/", username: "u".repeat(513), password: "p" }))).toBe("invalid_password_entry");
    expect(await errorCodeOf(vault.command({ action: "add-never-save", origin: "chrome://settings" }))).toBe("invalid_password_entry");
    expect(await errorCodeOf(vault.command({ action: "set-offer-to-save", enabled: "yes" }))).toBe("invalid_password_entry");
    expect(await errorCodeOf(vault.command({ action: "no-such-action" }))).toBe("desktop_shell_unsupported");
    expect(await vault.command({ action: "state" })).toMatchObject({ available: true, entries: [] });
  });

  it("toggles offer-to-save and persists it across instances", async () => {
    const vault = createVault();
    expect(await vault.command({ action: "set-offer-to-save", enabled: false })).toEqual({ offerToSave: false });
    const reopened = createVault();
    expect(await reopened.command({ action: "state" })).toMatchObject({ offerToSave: false });
    expect(await reopened.command({ action: "set-offer-to-save", enabled: true })).toEqual({ offerToSave: true });
  });

  it("manages the never-save list with normalized origins", async () => {
    const vault = createVault();
    expect(await vault.command({ action: "add-never-save", origin: "https://example.com/login?x=1" })).toEqual({ neverSaveOrigins: ["https://example.com"] });
    expect(await vault.command({ action: "add-never-save", origin: "https://example.com/other" })).toEqual({ neverSaveOrigins: ["https://example.com"] });
    expect(await vault.command({ action: "remove-never-save", origin: "https://missing.example/" })).toEqual({ neverSaveOrigins: ["https://example.com"] });
    expect(await vault.command({ action: "remove-never-save", origin: "https://example.com/" })).toEqual({ neverSaveOrigins: [] });
    const reopened = createVault();
    await reopened.command({ action: "add-never-save", origin: "https://persist.example/" });
    expect(await createVault().command({ action: "state" })).toMatchObject({ neverSaveOrigins: ["https://persist.example"] });
  });

  it(`enforces the ${BROWSER_PASSWORD_MAX_ENTRIES}-entry limit`, async () => {
    const vault = createVault();
    for (let i = 0; i < BROWSER_PASSWORD_MAX_ENTRIES; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await vault.command({ action: "save", origin: `https://site-${i}.example/`, username: "u", password: `p-${i}` });
    }
    expect(await errorCodeOf(vault.command({ action: "save", origin: "https://overflow.example/", username: "u", password: "p" }))).toBe("vault_limit_reached");
    const state = await vault.command({ action: "state" }) as { entries: unknown[] };
    expect(state.entries).toHaveLength(BROWSER_PASSWORD_MAX_ENTRIES);
  });

  it(`enforces the ${BROWSER_PASSWORD_MAX_NEVER_ORIGINS}-origin never-save limit`, async () => {
    const vault = createVault();
    for (let i = 0; i < BROWSER_PASSWORD_MAX_NEVER_ORIGINS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await vault.command({ action: "add-never-save", origin: `https://never-${i}.example/` });
    }
    expect(await errorCodeOf(vault.command({ action: "add-never-save", origin: "https://overflow.example/" }))).toBe("vault_limit_reached");
  });

  it("exposes decrypted origin credentials to main only and clears never-save on save", async () => {
    const vault = createVault();
    await vault.command({ action: "add-never-save", origin: "https://a.example/" });
    expect(vault.forOrigin("https://a.example/login")).toEqual({ offerToSave: true, neverSaved: true, credentials: [] });
    await vault.command({ action: "save", origin: "https://a.example/", username: "ada", password: "pw-one" });
    const first = vault.forOrigin("https://a.example/");
    expect(first.neverSaved).toBe(false);
    expect(first.credentials).toEqual([{ id: first.credentials[0]!.id, username: "ada", password: "pw-one", updatedAt: first.credentials[0]!.updatedAt, matchType: "exact", origin: "https://a.example" }]);
    await vault.command({ action: "save", origin: "https://a.example/other", username: "ada", password: "pw-two" });
    expect(vault.forOrigin("https://a.example/").credentials).toHaveLength(1);
    await vault.command({ action: "set-offer-to-save", enabled: false });
    expect(vault.forOrigin("https://a.example/").offerToSave).toBe(false);
    expect(() => vault.forOrigin("not a url")).toThrow("invalid_password_entry");
    fakes.control.available = false;
    expect(() => vault.forOrigin("https://a.example/")).toThrow("encryption_unavailable");
  });

  it("matches same registrable domains as psl while keeping exact first", async () => {
    const vault = createVault();
    await vault.command({ action: "save", origin: "https://login.example.com/", username: "ada", password: "one" });
    await vault.command({ action: "save", origin: "https://app.example.com/", username: "ada", password: "two" });
    const both = vault.forOrigin("https://login.example.com/");
    expect(both.credentials.map((entry) => [entry.origin, entry.matchType, entry.password])).toEqual([
      ["https://login.example.com", "exact", "one"],
      ["https://app.example.com", "psl", "two"],
    ]);

    await vault.command({ action: "save", origin: "https://a.b.co.kr/", username: "u", password: "kr-one" });
    await vault.command({ action: "save", origin: "https://c.b.co.kr/", username: "u", password: "kr-two" });
    const kr = vault.forOrigin("https://a.b.co.kr/");
    expect(kr.credentials.map((entry) => [entry.origin, entry.matchType])).toEqual([
      ["https://a.b.co.kr", "exact"],
      ["https://c.b.co.kr", "psl"],
    ]);
    await vault.command({ action: "save", origin: "https://nid.naver.com/", username: "n", password: "npw" });
    expect(vault.forOrigin("https://www.naver.com/").credentials.map((entry) => [entry.origin, entry.matchType])).toEqual([
      ["https://nid.naver.com", "psl"],
    ]);
  });

  it("refuses psl matches across schemes, ports, public/private suffixes, and local hosts", async () => {
    const vault = createVault();
    await vault.command({ action: "save", origin: "https://a.example/", username: "u", password: "p" });
    expect(vault.forOrigin("http://a.example/").credentials).toHaveLength(0);
    expect(vault.forOrigin("https://a.example:8443/").credentials).toHaveLength(0);

    await vault.command({ action: "save", origin: "https://a.co.kr/", username: "u", password: "p" });
    expect(vault.forOrigin("https://a.co.uk/").credentials).toHaveLength(0);

    await vault.command({ action: "save", origin: "https://victim.co.il/", username: "u", password: "p" });
    expect(vault.forOrigin("https://attacker.co.il/").credentials).toHaveLength(0);

    await vault.command({ action: "save", origin: "https://a.github.io/", username: "u", password: "p" });
    expect(vault.forOrigin("https://b.github.io/").credentials).toHaveLength(0);

    await vault.command({ action: "save", origin: "https://a.myshopify.com/", username: "u", password: "p" });
    expect(vault.forOrigin("https://b.myshopify.com/").credentials).toHaveLength(0);

    await vault.command({ action: "save", origin: "https://a.blogspot.com/", username: "u", password: "p" });
    expect(vault.forOrigin("https://b.blogspot.com/").credentials).toHaveLength(0);

    await vault.command({ action: "save", origin: "http://127.0.0.1/", username: "u", password: "p" });
    expect(vault.forOrigin("http://127.0.0.1/").credentials.map((entry) => entry.matchType)).toEqual(["exact"]);
    await vault.command({ action: "save", origin: "http://127.0.0.2/", username: "u", password: "p2" });
    expect(vault.forOrigin("http://127.0.0.1/").credentials).toHaveLength(1);

    await vault.command({ action: "save", origin: "http://localhost:3000/", username: "u", password: "p" });
    await vault.command({ action: "save", origin: "http://localhost:4000/", username: "u", password: "p2" });
    expect(vault.forOrigin("http://localhost:3000/").credentials).toHaveLength(1);
  });
});
