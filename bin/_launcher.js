const { spawn } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function launch({ mode, dev, experimental }) {
  const args = [...getExtensionArgs(dev)];

  args.push(...process.argv.slice(2));

  const env = { ...process.env };

  if (dev) {
    env.FLEET_HARNESS_DEV = "1";
  }

  if (mode === "grand") {
    env.PI_GRAND_FLEET_ROLE = "admiralty";
  }

  if (experimental) {
    env.PI_EXPERIMENTAL = "1";
  }

  const child = spawn("pi", args, {
    env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error("Failed to start pi process:", err);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function getDevExtensionArgs() {
  const extensionEntryPath = path.join(repoRoot, "packages", "fleet-harness-extension", "src", "index.ts");

  return ["-ne", "-e", extensionEntryPath];
}

function getExtensionArgs(dev) {
  if (dev) return getDevExtensionArgs();

  const extensionEntryPath = path.join(repoRoot, "packages", "fleet-harness-extension", "dist", "index.js");

  return ["-ne", "-e", extensionEntryPath];
}

module.exports = {
  launch,
};
