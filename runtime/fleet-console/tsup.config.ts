import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");

// Console 빌드는 dist를 다시 만든다 — 폐기된 산출물을 게시하지 않는다.
export default defineConfig([
  {
    entry: { fleet: "cli/fleet-entry.ts", cli: "core/host/bootstrap/cli.ts", "console-reaper": "foundation/lifecycle/reaper-main.ts", "lifecycle-worker-runtime": "features/updates/host/update-worker-runtime.ts", "access-protocol": "features/remote-access/host/access-link.ts", "desktop-protocol": "core/host/shell/desktop-protocol.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    // 선언(.d.ts)은 패키지가 타입으로 노출하는 cli·access-protocol 엔트리에만 생성한다.
    dts: { entry: { cli: "core/host/bootstrap/cli.ts", "access-protocol": "features/remote-access/host/access-link.ts" }, resolve: true },
    sourcemap: false,
    clean: true,
    // tsup은 기본값으로 모든 import 지정자에서 node: 접두를 벗긴다. fs·os·path처럼 맨 이름
    // 별칭이 있는 빌트인은 무해하지만, node:sqlite처럼 접두로만 존재하는 빌트인은 맨 이름이
    // 해석되지 않아 산출물이 런타임에 ERR_MODULE_NOT_FOUND로 죽는다. 소스가 쓴 지정자를
    // 그대로 내보낸다(engines가 node>=20.19.0이라 접두는 정적·동적 import 모두 지원된다).
    removeNodeProtocol: false,
    // workspace 패키지(@dotobokuri/*)는 npm에 개별 발행하지 않으므로 번들에 인라인한다.
    // native(node-pty, win32에서만 지연 로드하는 koffi)·동적 require(ws)·font-list의 플랫폼 helper는
    // 정적 분석 대상이 아니라 external로 남으며, publish 스크립트가 published dependencies로 유지한다.
    // @fleet-console source-only 워크스페이스 패키지는 게시용 pack 시 번들 흡수한다.
    noExternal: [/^@dotobokuri\//, /^@fleet-console\//, "@clack/prompts", /^@clack\//, /^zod(\/|$)/, /^typebox(\/|$)/],
    external: ["@vscode/ripgrep", "font-list", "node:http"],
    esbuildOptions(options) {
      options.alias = {
        ...options.alias,
        "@fleet-console/agent-runtime/claude": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src/claude"),
        "@fleet-console/agent-runtime": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src"),
        "@fleet-console/ai-gateway": path.join(workspaceRoot, "runtime/fleet-console/features/ai-gateway/runtime/src"),
        "@fleet-console/process": path.join(workspaceRoot, "runtime/fleet-console/foundation/process/src"),
        "@fleet-console/agent-runtime/fleet": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src/fleet"),
        "@fleet-console/infra/data-dir": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src/data-dir/paths.ts"),
        "@fleet-console/infra/workspace-dir": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src/workspace-dir/workspace-dir.ts"),
        "@fleet-console/infra": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src"),
      };
    },
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);
