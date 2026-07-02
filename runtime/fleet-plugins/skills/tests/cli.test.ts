import { describe, expect, it } from "vitest";

import { resolveNpmCommand } from "../server/cli.js";

// ─── resolveNpmCommand — 크로스플랫폼 npm 실행 해석 ─────────────────────────────

describe("resolveNpmCommand", () => {
  it("POSIX(linux)는 npm을 그대로 실행하고 인자를 보존한다", () => {
    const { file, args } = resolveNpmCommand(["install", "skills@1.2.3"], "linux");
    expect(file).toBe("npm");
    expect(args).toEqual(["install", "skills@1.2.3"]);
  });

  it("darwin도 변환하지 않는다", () => {
    const { file, args } = resolveNpmCommand(["install"], "darwin");
    expect(file).toBe("npm");
    expect(args).toEqual(["install"]);
  });

  // Windows에서 npm은 npm.cmd 셸 심 — execFile(shell:false)로 직접 실행 불가.
  // 실제 win32 환경에서만 npm.cmd가 PATH에 존재하므로 해당 플랫폼에서만 실증한다.
  it.runIf(process.platform === "win32")(
    "Windows는 cmd.exe로 npm.cmd 심을 감싸고 원본 인자를 뒤에 붙인다",
    () => {
      const { file, args } = resolveNpmCommand(["install", "pkg"], "win32");
      expect(file.toLowerCase()).toContain("cmd");
      expect(args.slice(0, 4)).toEqual(["/d", "/s", "/c", "call"]);
      expect(args).toContain("install");
      expect(args).toContain("pkg");
    },
  );
});
