#!/usr/bin/env node
/**
 * Rotate one owned isolated Console's remote identity so a stored fingerprint goes stale.
 * Never prints the lock token or a full fingerprint. Does not disable TLS checks.
 *
 *   node rotate-remote-identity.mjs <absolute-e2e-dir>
 *
 * Stdout is one JSON line {at,rotate,listenerBefore,listenerAfter,fingerprintBefore,
 * fingerprintAfter,devices}. `rotate` is the helper status, not an untrusted-row or
 * recovery proof. Exit 1 on refusal or a non-2xx.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message) {
  process.stderr.write(`rotate-remote-identity: ${message}\n`);
  process.exit(1);
}

function assertE2eDir(dir) {
  if (!dir || !path.isAbsolute(dir)) fail("usage: node rotate-remote-identity.mjs <absolute-e2e-dir>");
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    fail("e2e dir is not readable");
  }
  const homeFleet = path.join(os.homedir(), ".fleet");
  let homeFleetReal = homeFleet;
  try {
    if (fs.existsSync(homeFleet)) homeFleetReal = fs.realpathSync(homeFleet);
  } catch {
    homeFleetReal = homeFleet;
  }
  if (real === homeFleetReal || real.startsWith(homeFleetReal + path.sep)) fail("refusing a path under the user ~/.fleet");
  const base = path.basename(real);
  const parent = path.basename(path.dirname(real));
  if (parent !== ".fleet" || !/^e2e-[A-Za-z0-9._-]+$/.test(base)) fail("path must be an isolated E2E_DIR (<repo>/.fleet/e2e-...)");
  return real;
}

function lockPort(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    const port = Number(lock?.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function userConsolePorts() {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const ports = new Set();
  for (const file of [
    path.join(os.tmpdir(), `fleet-console-${uid}-stable`, "console.lock"),
    path.join(os.homedir(), ".fleet", "console", "console.lock"),
  ]) {
    const port = lockPort(file);
    if (port) ports.add(port);
  }
  return ports;
}

const dir = assertE2eDir(process.argv[2]);
const lockPath = path.join(dir, "console", "console.lock");
let lockReal;
try {
  lockReal = fs.realpathSync(lockPath);
} catch {
  fail("console.lock not readable yet");
}
if (!lockReal.startsWith(dir + path.sep)) fail("refusing a console.lock outside the e2e dir");
let lock;
try {
  lock = JSON.parse(fs.readFileSync(lockReal, "utf8"));
} catch {
  fail("console.lock not readable yet");
}
const port = Number(lock?.port);
if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail("console.lock has no port");
if (typeof lock?.token !== "string" || lock.token.length === 0) fail("console.lock has no token");
if (userConsolePorts().has(port)) fail("refusing the user Console");
const origin = `http://127.0.0.1:${port}`;

const call = async (url, init = {}) => {
  const headers = { Origin: origin, "Content-Type": "application/json", ...(init.headers ?? {}) };
  let res;
  try {
    res = await fetch(url, { ...init, headers });
  } catch {
    fail("request failed");
  }
  if (res.status === 401 || res.status === 403) {
    try {
      res = await fetch(url, { ...init, headers: { ...headers, Authorization: `Bearer ${lock.token}` } });
    } catch {
      fail("request failed");
    }
  }
  return res;
};

const readJson = async (res) => res.json().catch(() => ({}));
const before = await readJson(await call(`${origin}/api/v1/access-links`));
const rotated = await call(`${origin}/api/v1/remote-identity/rotations`, { method: "POST", body: "{}" });
const after = await readJson(await call(`${origin}/api/v1/access-links`));
const fp = (value) => {
  const fingerprint = value?.listener?.fingerprint ?? value?.fingerprint ?? value?.identity?.fingerprint ?? null;
  return typeof fingerprint === "string" && fingerprint.length > 0 ? `${fingerprint.slice(0, 8)}…` : null;
};
console.log(JSON.stringify({
  at: new Date().toISOString(),
  rotate: rotated.status,
  listenerBefore: before?.listener?.origin ?? null,
  listenerAfter: after?.listener?.origin ?? null,
  fingerprintBefore: fp(before),
  fingerprintAfter: fp(after),
  devices: Array.isArray(after?.devices) ? after.devices.length : 0,
}));
if (!rotated.ok) process.exitCode = 1;
