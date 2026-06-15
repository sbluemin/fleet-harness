import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const skillRoot = path.join(repoRoot, "packages", "fleet-admiral", "assets", "skills");
const outputPath = path.join(repoRoot, "packages", "fleet-admiral", "src", "agent-cli", "assets.generated.ts");

const assetFiles = listFiles(skillRoot);
const entries = assetFiles
  .map((filePath) => {
    const relativePath = path.relative(skillRoot, filePath).split(path.sep).join("/");
    const content = readFileSync(filePath, "utf8");
    return `  { relativePath: ${JSON.stringify(relativePath)}, content: ${JSON.stringify(content)} },`;
  })
  .join("\n");

const output = `// packages/fleet-admiral/assets/skills asset tree에서 생성된 내장 자산이다.
// 재생성: node scripts/generate-fleet-admiral-assets.mjs

export interface EmbeddedAgentCliAsset {
  readonly content: string;
  readonly relativePath: string;
}

export const EMBEDDED_AGENT_CLI_SKILL_ASSETS: readonly EmbeddedAgentCliAsset[] = [
${entries}
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
