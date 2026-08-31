import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const dataDir = process.env.FLEET_CONSOLE_DATA_DIR;
const pidFile = process.env.FLEET_TEST_CONSOLE_PID_FILE;
const releaseFile = process.env.FLEET_TEST_CONSOLE_RELEASE_FILE;
if (!dataDir || !pidFile || !releaseFile) throw new Error("controlled Console fixture environment is incomplete");

const lockFile = path.join(dataDir, "console.lock");
const token = "controlled-console-token";
let server = null;
let stopping = false;

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");

process.on("SIGTERM", () => { void shutdown(0); });
process.on("SIGINT", () => { void shutdown(0); });

void start().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
});

async function start() {
  while (!fs.existsSync(releaseFile)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url !== "/api/v1/health" && request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      host: "127.0.0.1",
      port: address.port,
      portMode: "dynamic",
      requestedPort: null,
      effectivePort: address.port,
      portHonored: true,
      endpoint: `http://127.0.0.1:${address.port}/`,
      startedAt: 1,
      version: "fixture",
      workspaceCount: 0,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("controlled Console fixture did not bind TCP");
  const payload = {
    pid: process.pid,
    host: "127.0.0.1",
    port: address.port,
    endpoint: `http://127.0.0.1:${address.port}/`,
    startedAt: 1,
    token,
    version: "fixture",
  };
  const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  try {
    const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (current.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {
    // 부모가 pid guard로 정리했거나 아직 lock을 만들지 않은 경우다.
  }
  process.exit(exitCode);
}
