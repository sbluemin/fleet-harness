import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // tsup은 기본값으로 모든 import 지정자에서 node: 접두를 벗긴다. node:sqlite처럼 접두로만
  // 존재하는 빌트인(usage-scan의 동적 import)은 맨 이름이 해석되지 않아, 이 dist를 인라인하는
  // 호스트 번들(fleet-console 등)이 빌드나 런타임에서 죽는다. 소스가 쓴 지정자를 그대로 내보낸다.
  removeNodeProtocol: false
});
