import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const assetRoot = path.join(repoRoot, "packages", "fleet-admiral", "assets");
const skillRoot = path.join(assetRoot, "skills");
const hookRoot = path.join(assetRoot, "hooks");
const outputPath = path.join(repoRoot, "packages", "fleet-admiral", "src", "agent-cli", "assets.generated.ts");

function assetEntries(rootPath) {
  if (!existsSync(rootPath)) return [];
  return listFiles(rootPath).map((filePath) => {
    const relativePath = path.relative(rootPath, filePath).split(path.sep).join("/");
    const content = readFileSync(filePath, "utf8");
    return `  { relativePath: ${JSON.stringify(relativePath)}, content: ${JSON.stringify(content)} },`;
  });
}

const skillEntries = assetEntries(skillRoot).join("\n");
const hookEntries = assetEntries(hookRoot).join("\n");

const output = `// packages/fleet-admiral/assets (skills + hooks) asset tree에서 생성된 내장 자산이다.
// 재생성: node scripts/generate-fleet-admiral-assets.mjs

export interface EmbeddedAgentCliAsset {
  readonly content: string;
  readonly relativePath: string;
}

export const EMBEDDED_AGENT_CLI_SKILL_ASSETS: readonly EmbeddedAgentCliAsset[] = [
${skillEntries}
];

export const EMBEDDED_AGENT_CLI_HOOK_ASSETS: readonly EmbeddedAgentCliAsset[] = [
${hookEntries}
];
`;

mkdirSync(path.dirname(outputPath), { recursive: true });
if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== output) {
  writeFileSync(outputPath, output);
}

function listFiles(rootPath) {
  const files = [];
  collectFiles(rootPath, files);
  return files.sort();
}

function collectFiles(currentPath, files) {
  for (const entry of readdirSync(currentPath)) {
    const entryPath = path.join(currentPath, entry);
    const stat = lstatSync(entryPath);
    if (stat.isDirectory()) {
      collectFiles(entryPath, files);
      continue;
    }
    if (stat.isFile()) {
      files.push(entryPath);
    }
  }
}
