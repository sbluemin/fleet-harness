import { describe, expect, it, vi } from "vitest";
import { codesignWithFallback, describeDevCodesignIdentity, designatedRequirementArgs, hasFixedDesignatedRequirement, parseCodesignIdentities, resolveDevCodesignIdentity, selectDevCodesignIdentity, signingEnv } from "../scripts/dev-codesign.mjs";
import { createDevWrapperCodesignArgs, isReusableDevSignature } from "../scripts/launch-dev-desktop.mjs";

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

  it("re-signs ad hoc when signing with the chosen identity fails and says what to do when a rebuild leaves Screen Recording on but denied", async () => {
    const choice = selectDevCodesignIdentity(parseCodesignIdentities(listing), undefined);
    const log = vi.fn();
    const sign = vi.fn(async (identity: string) => { if (identity !== "-") throw new Error("errSecInternalComponent"); });
    expect(await codesignWithFallback("Fleet Console Dev", choice, sign, log, { fixedRequirement: true })).toBe("-");
    expect(sign.mock.calls).toEqual([[DEVELOPMENT], ["-"]]);
    expect(log).toHaveBeenCalledWith('Fleet Console Dev: signing with "Apple Development: Dev One (AAAA111111)" failed; using an ad hoc signature (fixed to bundle ID). If Screen Recording shows Fleet Console Dev as enabled but access is denied after a rebuild, remove its entry with −, request access again in Fleet, and enable it when listed.');
    const ok = vi.fn(async () => undefined);
    expect(await codesignWithFallback("Fleet Computer Use helper", choice, ok, log, { advice: false })).toBe(DEVELOPMENT);
    expect(log).toHaveBeenLastCalledWith('Fleet Computer Use helper: signed with "Apple Development: Dev One (AAAA111111)" (set FLEET_DEV_CODESIGN_IDENTITY to choose another identity).');
    expect(describeDevCodesignIdentity("Fleet Console Dev", { identity: "-", label: "ad hoc", reason: "none" }, false, true, true))
      .toBe("Fleet Console Dev: using an ad hoc signature (fixed to bundle ID) because no Apple Development signing identity was found. If Screen Recording shows Fleet Console Dev as enabled but access is denied after a rebuild, remove its entry with −, request access again in Fleet, and enable it when listed.");
    // 헬퍼는 식별자를 고정하지 않으므로 "fixed to bundle ID"를 붙이지 않는다.
    expect(describeDevCodesignIdentity("Fleet Computer Use helper", { identity: "-", label: "ad hoc", reason: "requested" }, false, false))
      .toBe("Fleet Computer Use helper: using an ad hoc signature because FLEET_DEV_CODESIGN_IDENTITY=-.");
  });

  it("fixes an ad hoc wrapper's designated requirement to the bundle ID and leaves team-signed arguments unchanged", () => {
    const id = "com.dotobokuri.fleet-console.dev";
    expect(designatedRequirementArgs("-", id)).toEqual([`-r=designated => identifier "${id}"`]);
    expect(designatedRequirementArgs(DEVELOPMENT, id)).toEqual([]);
    expect(designatedRequirementArgs("-", undefined)).toEqual([]);
    expect(createDevWrapperCodesignArgs("-", "/stage/Fleet Console Dev.app", "/build/entitlements.mac.plist")).toEqual([
      "--force", "--deep", "--sign", "-", "--timestamp=none", "--identifier", id, `-r=designated => identifier "${id}"`,
      "--entitlements", "/build/entitlements.mac.plist", "/stage/Fleet Console Dev.app"]);
    expect(createDevWrapperCodesignArgs(DEVELOPMENT, "/stage/Fleet Console Dev.app", "/build/entitlements.mac.plist")).toEqual([
      "--force", "--deep", "--sign", DEVELOPMENT, "--timestamp=none", "--identifier", id,
      "--entitlements", "/build/entitlements.mac.plist", "/stage/Fleet Console Dev.app"]);
    // codesign -d -r- 출력: 명시 요구 조건은 그대로, 암묵(cdhash) 요구 조건은 "# "로 시작한다.
    expect(hasFixedDesignatedRequirement(`designated => identifier "${id}"\n`, id)).toBe(true);
    expect(hasFixedDesignatedRequirement('# designated => cdhash H"8b8ed44f570c75733748f4a977afb77d3f15b851"\n', id)).toBe(false);
    expect(hasFixedDesignatedRequirement('designated => identifier "com.example.other"\n', id)).toBe(false);
  });

  it("re-signs a reused ad hoc wrapper only when it lacks the fixed requirement, and judges team-signed wrappers by authority as before", () => {
    const id = "com.dotobokuri.fleet-console.dev";
    const adhoc = { identity: "-", label: "ad hoc", reason: "none" } as const;
    const team = { identity: DEVELOPMENT, label: "Apple Development: Dev One (AAAA111111)", reason: "found" } as const;
    expect(isReusableDevSignature(adhoc, "Identifier=x\nSignature=adhoc\n", `designated => identifier "${id}"\n`)).toBe(true);
    expect(isReusableDevSignature(adhoc, "Identifier=x\nSignature=adhoc\n", '# designated => cdhash H"8b8e"\n')).toBe(false);
    expect(isReusableDevSignature(adhoc, "Authority=Apple Development: Dev One (AAAA111111)\n", `designated => identifier "${id}"\n`)).toBe(false);
    expect(isReusableDevSignature(team, "Authority=Apple Development: Dev One (AAAA111111)\nAuthority=Apple Root CA\n", "")).toBe(true);
    expect(isReusableDevSignature(team, "Signature=adhoc\n", `designated => identifier "${id}"\n`)).toBe(false);
  });
});
