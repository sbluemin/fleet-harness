import { defineConfig } from "vite";

// Note: client must NOT import "@dotobokuri/fleet-wiki" (server-only Node API
// transitive deps would break the browser bundle). If isomorphic primitives
// from fleet-wiki are needed, copy the constant or extract a separate
// browser-safe subpath in fleet-wiki first.

export default defineConfig({
  root: "client",
  base: "/",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ["mermaid"],
        },
      },
    },
  },
});
