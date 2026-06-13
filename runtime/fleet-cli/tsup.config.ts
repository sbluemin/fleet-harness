import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  format: ["esm"],
  dts: true,
  target: "node20",
  noExternal: [/^@dotobokuri\/(?!fleet-wiki-ui$|fleet-gateway$)/],
  external: ["node-pty", "@dotobokuri/fleet-wiki-ui", "@dotobokuri/fleet-gateway"],
  splitting: false,
  clean: true,
  sourcemap: true
});
