import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  format: ["esm"],
  dts: true,
  target: "node20",
  noExternal: [/^@dotobokuri\/(?!fleet-wiki-ui$)/],
  external: ["node-pty", "@dotobokuri/fleet-wiki-ui"],
  splitting: false,
  clean: true,
  sourcemap: true
});
