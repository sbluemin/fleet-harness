import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");

// dist/client(vite 산출물)을 보존해야 하므로 clean을 끈다 — dist/cli.*만 이 빌드의 소유다.
export default defineConfig([
  {
    entry: { cli: "core/host/cli.ts", "fleet-plugins/terminal/routes": "../fleet-plugins/terminal/routes.ts", "fleet-plugins/diff/routes": "../fleet-plugins/diff/routes.ts", "fleet-plugins/file-explorer/routes": "../fleet-plugins/file-explorer/routes.ts", "fleet-plugins/skills/routes": "../fleet-plugins/skills/routes.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    // 선언(.d.ts)은 패키지가 타입으로 노출하는 cli 엔트리에만 생성한다.
    // 빌트인 플러그인 라우트 번들은 런타임 산출물일 뿐 타입 소비 대상이 아니며,
    // tsconfig include 밖이라 source-only @fleet-console/sdk(.ts) 타입을 DTS 패스에서 해석하지 못한다.
    dts: { entry: { cli: "core/host/cli.ts" } },
    sourcemap: false,
    clean: false,
    // workspace 패키지(@dotobokuri/*)는 npm에 개별 발행하지 않으므로 번들에 인라인한다.
    // native(node-pty)·동적 require(ws)는 정적 분석 대상이 아니라 external로 남으며,
    // publish 스크립트가 이 둘만 dependencies로 유지한다.
    // @fleet-console/markdown(마크다운 SSoT 워크스페이스 패키지)도 npm publish 시 번들 흡수
    noExternal: [/^@dotobokuri\//, /^@fleet-console\/(sdk|markdown)(\/|$)/],
    // esbuild는 plugin-host의 dev .ts 로더에서만 동적 import되는 devDependency다.
    // 번들에 인라인하면 esbuild 내부 CJS의 require("fs")가 ESM 출력에서 boot 시 throw하므로 external로 남긴다.
    external: ["esbuild"],
    esbuildOptions(options) {
      options.alias = {
        ...options.alias,
        "@dotobokuri/core-agent": path.join(workspaceRoot, "packages/core-agent/src"),
        "@dotobokuri/core-unified-agent": path.join(workspaceRoot, "packages/core-unified-agent/src"),
        "@dotobokuri/fleet-admiral": path.join(workspaceRoot, "packages/fleet-admiral/src"),
        "@dotobokuri/fleet-carriers": path.join(workspaceRoot, "packages/fleet-carriers/src"),
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
