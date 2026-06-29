import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 식별자 검사 — 생성 단계에서 한 번만 필터링
const JS_IDENTIFIER = /^[A-Za-z_$][0-9A-Za-z_$]*$/u;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const fleetConsoleDir = path.join(repoRoot, "runtime", "fleet-console");
const sdkRoot = path.join(fleetConsoleDir, "sdk");
const outputPath = path.join(
  fleetConsoleDir,
  "core",
  "host",
  "plugin-host",
  "shim-keys.generated.ts",
);

// esbuild은 fleet-console devDependency이므로 fleet-console package 기준 require로 로드한다.
// scripts/ 디렉토리에는 node_modules가 없어 정적 import 불가.
const requireFromConsole = createRequire(path.join(fleetConsoleDir, "package.json"));
const { build } = requireFromConsole("esbuild");

// 7개 specifier → 실제 진입 파일 경로 (null = npm 패키지, 래퍼 방식으로 처리)
const SPECIFIER_ENTRIES = [
  ["react", null],
  ["react/jsx-runtime", null],
  ["@fleet-console/sdk/plugin/browser", path.join(sdkRoot, "plugin", "browser.ts")],
  ["@fleet-console/sdk/settings/browser", path.join(sdkRoot, "settings", "browser.tsx")],
  ["@fleet-console/sdk/operations/browser", path.join(sdkRoot, "operations", "browser.tsx")],
  ["@fleet-console/sdk/notifications/browser", path.join(sdkRoot, "notifications", "browser.ts")],
  ["@fleet-console/sdk/react/browser", path.join(sdkRoot, "react", "browser.tsx")],
];

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-console-shim-keys-"));
try {
  const result = {};
  for (const [specifier, entryFile] of SPECIFIER_ENTRIES) {
    result[specifier] = await extractKeys(specifier, entryFile, tmpDir);
  }
  writeOutput(result);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

async function extractKeys(specifier, entryFile, tmpDir) {
  const safeName = specifier.replace(/[^a-z0-9]/gi, "_");
  const outfile = path.join(tmpDir, `${safeName}.mjs`);

  if (entryFile === null) {
    // CJS npm 패키지(react, react/jsx-runtime): require로 module.exports 직접 획득.
    // ESM dynamic import는 CJS를 { default: module } 로 래핑해 named export가 사라진다.
    // bundler(Vite/esbuild)가 브라우저에서 노출하는 named export = module.exports의 key이므로 여기서도 동일하게 추출한다.
    const mod = requireFromConsole(specifier);
    return Object.keys(mod)
      .filter((key) => key !== "default" && JS_IDENTIFIER.test(key))
      .sort();
  }

  // SDK .ts/.tsx 파일: jsx:automatic으로 esbuild 번들 → 임시 .mjs → dynamic import
  // tmpDir에는 node_modules가 없어 fleet-console node_modules를 nodePaths로 명시한다.
  const consoleNodeModules = path.join(fleetConsoleDir, "node_modules");
  await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    write: true,
    outfile,
    logLevel: "silent",
    nodePaths: [consoleNodeModules],
  });

  const ns = await import(pathToFileURL(outfile).href);
  return Object.keys(ns)
    .filter((key) => key !== "default" && JS_IDENTIFIER.test(key))
    .sort();
}

function writeOutput(keysMap) {
  const entries = Object.entries(keysMap)
    .map(([spec, keys]) => `  ${JSON.stringify(spec)}: [${keys.map((k) => JSON.stringify(k)).join(", ")}] as const,`)
    .join("\n");

  const output = [
    "// AUTO-GENERATED — do not edit. Regenerate: pnpm --filter @dotobokuri/fleet-console generate:shim-keys",
    "",
    "export const SHIM_NAMED_EXPORTS: Readonly<Record<string, readonly string[]>> = {",
    entries,
    "};",
    "",
  ].join("\n");

  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== output) {
    writeFileSync(outputPath, output);
    console.log(`[generate:shim-keys] ${path.relative(repoRoot, outputPath)} 갱신됨`);
  } else {
    console.log(`[generate:shim-keys] 변경 없음 — ${path.relative(repoRoot, outputPath)}`);
  }
}
