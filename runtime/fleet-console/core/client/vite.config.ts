import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const VIRTUAL_FLEET_PLUGINS_ID = "virtual:fleet-plugins";
const RESOLVED_VIRTUAL_FLEET_PLUGINS_ID = `\0${VIRTUAL_FLEET_PLUGINS_ID}`;

// console 자체 HTTP 서버가 /console/ 경로에서 정적 산출물을 서빙하므로 base는 고정 계약이다.
export default defineConfig({
  root: path.resolve(__dirname),
  base: "/console/",
  plugins: [react(), fleetPluginsVirtualModule()],
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
      // SDK source-only 패키지: 비패키지 플러그인(file-explorer)은 심링크 없어 alias 필요
      "@fleet-console/sdk": path.resolve(__dirname, "../../sdk"),
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});

function fleetPluginsVirtualModule(): Plugin {
  return {
    name: "fleet-plugins-virtual-module",
    resolveId(id) {
      return id === VIRTUAL_FLEET_PLUGINS_ID ? RESOLVED_VIRTUAL_FLEET_PLUGINS_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_FLEET_PLUGINS_ID) return null;
      const objectivesClientEntry = path.resolve(__dirname, "../../../fleet-plugins/objectives/client/index.tsx");
      return [
        `import { plugins as objectivesPlugins } from ${JSON.stringify(objectivesClientEntry)};`,
        // 합성 순서가 곧 rail 순서다(코어는 정렬 필드를 두지 않는다). Codex는 코어 내장
        // 패널이던 시절 rail 최상위였고, 플러그인이 되어도 그 자리를 지킨다.
        `export const plugins = [...objectivesPlugins];`,
      ].join("\n");
    },
  };
}
