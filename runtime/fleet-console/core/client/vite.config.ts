import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";


// console 자체 HTTP 서버가 /console/ 경로에서 정적 산출물을 서빙하므로 base는 고정 계약이다.
export default defineConfig({
  root: path.resolve(__dirname),
  base: "/console/",
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      // react-lang의 개발 모드 CDN 자동 로딩은 허용하지 않는다.
      "@openuidev/devtools": path.resolve(__dirname, "openui-devtools-stub.ts"),
      // xterm 패키지는 workspace root에서 단일 인스턴스로 dedup
      "@xterm/addon-fit": path.resolve(__dirname, "../../node_modules/@xterm/addon-fit"),
      "@xterm/addon-unicode11": path.resolve(__dirname, "../../node_modules/@xterm/addon-unicode11"),
      "@xterm/addon-webgl": path.resolve(__dirname, "../../node_modules/@xterm/addon-webgl"),
      "@xterm/xterm": path.resolve(__dirname, "../../node_modules/@xterm/xterm"),
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
