import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  format: ["esm"],
  dts: true,
  target: "node20",
  noExternal: [/^@dotobokuri\/core-process(\/|$)/, /^@dotobokuri\/(?!fleet-console$)/],
  external: ["node-pty", "@dotobokuri/fleet-console"],
  splitting: false,
  clean: true,
  sourcemap: true
});
