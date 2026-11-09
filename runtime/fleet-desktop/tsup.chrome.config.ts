import { defineConfig } from "tsup";

/** 브라우저 크롬 문서에 main 이 주입하는 프로그램. 메인 번들과 따로(순서대로) 만들어 dist/assets/browser-chrome 에 놓는다. */
export default defineConfig({
  clean: false,
  dts: false,
  entry: { chrome: "src/chrome/doc/index.ts" },
  format: ["iife"],
  minify: false,
  outDir: "dist/assets/browser-chrome",
  outExtension: () => ({ js: ".js" }),
  platform: "browser",
  sourcemap: false,
  splitting: false,
  target: "chrome140",
  tsconfig: "src/chrome/doc/tsconfig.json",
});
