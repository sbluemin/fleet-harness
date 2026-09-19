import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const consoleRoot = path.join(repoRoot, "runtime/fleet-console");
const runtimeRoot = path.join(consoleRoot, "foundation/agent-runtime");
const gatewayRoot = path.join(consoleRoot, "features/ai-gateway/runtime");
const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
if (typeof version !== "string" || !version) throw new Error("fleet-harness package version is missing");

function generate(root, source, output, name, withVersion = false) {
  const entries = listFiles(path.join(root, source)).map((file) => ({
    relativePath: path.relative(path.join(root, source), file).split(path.sep).join("/"),
    content: readFileSync(file, "utf8"),
  }));
  const content = `// ${source}에서 생성한다. 직접 수정하지 않는다.\n// 재생성: node scripts/generate-fleet-admiral-assets.mjs\n\nexport interface EmbeddedAgentCliAsset { readonly content: string; readonly relativePath: string }\n${withVersion ? `export const FLEET_HARNESS_VERSION = ${JSON.stringify(version)};\n` : ""}export const ${name}: readonly EmbeddedAgentCliAsset[] = ${JSON.stringify(entries, null, 2)};\n`;
  const target = path.join(root, output);
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target) || readFileSync(target, "utf8") !== content) writeFileSync(target, content);
}

generate(runtimeRoot, "assets/hooks", "src/fleet/agent-cli/assets.generated.ts", "EMBEDDED_AGENT_CLI_HOOK_ASSETS", true);
generate(gatewayRoot, "assets/ai-gateway", "src/fleet/assets.generated.ts", "EMBEDDED_AI_GATEWAY_ASSETS");

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const child = path.join(root, entry);
    const stat = lstatSync(child);
    if (stat.isDirectory()) files.push(...listFiles(child));
    else if (stat.isFile()) files.push(child);
  }
  return files.sort();
}
