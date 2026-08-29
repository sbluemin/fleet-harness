import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");

// 빌트인 플러그인 산출물은 매 빌드마다 통째로 다시 만든다.
//
// 낡은 산출물이 남으면 "그 파일이 있는가"라는 검사가 거짓말을 한다 — 엔트리를 빼도 지난
// 빌드의 routes.mjs가 그대로 남아 검사를 통과시키고, 게이트가 결함을 승인한 기록이 된다.
// 이름이 바뀐(diff→codex 등) 플러그인의 유령 디렉터리가 남는 문제도 같은 뿌리다.
// dist/client(vite 산출물)과 dist/cli.*는 건드리지 않는다.
fs.rmSync(path.join(__dirname, "dist", "fleet-plugins"), { recursive: true, force: true });

// dist/client(vite 산출물)을 보존해야 하므로 clean을 끈다 — dist/cli.*만 이 빌드의 소유다.
export default defineConfig([
  {
    entry: { fleet: "cli/fleet-entry.ts", cli: "core/host/cli.ts", "access-protocol": "core/host/access-link.ts", "desktop-protocol": "core/host/desktop-protocol.ts", "fleet-plugins/terminal/routes": "../fleet-plugins/terminal/routes.ts", "fleet-plugins/repository/routes": "../fleet-plugins/repository/routes.ts", "fleet-plugins/file-explorer/routes": "../fleet-plugins/file-explorer/routes.ts", "fleet-plugins/skills/routes": "../fleet-plugins/skills/routes.ts", "fleet-plugins/ledger/routes": "../fleet-plugins/ledger/routes.ts", "fleet-plugins/quota/routes": "../fleet-plugins/quota/routes.ts", "fleet-plugins/scuttlebutt/routes": "../fleet-plugins/scuttlebutt/routes.ts", "fleet-plugins/codex/routes": "../fleet-plugins/codex/routes.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    // 선언(.d.ts)은 패키지가 타입으로 노출하는 cli·access-protocol 엔트리에만 생성한다.
    // 빌트인 플러그인 라우트 번들은 런타임 산출물일 뿐 타입 소비 대상이 아니며,
    // tsconfig include 밖이라 source-only @fleet-console/sdk(.ts) 타입을 DTS 패스에서 해석하지 못한다.
    dts: { entry: { cli: "core/host/cli.ts", "access-protocol": "core/host/access-link.ts" }, resolve: true },
    sourcemap: false,
    clean: false,
    // tsup은 기본값으로 모든 import 지정자에서 node: 접두를 벗긴다. fs·os·path처럼 맨 이름
    // 별칭이 있는 빌트인은 무해하지만, node:sqlite처럼 접두로만 존재하는 빌트인은 맨 이름이
    // 해석되지 않아 산출물이 런타임에 ERR_MODULE_NOT_FOUND로 죽는다. 소스가 쓴 지정자를
    // 그대로 내보낸다(engines가 node>=20.19.0이라 접두는 정적·동적 import 모두 지원된다).
    removeNodeProtocol: false,
    // workspace 패키지(@dotobokuri/*)는 npm에 개별 발행하지 않으므로 번들에 인라인한다.
    // native(node-pty)·동적 require(ws)·font-list의 플랫폼 helper는 정적 분석 대상이 아니라 external로 남으며,
    // publish 스크립트가 published dependencies로 유지한다.
    // @fleet-console source-only 워크스페이스 패키지는 npm publish 시 번들 흡수한다.
    noExternal: [/^@dotobokuri\/core-process(\/|$)/, /^@dotobokuri\//, /^@fleet-console\/(sdk|markdown|font-picker|desktop-protocol|access-protocol)(\/|$)/, "@clack/prompts", /^@clack\//],
    // esbuild는 plugin-host가 외부 플러그인의 .ts/.tsx 엔트리를 번들할 때 동적 import한다 —
    // 게시 설치본도 그 경로에 도달하므로 published dependency다.
    // 번들에 인라인하면 esbuild 내부 CJS의 require("fs")가 ESM 출력에서 boot 시 throw하므로 external로 남긴다.
    external: ["@vscode/ripgrep", "esbuild", "font-list", "node:http"],
    esbuildOptions(options) {
      options.alias = {
        ...options.alias,
        "@dotobokuri/core-agent/claude": path.join(workspaceRoot, "packages/core-agent/src/claude"),
        "@dotobokuri/core-agent": path.join(workspaceRoot, "packages/core-agent/src"),
        "@dotobokuri/core-process": path.join(workspaceRoot, "packages/core-process/src"),
        "@dotobokuri/fleet-admiral": path.join(workspaceRoot, "packages/fleet-admiral/src"),
        "@dotobokuri/fleet-analyst": path.join(workspaceRoot, "packages/fleet-analyst/src"),
        "@dotobokuri/core-infra/data-dir/settings": path.join(workspaceRoot, "packages/core-infra/src/data-dir/settings/store.ts"),
        "@dotobokuri/core-infra/data-dir": path.join(workspaceRoot, "packages/core-infra/src/data-dir/paths.ts"),
        "@dotobokuri/core-infra/workspace-dir": path.join(workspaceRoot, "packages/core-infra/src/workspace-dir/workspace-dir.ts"),
        "@dotobokuri/core-infra": path.join(workspaceRoot, "packages/core-infra/src"),
        "@dotobokuri/fleet-wiki": path.join(workspaceRoot, "packages/fleet-wiki/src"),
      };
    },
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);
