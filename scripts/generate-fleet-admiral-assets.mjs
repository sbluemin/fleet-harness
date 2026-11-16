import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = path.join(repoRoot, "runtime/fleet-console/foundation/agent-runtime");
const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
if (typeof version !== "string" || !version) throw new Error("fleet-harness package version is missing");

// 훅 스크립트는 더 이상 플러그인 zip에 실리지 않는다 — SDK 세션의 hooks 포트가 그 자리를 맡는다.
// 남는 것은 세션 시작에 문맥으로 실을 버전 상수 하나다.
const target = path.join(runtimeRoot, "src/fleet/agent-cli/assets.generated.ts");
const content = `// 이 파일은 scripts/generate-fleet-admiral-assets.mjs가 생성한다. 직접 수정하지 않는다.\n\nexport const FLEET_HARNESS_VERSION = ${JSON.stringify(version)};\n`;
mkdirSync(path.dirname(target), { recursive: true });
if (!existsSync(target) || readFileSync(target, "utf8") !== content) writeFileSync(target, content);
