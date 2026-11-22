import { describe, expect, it, vi } from "vitest";
import { codesignWithFallback, describeDevCodesignIdentity, parseCodesignIdentities, resolveDevCodesignIdentity, selectDevCodesignIdentity, signingEnv } from "../scripts/dev-codesign.mjs";

const DEVELOPMENT = "FB6B0877BBFAA3A61E2DE3E401D86AC161C6AF25";
const SECOND = "0123456789ABCDEF0123456789ABCDEF01234567";
const listing = [
  `  1) ${DEVELOPMENT} "Apple Development: Dev One (AAAA111111)"`,
  `  2) ${"A".repeat(40)} "Developer ID Application: Team (TEAM123456)"`,
  `  3) ${SECOND} "Apple Development: Dev Two (BBBB222222)"`,
  "     3 valid identities found",
].join("\n");

describe("development code signing identity", () => {
  it("reads valid identities and prefers an Apple Development one, or falls back to ad hoc", () => {
    const identities = parseCodesignIdentities(listing);
    expect(identities.map((entry) => entry.hash)).toEqual([DEVELOPMENT, "A".repeat(40), SECOND]);
    expect(selectDevCodesignIdentity(identities, undefined)).toEqual({ identity: DEVELOPMENT, label: "Apple Development: Dev One (AAAA111111)", reason: "first_of_many" });
    expect(selectDevCodesignIdentity(identities.slice(0, 2), undefined).reason).toBe("found");
    expect(selectDevCodesignIdentity([identities[1]!], undefined)).toEqual({ identity: "-", label: "ad hoc", reason: "none" });
    expect(selectDevCodesignIdentity([], undefined)).toEqual({ identity: "-", label: "ad hoc", reason: "none" });
  });

  it("honors FLEET_DEV_CODESIGN_IDENTITY by hash, name, or - and does not guess when it names nothing", async () => {
    const identities = parseCodesignIdentities(listing);
    expect(selectDevCodesignIdentity(identities, SECOND.toLowerCase()).identity).toBe(SECOND);
    expect(selectDevCodesignIdentity(identities, "Developer ID Application: Team (TEAM123456)").identity).toBe("A".repeat(40));
    expect(selectDevCodesignIdentity(identities, "missing")).toEqual({ identity: "-", label: "ad hoc", reason: "requested_identity_missing" });
    const run = vi.fn(async () => ({ stdout: listing }));
    expect(await resolveDevCodesignIdentity({ FLEET_DEV_CODESIGN_IDENTITY: "-" }, run)).toEqual({ identity: "-", label: "ad hoc", reason: "requested" });
    expect(run).not.toHaveBeenCalled();
    expect((await resolveDevCodesignIdentity({}, run)).identity).toBe(DEVELOPMENT);
    expect(run).toHaveBeenCalledWith("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { env: {} });
    expect(await resolveDevCodesignIdentity({}, async () => { throw new Error("no keychain"); })).toEqual({ identity: "-", label: "ad hoc", reason: "none" });
  });

  it("looks up and signs with the account home when HOME is overridden, as in isolated runs", () => {
    expect(signingEnv({ HOME: "/Users/me", PATH: "/bin" }, "/Users/me")).toEqual({ HOME: "/Users/me", PATH: "/bin" });
    expect(signingEnv({ HOME: "/run/home", PATH: "/bin" }, "/Users/me")).toEqual({ HOME: "/Users/me", PATH: "/bin" });
    expect(signingEnv({ PATH: "/bin" }, "/Users/me")).toEqual({ PATH: "/bin" });
  });

  it("re-signs ad hoc when signing with the chosen identity fails and tells the developer to add the app with +", async () => {
    const choice = selectDevCodesignIdentity(parseCodesignIdentities(listing), undefined);
    const log = vi.fn();
    const sign = vi.fn(async (identity: string) => { if (identity !== "-") throw new Error("errSecInternalComponent"); });
    expect(await codesignWithFallback("Fleet Console Dev", choice, sign, log)).toBe("-");
    expect(sign.mock.calls).toEqual([[DEVELOPMENT], ["-"]]);
    expect(log).toHaveBeenCalledWith('Fleet Console Dev: signing with "Apple Development: Dev One (AAAA111111)" failed; using an ad hoc signature. macOS will not ask for Screen Recording, so add the app with + in System Settings › Privacy & Security.');
    const ok = vi.fn(async () => undefined);
    expect(await codesignWithFallback("Fleet Computer Use helper", choice, ok, log, { advice: false })).toBe(DEVELOPMENT);
    expect(log).toHaveBeenLastCalledWith('Fleet Computer Use helper: signed with "Apple Development: Dev One (AAAA111111)" (set FLEET_DEV_CODESIGN_IDENTITY to choose another identity).');
    expect(describeDevCodesignIdentity("Fleet Console Dev", { identity: "-", label: "ad hoc", reason: "none" }))
      .toBe("Fleet Console Dev: using an ad hoc signature because no Apple Development signing identity was found. macOS will not ask for Screen Recording, so add the app with + in System Settings › Privacy & Security.");
  });
});
