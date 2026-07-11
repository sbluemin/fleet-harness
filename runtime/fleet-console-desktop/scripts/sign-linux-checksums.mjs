import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(process.argv[2] ?? join(desktopDirectory, "release"));
const signingKey = process.env.FLEET_LINUX_GPG_KEY;

assertReleaseEnvironment();
if (!signingKey) throw new Error("FLEET_LINUX_GPG_KEY is required to sign Linux release checksums");

const releaseEntries = await readdir(releaseDirectory);
const appImages = releaseEntries.filter((name) => name.endsWith(".AppImage")).sort();
if (appImages.length === 0) throw new Error("No AppImage release artifact found");
const signedArtifacts = appImages;
for (const artifact of signedArtifacts) await access(join(releaseDirectory, artifact));

const checksumLines = await Promise.all(signedArtifacts.map(async (artifact) => {
  const digest = createHash("sha256").update(await readFile(join(releaseDirectory, artifact))).digest("hex");
  return `${digest}  ${artifact}`;
}));
const checksumPath = join(releaseDirectory, "SHA256SUMS");
await writeFile(checksumPath, checksumLines.join("\n").concat("\n"));
await execFileAsync("gpg", ["--batch", "--yes", "--local-user", signingKey, "--armor", "--detach-sign", "--output", `${checksumPath}.asc`, checksumPath]);

console.log(`signed ${signedArtifacts.length} Linux release manifest entries`);

function assertReleaseEnvironment() {
  if (process.env.FLEET_DESKTOP_RELEASE !== "1") throw new Error("FLEET_DESKTOP_RELEASE=1 is required to sign Linux release checksums");
  if (process.env.FLEET_DESKTOP_TARGET !== "linux-x64") throw new Error("FLEET_DESKTOP_TARGET=linux-x64 is required to sign Linux release checksums");
  if (`${process.platform}-${process.arch}` !== "linux-x64") throw new Error("Linux checksums must be signed on a native linux-x64 runner");
}
