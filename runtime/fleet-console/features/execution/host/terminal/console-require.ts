import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type NodeRequire = ReturnType<typeof createRequire>;

const FLEET_CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";

// 네이티브 의존성은 배포된 Console 패키지를 기준으로 해석한다.
export function resolveConsolePackageRequire(currentFile: string, fallback: NodeRequire): NodeRequire {
  return findConsolePackageRequire(currentFile) ?? fallback;
}

function findConsolePackageRequire(currentFile: string): NodeRequire | null {
  // 호스트가 명시로 전달한 패키지 루트가 최우선이다 — 번들 캐시가 durable dir(FLEET_CONSOLE_DIR 추종)에
  // 써지면 번들 위치 기준 조상 탐색은 워크스페이스 밖에서 실패한다(server.ts에서 설정).
  const explicitRoot = process.env.FLEET_CONSOLE_PACKAGE_ROOT;
  if (explicitRoot) {
    const explicitPackageJson = path.join(explicitRoot, "package.json");
    if (isFleetConsolePackage(explicitPackageJson)) return createRequire(explicitPackageJson);
  }
  let dir = path.dirname(currentFile);
  while (true) {
    const packageJson = path.join(dir, "package.json");
    if (isFleetConsolePackage(packageJson)) return createRequire(packageJson);
    const nestedConsolePackage = path.join(dir, "runtime", "fleet-console", "package.json");
    if (isFleetConsolePackage(nestedConsolePackage)) return createRequire(nestedConsolePackage);
    const siblingConsolePackage = path.join(dir, "..", "..", "fleet-console", "package.json");
    if (isFleetConsolePackage(siblingConsolePackage)) return createRequire(siblingConsolePackage);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isFleetConsolePackage(packageJson: string): boolean {
  if (!existsSync(packageJson)) return false;
  try {
    const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { readonly name?: unknown };
    return manifest.name === FLEET_CONSOLE_PACKAGE_NAME;
  } catch {
    return false;
  }
}
