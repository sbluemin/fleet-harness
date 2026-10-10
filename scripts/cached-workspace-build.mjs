#!/usr/bin/env node
/**
 * Builds workspace packages the same way postinstall does, and skips a package whose
 * inputs still match the stamp from its last successful build.
 *
 * The stamp hashes the lockfile plus that package's sources (tests excluded) and the
 * source hashes of its workspace dependencies. Console also hashes plugin sources and
 * the scripts its bundle runs, because those change dist without living in the package.
 * CI restores dist and .cache/build-stamps from an earlier run; a miss still builds
 * only the packages whose hashes moved. A skipped Console build still writes the
 * gitignored shim-key module that cache does not store: later jobs import it from
 * source, and a matching stamp means the generator inputs are unchanged.
 * Set FLEET_WORKSPACE_BUILD_CACHE=0 to build all.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stampDir = path.join(root, ".cache", "build-stamps");
const SKIP_BUILD = new Set(["fleet-harness", "@dotobokuri/fleet-desktop"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", "coverage", "android", "ios", ".expo", ".gradle", "tests", "__tests__"]);

/** Files a package must still have on disk before a matching stamp can skip its build. */
const OUTPUT_MARKERS = {
  "@dotobokuri/fleet-console": ["dist/cli.mjs", "dist/fleet.mjs", "dist/client/index.html", "dist/lifecycle-worker-runtime.mjs"],
  "@fleet-console/agent-runtime": ["dist/index.js", "dist/index.d.ts", "dist/claude/index.js"],
  "@fleet-console/process": ["dist/index.js", "dist/index.d.ts"],
  "@fleet-console/infra": ["dist/index.js", "dist/index.d.ts"],
  "@fleet-console/ai-gateway": ["dist/index.js", "dist/index.d.ts"],
  "@fleet-console/analyst": ["dist/index.js", "dist/index.d.ts"],
  "@dotobokuri/fleet-mobile": ["dist/bundle/metadata.json"],
};

const EXTRA_INPUTS = {
  "@dotobokuri/fleet-console": ["runtime/fleet-plugins", "scripts"],
};

/**
 * Gitignored sources a skipped build must still leave on disk. Dist markers and the
 * workflow cache do not include them, and vitest resolves the `.js` import to the `.ts`.
 */
const GENERATED_WHEN_SKIPPED = {
  "@dotobokuri/fleet-console": [
    {
      marker: "core/host/plugin-host/shim-keys.generated.ts",
      script: "scripts/generate-fleet-console-shim-keys.mjs",
    },
  ],
};

function readWorkspaceDirs() {
  const text = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const dirs = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const match = line.match(/^\s+-\s+"([^"]+)"/);
    if (inPackages && match) dirs.push(match[1]);
  }
  if (dirs.length === 0) throw new Error("pnpm-workspace.yaml listed no packages");
  return dirs;
}

function skipFile(name) {
  return name.endsWith(".tsbuildinfo") || name.endsWith(".test.ts") || name.endsWith(".test.tsx") || name.endsWith(".test.mjs");
}

function collectFiles(directory, files) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(full, files);
    else if (entry.isFile() && !skipFile(entry.name)) files.push(full);
  }
}

function hashFiles(files) {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(path.relative(root, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function workspaceDependencyNames(manifest) {
  const names = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) names.push(name);
    }
  }
  return names.sort();
}

function loadPackages() {
  const byName = new Map();
  for (const dir of readWorkspaceDirs()) {
    const packageDir = path.join(root, dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    byName.set(manifest.name, {
      name: manifest.name,
      dir: packageDir,
      build: typeof manifest.scripts?.build === "string" ? manifest.scripts.build : null,
      deps: workspaceDependencyNames(manifest),
    });
  }
  return byName;
}

function topoOrder(byName) {
  const pending = new Map([...byName].map(([name, pkg]) => [name, pkg.deps.filter((dep) => byName.has(dep))]));
  const ordered = [];
  const done = new Set();
  while (ordered.length < byName.size) {
    const ready = [...pending.keys()].filter((name) => pending.get(name).every((dep) => done.has(dep)));
    if (ready.length === 0) throw new Error(`workspace build dependencies cycled at ${[...pending.keys()].join(", ")}`);
    for (const name of ready.sort()) {
      ordered.push(byName.get(name));
      pending.delete(name);
      done.add(name);
    }
  }
  return ordered;
}

function contentHash(pkg, sharedFiles) {
  const files = [...sharedFiles];
  collectFiles(pkg.dir, files);
  for (const extra of EXTRA_INPUTS[pkg.name] ?? []) collectFiles(path.join(root, extra), files);
  return hashFiles(files);
}

function outputsReady(pkg) {
  const markers = OUTPUT_MARKERS[pkg.name] ?? [];
  return markers.every((marker) => fs.existsSync(path.join(pkg.dir, marker)));
}

function readStamp(name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stampDir, `${encodeURIComponent(name)}.json`), "utf8"));
    return typeof parsed.hash === "string" ? parsed.hash : null;
  } catch {
    return null;
  }
}

function writeStamp(name, hash) {
  fs.mkdirSync(stampDir, { recursive: true });
  fs.writeFileSync(path.join(stampDir, `${encodeURIComponent(name)}.json`), `${JSON.stringify({ name, hash })}\n`);
}

function ensureGeneratedSources(pkg) {
  for (const generated of GENERATED_WHEN_SKIPPED[pkg.name] ?? []) {
    const marker = path.join(pkg.dir, generated.marker);
    if (fs.existsSync(marker)) continue;
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(root, generated.script)], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
    if (!fs.existsSync(marker)) {
      throw new Error(`${pkg.name} skipped its build but ${generated.script} did not write ${generated.marker}`);
    }
    console.log(`cached-workspace-build: generated ${generated.marker} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

function buildPackage(pkg) {
  const started = Date.now();
  // pnpm/action-setup puts pnpm.cmd on PATH on Windows. Node refuses to spawn a
  // .cmd shim unless the shell runs it, and the Windows verify install uses this path.
  const result = spawnSync("pnpm", ["--filter", pkg.name, "run", "build"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log(`cached-workspace-build: built ${pkg.name} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

function main() {
  const force = process.env.FLEET_WORKSPACE_BUILD_CACHE === "0";
  const byName = loadPackages();
  const ordered = topoOrder(byName);
  const sharedFiles = [];
  for (const relative of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"]) sharedFiles.push(path.join(root, relative));
  collectFiles(path.join(root, "patches"), sharedFiles);

  const ownHash = new Map(ordered.map((pkg) => [pkg.name, contentHash(pkg, sharedFiles)]));
  const inputHash = new Map();
  for (const pkg of ordered) {
    const hash = crypto.createHash("sha256");
    hash.update(ownHash.get(pkg.name));
    for (const dep of pkg.deps) {
      if (!inputHash.has(dep)) continue;
      hash.update(dep);
      hash.update("\0");
      hash.update(inputHash.get(dep));
    }
    inputHash.set(pkg.name, hash.digest("hex"));
  }

  const built = [];
  const skipped = [];
  for (const pkg of ordered) {
    if (!pkg.build || SKIP_BUILD.has(pkg.name)) continue;
    const hash = inputHash.get(pkg.name);
    if (!force && readStamp(pkg.name) === hash && outputsReady(pkg)) {
      ensureGeneratedSources(pkg);
      skipped.push(pkg.name);
      continue;
    }
    buildPackage(pkg);
    if (!outputsReady(pkg)) {
      throw new Error(`${pkg.name} built without ${OUTPUT_MARKERS[pkg.name].join(", ")}`);
    }
    writeStamp(pkg.name, hash);
    built.push(pkg.name);
  }
  console.log(`cached-workspace-build: built ${built.length} [${built.join(", ")}], skipped ${skipped.length} [${skipped.join(", ")}]`);
}

main();
