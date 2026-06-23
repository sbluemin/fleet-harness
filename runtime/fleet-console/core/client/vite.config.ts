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

function fleetPluginsVirtualModule(): Plugin {
  return {
    name: "fleet-plugins-virtual-module",
    resolveId(id) {
      return id === VIRTUAL_FLEET_PLUGINS_ID ? RESOLVED_VIRTUAL_FLEET_PLUGINS_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_FLEET_PLUGINS_ID) return null;
      const terminalClientEntry = path.resolve(__dirname, "../../../fleet-plugins/terminal/client/index.tsx");
      return [
        `export { plugins, operationKinds, settingsSections, notificationKinds } from ${JSON.stringify(terminalClientEntry)};`,
      ].join("\n");
    },
  };
}
