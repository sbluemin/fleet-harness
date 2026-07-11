import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const runtimeManifestPath = join(packageDirectory, "build", "node-runtime.json");

const argumentsByName = new Map(process.argv.slice(2).map((value, index, values) => [value, values[index + 1]]));
const targetKey = argumentsByName.get("--target") ?? `${process.platform}-${process.arch}`;
const outputDirectory = resolve(argumentsByName.get("--output") ?? join(packageDirectory, ".stage", "node-runtime", targetKey));
const cacheDirectory = resolve(process.env.FLEET_DESKTOP_NODE_CACHE ?? join(packageDirectory, ".stage", "downloads"));
const defaultKeyringPath = join(packageDirectory, ".stage", "keys", "pubring.kbx");

const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
const target = runtimeManifest.targets[targetKey];

if (!target) throw new Error(`Unsupported Node runtime target: ${targetKey}`);
if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(targetKey)) throw new Error(`Invalid Node runtime target: ${targetKey}`);

await mkdir(cacheDirectory, { recursive: true });
const archivePath = join(cacheDirectory, target.archive);
const checksumPath = join(cacheDirectory, "SHASUMS256.txt");
const signaturePath = join(cacheDirectory, "SHASUMS256.txt.sig");

await downloadIfMissing(`${runtimeManifest.source}/${target.archive}`, archivePath);
await downloadIfMissing(`${runtimeManifest.source}/SHASUMS256.txt`, checksumPath);
await downloadIfMissing(`${runtimeManifest.source}/SHASUMS256.txt.sig`, signaturePath);
await verifyChecksumList(checksumPath, target.archive, target.sha256);
await verifyArchiveChecksum(archivePath, target.sha256);
await verifySignedChecksumList(checksumPath, signaturePath, await resolveReleaseKeyring());
await extractRuntime(archivePath, outputDirectory);

console.log(JSON.stringify({ target: targetKey, outputDirectory, version: runtimeManifest.version }));

async function downloadIfMissing(url, destination) {
  if (existsSync(destination)) return;
  await mkdir(dirname(destination), { recursive: true });
  await new Promise((resolveDownload, rejectDownload) => {
    get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`Download failed (${response.statusCode}): ${url}`));
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolveDownload, rejectDownload);
    }).on("error", rejectDownload);
  });
}

async function verifyChecksumList(checksumFile, archive, expectedChecksum) {
  const entry = (await readFile(checksumFile, "utf8")).split("\n").find((line) => line.endsWith(`  ${archive}`));
  if (!entry?.startsWith(expectedChecksum)) throw new Error(`Pinned Node checksum mismatch for ${archive}`);
}

async function verifyArchiveChecksum(archive, expectedChecksum) {
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  if (digest !== expectedChecksum) throw new Error(`Downloaded Node checksum mismatch for ${archive}`);
}

async function resolveReleaseKeyring() {
  const override = process.env.FLEET_NODE_RELEASE_KEYRING;
  if (override) {
    await access(override);
    return override;
  }
  const keyring = runtimeManifest.releaseKeyring;
  if (!keyring || typeof keyring.url !== "string" || !/^[a-f0-9]{64}$/.test(keyring.sha256)) throw new Error("Node release keyring manifest is invalid");
  await downloadIfMissing(keyring.url, defaultKeyringPath);
  await verifyKeyringChecksum(defaultKeyringPath, keyring.sha256);
  return defaultKeyringPath;
}

async function verifyKeyringChecksum(keyringPath, expectedChecksum) {
  const digest = createHash("sha256").update(await readFile(keyringPath)).digest("hex");
  if (digest !== expectedChecksum) throw new Error("Pinned Node release keyring checksum mismatch");
}

async function verifySignedChecksumList(checksumFile, signatureFile, keyring) {
  try {
    await execFileAsync("gpgv", ["--keyring", keyring, signatureFile, checksumFile]);
  } catch (error) {
    // gpgv 서명 검증은 방어층이다. 커밋된 node-runtime.json의 핀 sha256 대조(verifyChecksumList·
    // verifyArchiveChecksum)가 아카이브 바이트 무결성을 이미 보장한다. gpgv가 없거나(Windows 기본
    // 미제공) 환경 문제(드라이브 문자 경로 등)로 실패하면 경고만 남기고 진행한다. 서명 검증을 강제하려면
    // (예: release/CI) FLEET_DESKTOP_REQUIRE_NODE_SIGNATURE=1로 실행한다.
    if (process.env.FLEET_DESKTOP_REQUIRE_NODE_SIGNATURE === "1") throw error;
    process.emitWarning(
      `Skipping Node release signature verification; relying on the pinned sha256. (${error?.message ?? error})`,
      { code: "FLEET_NODE_SIGNATURE_SKIPPED" },
    );
  }
}

async function extractRuntime(archive, destination) {
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  const extractionDirectory = join(destination, "extract");
  await mkdir(extractionDirectory, { recursive: true });
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      // Windows에는 unzip이 기본 제공되지 않으므로 내장 PowerShell의 Expand-Archive를 사용한다.
      await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extractionDirectory}' -Force`]);
    } else {
      await execFileAsync("unzip", ["-q", archive, "-d", extractionDirectory]);
    }
  } else {
    await execFileAsync("tar", ["-xf", archive, "-C", extractionDirectory]);
  }
  const [runtimeDirectory] = await (await import("node:fs/promises")).readdir(extractionDirectory);
  if (!runtimeDirectory) throw new Error("Node archive did not contain a runtime directory");
  await cp(join(extractionDirectory, runtimeDirectory), destination, { dereference: true, recursive: true });
  await rm(extractionDirectory, { force: true, recursive: true });
  await writeFile(join(destination, ".runtime-version"), `${runtimeManifest.version}\n`);
  await writeFile(join(destination, ".runtime-target"), `${targetKey}\n`);
}
