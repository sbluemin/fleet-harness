#!/usr/bin/env node
/**
 * Store an owned remote Console's one-time link on another owned home Console.
 * Never prints the link or any token. Does not disable TLS checks.
 *
 *   node add-remote-host.mjs <absolute-remote-e2e-dir> <home-origin>
 *
 * <home-origin> is http://127.0.0.1:<port> of the owned home, from that run's lock
 * port only. Stdout is one JSON line {status,id,label,origin,error}. A 2xx is the
 * helper result, not a sidebar or certificate proof. Exit 1 on refusal or a non-2xx.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message) {
  process.stderr.write(`add-remote-host: ${message}\n`);
  process.exit(1);
}

function assertE2eDir(dir) {
  if (!dir || !path.isAbsolute(dir)) fail("usage: node add-remote-host.mjs <absolute-remote-e2e-dir> <home-origin>");
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

function assertHomeOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail("home-origin must be a loopback http origin");
  }
  const host = url.hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    fail("home-origin must be a loopback http origin");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) fail("home-origin must include the loopback port");
  if (userConsolePorts().has(port)) fail("refusing the user Console origin");
  return url.origin;
}

const dir = assertE2eDir(process.argv[2]);
const home = assertHomeOrigin(process.argv[3]);
const linkPath = path.join(dir, "link.txt");
let linkReal;
try {
  linkReal = fs.realpathSync(linkPath);
} catch {
  fail("link.txt is not readable");
}
if (linkReal !== dir && !linkReal.startsWith(dir + path.sep)) fail("refusing a link.txt outside the e2e dir");
let link;
try {
  link = fs.readFileSync(linkReal, "utf8").trim();
} catch {
  fail("link.txt is not readable");
}
if (!link) fail("link.txt is empty");

let res;
try {
  res = await fetch(`${home}/api/v1/remote-hosts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: home },
    body: JSON.stringify({ link }),
  });
} catch {
  fail("home request failed");
}
const body = await res.json().catch(() => ({}));
const picked = body && typeof body === "object" ? body : {};
const host = picked.host && typeof picked.host === "object" ? picked.host : {};
const error = typeof picked.error === "string" && picked.error.length <= 80 && !picked.error.includes(link) ? picked.error : (picked.error == null ? null : "refused");
console.log(JSON.stringify({
  status: res.status,
  id: picked.id ?? host.id ?? null,
  label: picked.label ?? host.label ?? null,
  origin: picked.origin ?? host.origin ?? null,
  error,
}));
if (!res.ok) process.exitCode = 1;
