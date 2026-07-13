import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = join(desktopDirectory, "dist");
const entryDestination = join(distDirectory, "assets", "entry");
const pairingDestination = join(distDirectory, "assets", "pairing");
const nodeManifestDestination = join(distDirectory, "build", "node-runtime.json");
const iconDestination = join(distDirectory, "build", "icon.png");

await rm(entryDestination, { force: true, recursive: true });
await rm(pairingDestination, { force: true, recursive: true });
await mkdir(dirname(nodeManifestDestination), { recursive: true });
await cp(join(desktopDirectory, "assets", "entry"), entryDestination, { recursive: true });
await cp(join(desktopDirectory, "assets", "pairing"), pairingDestination, { recursive: true });
await cp(join(desktopDirectory, "build", "node-runtime.json"), nodeManifestDestination);
// 창/트레이 아이콘도 dist 앵커로 동반한다 — packaged에서 resources/ 밖 경로는 존재하지 않는다.
await cp(join(desktopDirectory, "build", "icon.png"), iconDestination);
