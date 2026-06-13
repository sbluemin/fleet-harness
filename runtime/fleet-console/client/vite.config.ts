import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// gateway가 /console/ 경로에서 임베드 서빙하므로 base는 고정 계약이다.
export default defineConfig({
  root: "client",
  base: "/console/",
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
