import { createRequire } from "node:module";

export type FleetCliChannel = "stable" | "local";

export interface FleetCliRelease {
  readonly channel: FleetCliChannel;
  readonly latestVersion?: string;
  readonly version: string;
}

export function readFleetCliRelease(): FleetCliRelease {
  const requireFromHere = createRequire(import.meta.url);
  const pkg = requireFromHere("../package.json") as { private?: boolean; version?: string };
  const version = pkg.version ?? "";
  // 미게시 워크스페이스 빌드는 package.json의 private:true로 식별해 local 채널로 분류한다.
  // 게시된 빌드는 모두 단일 stable 채널로 통일하며, 별도 prerelease 채널은 운영하지 않는다.
  if (pkg.private === true) {
    return { channel: "local", version };
  }
  return { channel: "stable", version };
}
