import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextVersion } from "../scripts/set-app-version.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Fleet Mobile app version", () => {
  it("applies the same bump rule the release workflow uses", () => {
    expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(nextVersion("1.9.3", "minor")).toBe("1.10.0");
    expect(() => nextVersion("0.1", "patch")).toThrow(/three-part version/);
    expect(() => nextVersion("0.1.0", "major")).toThrow(/Unknown bump/);
  });

  // versionCode is what App Distribution compares; a non-integer or missing value would make the
  // promoted manifest disagree with the APK and fail the release gate instead of shipping wrong.
  it("declares an integer versionCode alongside the version", () => {
    const app = JSON.parse(readFileSync(path.join(packageRoot, "app.json"), "utf8"));
    expect(Number.isInteger(app.expo.android.versionCode)).toBe(true);
    expect(app.expo.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
