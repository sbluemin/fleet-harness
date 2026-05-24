import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  format: ["esm"],
  dts: true,
  target: "node20",
  noExternal: [/^@dotobokuri\/fleet-/],
  external: ["node-pty"],
  splitting: false,
  clean: true,
  sourcemap: true
});
