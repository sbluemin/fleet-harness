import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  base: "/",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
