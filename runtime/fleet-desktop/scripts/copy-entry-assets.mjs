import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = join(desktopDirectory, "dist");
const entryDestination = join(distDirectory, "assets", "entry");
const nodeManifestDestination = join(distDirectory, "build", "node-runtime.json");
const iconDestination = join(distDirectory, "build", "icon.png");
const trayTemplateIconDestination = join(distDirectory, "build", "trayTemplate.png");
const trayTemplateIcon2xDestination = join(distDirectory, "build", "trayTemplate@2x.png");

await rm(entryDestination, { force: true, recursive: true });
await mkdir(dirname(nodeManifestDestination), { recursive: true });
await cp(join(desktopDirectory, "assets", "entry"), entryDestination, { recursive: true });
// 진입 화면의 워드마크·본문 글꼴(OFL-1.1). Console과 같은 Fontsource 패키지에서 라틴 가변 글꼴만 옮긴다 —
// 진입 CSP는 font-src 'self'만 열어 두므로 이 폴더 밖의 글꼴은 로드되지 않는다.
const requireFromDesktop = createRequire(join(desktopDirectory, "package.json"));
const fontDestination = join(entryDestination, "fonts");
await mkdir(fontDestination, { recursive: true });
for (const [packageName, fileName] of [["@fontsource-variable/fraunces", "fraunces-latin-wght-normal.woff2"], ["@fontsource-variable/manrope", "manrope-latin-wght-normal.woff2"]]) {
  const packageRoot = dirname(requireFromDesktop.resolve(`${packageName}/package.json`));
  await cp(join(packageRoot, "files", fileName), join(fontDestination, fileName));
  await cp(join(packageRoot, "LICENSE"), join(fontDestination, `${fileName.split("-")[0]}-LICENSE.txt`));
}
await cp(join(desktopDirectory, "build", "node-runtime.json"), nodeManifestDestination);
// 창/트레이 아이콘도 dist 앵커로 동반한다 — packaged에서 resources/ 밖 경로는 존재하지 않는다.
await cp(join(desktopDirectory, "build", "icon.png"), iconDestination);
await cp(join(desktopDirectory, "build", "trayTemplate.png"), trayTemplateIconDestination);
await cp(join(desktopDirectory, "build", "trayTemplate@2x.png"), trayTemplateIcon2xDestination);
