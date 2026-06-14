import { createRequire } from "node:module";
import path from "node:path";

export type FleetConsoleChannel = "stable" | "local";

export interface FleetConsoleRelease {
  readonly channel: FleetConsoleChannel;
  readonly version: string;
  readonly packageRoot: string;
}

export function readFleetConsoleRelease(): FleetConsoleRelease {
  const requireFromHere = createRequire(import.meta.url);
  const packageJsonPath = requireFromHere.resolve("../package.json");
  const pkg = requireFromHere(packageJsonPath) as { private?: boolean; version?: string };
  const packageRoot = path.dirname(packageJsonPath);
  const version = pkg.version ?? "";
  // 미게시 워크스페이스 빌드는 package.json의 private:true로 식별해 local 채널로 분류한다.
  // publish 스크립트가 게시 시 private를 제거하므로 게시본은 stable이 된다(fleet-cli release.ts와 대칭).
  if (pkg.private === true) {
    return { channel: "local", version, packageRoot };
  }
  return { channel: "stable", version, packageRoot };
}
