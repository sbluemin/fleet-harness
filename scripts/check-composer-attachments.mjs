import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 컴포저 첨부 SSOT 가드.
 *
 * 브라우저가 `/agent/attachments`를 직접 부르는 곳과, 컴포저 표면이 object URL을 직접 만드는 곳을
 * 허용 목록 밖으로 두지 않는다. 업로드·미리보기는 sdk/composer 스토어와 api.ts 포트만 가진다.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const violations = [];
const clientRoots = [
  "runtime/fleet-console/features",
  "runtime/fleet-console/core/client",
  "runtime/fleet-console/sdk",
  "runtime/fleet-plugins",
];
const composerSurfaces = new Set([
  "composer.tsx",
  "group-composer.tsx",
  "quick-launch.tsx",
  "mobile-quick-launch.tsx",
  "new-session.tsx",
  "commodore-inbox-section.tsx",
  "operation-view-state.ts",
  "chat-dispatch-attachments.tsx",
]);

function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "build", "coverage"].includes(entry.name)) return [];
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function isSkipped(rel) {
  return rel.includes("/tests/") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx") || rel.includes("/host/") || rel.includes("/server/") || rel.endsWith(".d.ts");
}

function allowsAttachmentCall(rel) {
  return rel.startsWith("runtime/fleet-console/sdk/composer/") || rel === "runtime/fleet-console/features/execution/client/agent/api.ts";
}

for (const root of clientRoots) {
  for (const file of files(path.join(repoRoot, root))) {
    if (!/\.(?:ts|tsx)$/.test(file)) continue;
    const rel = relative(file);
    if (isSkipped(rel)) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("/agent/attachments") && !allowsAttachmentCall(rel)) {
      violations.push(`${rel}: calls /agent/attachments outside sdk/composer and agent api.ts`);
    }
    const composerFile = composerSurfaces.has(path.basename(file)) || rel.startsWith("runtime/fleet-console/sdk/composer/");
    if (composerFile && source.includes("createObjectURL") && !rel.startsWith("runtime/fleet-console/sdk/composer/")) {
      violations.push(`${rel}: creates an object URL outside the composer attachment store`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
