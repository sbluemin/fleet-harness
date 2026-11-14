import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const source = path.join(desktopDir, "src", "native", "mac-local-auth.mm");
const outDir = path.join(desktopDir, "dist");
const output = path.join(outDir, "mac-local-auth.node");

mkdirSync(outDir, { recursive: true });
const arch = process.env.FLEET_DESKTOP_TARGET === "darwin-x64" ? "x86_64" : process.arch === "x64" ? "x86_64" : "arm64";
execFileSync("/usr/bin/clang++", [
  "-std=c++17",
  "-ObjC++",
  "-fobjc-arc",
  "-O2",
  "-arch",
  arch,
  "-shared",
  "-fPIC",
  "-undefined",
  "dynamic_lookup",
  "-framework",
  "Foundation",
  "-framework",
  "LocalAuthentication",
  source,
  "-o",
  output,
], { stdio: "inherit" });
