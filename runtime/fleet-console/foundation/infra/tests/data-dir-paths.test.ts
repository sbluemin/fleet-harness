import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { getFleetDataDir } from "../src/data-dir/paths.js";

describe("getFleetDataDir", () => {
  it("defaults to the user home root when no override is present", () => {
    expect(getFleetDataDir({})).toBe(path.join(os.homedir(), ".fleet"));
  });

  it("moves the whole root to an absolute FLEET_DATA_DIR", () => {
    expect(getFleetDataDir({ FLEET_DATA_DIR: "/isolated/root" })).toBe("/isolated/root");
  });

  it("treats a blank override as absent rather than as the current directory", () => {
    expect(getFleetDataDir({ FLEET_DATA_DIR: "   " })).toBe(path.join(os.homedir(), ".fleet"));
  });

  // 조용히 홈으로 되돌아가면 격리를 요청한 실행이 사용자의 진짜 루트를 쓰게 된다 — 이 스위치가
  // 막으려던 바로 그 사고다. 자식 프로세스마다 cwd가 달라 상대경로는 애초에 한 자리를 못 가리킨다.
  it("fails loudly on a relative override instead of falling back to the real user root", () => {
    expect(() => getFleetDataDir({ FLEET_DATA_DIR: ".fleet/isolated" })).toThrow(/absolute/);
  });
});
