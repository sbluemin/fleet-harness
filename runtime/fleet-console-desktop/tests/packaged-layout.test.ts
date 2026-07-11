import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .stage는 gitignore된 패키징 산출물 — 클린 체크아웃의 유닛 스위트는 이를 요구하지 않는다.
// 산출물 존재의 엄격 검증은 verify:sidecar / verify:package 파이프라인이 소유한다.
const hasStagedSidecar = fs.existsSync(path.join(desktopRoot, ".stage", "sidecar"));

describe("staged and packaged layout", () => {
  it.skipIf(!hasStagedSidecar)("contains exactly one staged client distribution and a real sidecar Node runtime", () => {
    const staged = path.join(desktopRoot, ".stage", "sidecar", "fleet-console");
    const client = path.join(staged, "dist", "client");
    const node = path.join(desktopRoot, ".stage", "sidecar", "node", process.platform === "win32" ? "node.exe" : "bin/node");
    expect(fs.existsSync(client)).toBe(true);
    expect(fs.existsSync(node)).toBe(true);
    expect(fs.realpathSync(node)).not.toContain("app.asar");
    expect(fs.readdirSync(path.dirname(client)).filter((entry) => entry === "client")).toHaveLength(1);
  });

  it("does not place sidecar resources below app.asar in available unpacked artifacts", () => {
    const release = path.join(desktopRoot, "release");
    const resources = fs.existsSync(release)
      ? fs.readdirSync(release, { recursive: true }).filter((entry): entry is string => typeof entry === "string" && entry.endsWith("Resources/app.asar"))
      : [];
    for (const asar of resources) {
      const resourceRoot = path.dirname(path.join(release, asar));
      expect(fs.existsSync(path.join(resourceRoot, "sidecar", "fleet-console", ".fleet-console-resource-root"))).toBe(true);
      expect(path.join(resourceRoot, "sidecar")).not.toContain("app.asar");
    }
  });
});
