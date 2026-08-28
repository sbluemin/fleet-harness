import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "claude/index": "src/claude/index.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  // `src/claude/vendor-sdk.ts`가 vendor 플랫폼 패키지를 찾으려고 `import.meta.url`을 기준점으로
  // 쓴다. 이 shim이 없으면 esbuild가 CJS 출력에서 `import.meta`를 `{}`로 접어 기준점이 undefined가
  // 되고, 경로 해석이 조용히 실패해 vendor의 비싼 자체 해석으로 되돌아간다.
  shims: true,
  target: "es2022"
});
